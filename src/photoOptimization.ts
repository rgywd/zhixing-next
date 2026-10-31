import { Platform } from "react-native";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { safeDownloadName } from "./api";

type PhotoSource = { uri: string; name: string; width: number; height: number };
export type PreparedPhoto = { uri: string; name: string; size: number };
const KiB = 1024;
const supported = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const suffixOf = (name: string) => name.split(/[?#]/, 1)[0].match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const uint32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

// Inspect only headers, without copying a large image into the JS heap. Old DSH
// drafts have extensionless URIs; the picker can also give JPEG bytes a HEIC name.
function inspectPhoto(file: File, photo: PhotoSource) {
  const handle = file.open();
  try {
    const head = handle.readBytes(Math.min(file.size, 32));
    let suffix = suffixOf(photo.uri) ?? suffixOf(photo.name);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) suffix = "jpg";
    else if (ascii(head, 0, 3) === "GIF") suffix = "gif";
    else if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") suffix = "webp";
    else if (head[0] === 137 && ascii(head, 1, 4) === "PNG" && head.length >= 29) {
      // Preserve animation, high bit depth and embedded color profiles. A PNG
      // with unrecognized/very large metadata is safer to send unchanged.
      const width = uint32(head, 16), height = uint32(head, 20);
      if (head[24] > 8 || !width || !height || Math.max(width, height) > 16383) return { suffix: "png", losslessPng: false };
      let offset = 8;
      for (let chunks = 0; chunks < 128 && offset < 256 * KiB && offset + 12 <= file.size; chunks++) {
        handle.offset = offset;
        const chunk = handle.readBytes(8);
        if (chunk.length !== 8) break;
        const kind = ascii(chunk, 4, 8), length = uint32(chunk, 0);
        if (offset + length + 12 > file.size) break;
        if (kind === "acTL" || kind === "iCCP") break;
        if (kind === "IDAT") return { suffix: "png", losslessPng: true };
        offset += length + 12;
      }
      return { suffix: "png", losslessPng: false };
    }
    return { suffix, losslessPng: false };
  } finally { handle.close(); }
}

/** Prepare transport bytes at the original resolution; never chase a byte quota by shrinking text. */
export async function optimizePhoto(photo: PhotoSource): Promise<PreparedPhoto> {
  const original = new File(photo.uri);
  const size = original.size;
  if (!size) throw new Error("照片暂时无法读取，请重新选择。");
  const info = inspectPhoto(original, photo);
  const base = safeDownloadName(photo.name).replace(/\.[^.]+$/, "");
  const unchanged = { uri: photo.uri, name: `${base}.${info.suffix ?? "image"}`, size };
  const compatible = supported.has(info.suffix ?? "");
  // WebP/GIF may be animated and are already compressed. Small files do not
  // warrant another encode. PNG gets lossless WebP only where Expo guarantees it:
  // Android's Bitmap.CompressFormat.WEBP at quality 100 is lossless from API 29.
  const png = info.suffix === "png";
  if ((compatible && size <= 512 * KiB) || info.suffix === "gif" || info.suffix === "webp") return unchanged;
  if (png && (!info.losslessPng || Platform.OS !== "android" || Number(Platform.Version) < 29)) return unchanged;

  const context = ImageManipulator.manipulate(photo.uri);
  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  let candidate: File | undefined;
  let keepCandidate = false;
  try {
    rendered = await context.renderAsync();
    const screenshot = /screenshot|screen[ _-]?shot|截[图屏]|屏幕快照/i.test(photo.name)
      || Math.max(rendered.width, rendered.height) / Math.min(rendered.width, rendered.height) >= 2;
    let result = await rendered.saveAsync({ format: png ? SaveFormat.WEBP : SaveFormat.JPEG,
      compress: png ? 1 : screenshot ? 0.95 : 0.9 });
    candidate = new File(result.uri);
    if (!candidate.size) throw new Error("照片处理失败，请重新选择。");
    const worthwhile = (bytes: number) => size - bytes >= Math.max(64 * KiB, size * 0.1);
    if (png && !worthwhile(candidate.size)) {
      // Some screenshots already have very efficient PNG encoding. Try one
      // high-quality WebP from the SAME decoded original, preserving dimensions
      // and alpha; never lower quality repeatedly to chase a target file size.
      try { candidate.delete(); } catch { /* Cache cleanup can retry. */ }
      result = await rendered.saveAsync({ format: SaveFormat.WEBP, compress: 0.98 });
      candidate = new File(result.uri);
      if (!candidate.size) throw new Error("照片处理失败，请重新选择。");
    }
    // Re-encoding an already efficient JPEG/PNG can make it bigger. Require a
    // useful saving before replacing supported source bytes.
    if (compatible && !worthwhile(candidate.size)) return unchanged;
    keepCandidate = true;
    return { uri: result.uri, name: `${base}.${png ? "webp" : "jpg"}`, size: candidate.size };
  } catch (error) {
    if (compatible) return unchanged;
    throw error;
  } finally {
    rendered?.release();
    context.release();
    if (!keepCandidate && candidate) { try { candidate.delete(); } catch { /* Cache cleanup can retry. */ } }
  }
}

/** Keep the chosen bytes alongside the original draft so restarts/retries never re-encode them. */
export async function preparePhotoCopy(photo: PhotoSource): Promise<PreparedPhoto> {
  const result = await optimizePhoto(photo);
  if (result.uri === photo.uri) return result;
  const temporary = new File(result.uri);
  const copy = new File(new File(photo.uri).parentDirectory, `prepared.${suffixOf(result.name)}`);
  try {
    if (copy.exists) copy.delete();
    await temporary.copy(copy);
    if (copy.size !== result.size) throw new Error("照片保存失败，请重试。");
    return { ...result, uri: copy.uri };
  } finally { try { temporary.delete(); } catch { /* Cache cleanup can retry. */ } }
}
