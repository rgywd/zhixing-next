import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import { MAX_FILE_BYTES, safeDownloadName } from "./api";

const supported = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const extension = (name: string) => name.split(/[?#]/, 1)[0].match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();

// The picker can return a JPEG cache file with the original HEIC filename.
// Name the uploaded bytes correctly so the server treats them as an image.
export async function preparePhoto(asset: ImagePickerAsset, fallbackName: string) {
  let uri = asset.uri;
  let suffix = extension(uri) ?? extension(asset.fileName ?? "");
  const originalSize = new File(uri).size;
  if (!suffix || !supported.has(suffix) || asset.width * asset.height > 24_000_000 || originalSize > MAX_FILE_BYTES) {
    const context = ImageManipulator.manipulate(uri);
    let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
    try {
      // Bound high-resolution camera images to the existing server pixel limit.
      if ((asset.width * asset.height > 24_000_000 || originalSize > MAX_FILE_BYTES) && Math.max(asset.width, asset.height) > 4096) {
        context.resize(asset.width >= asset.height ? { width: 4096 } : { height: 4096 });
      }
      rendered = await context.renderAsync();
      uri = (await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.95 })).uri;
      suffix = "jpg";
    } finally {
      rendered?.release();
      context.release();
    }
  }
  const size = new File(uri).size;
  if (!size) throw new Error("照片暂时无法读取，请重新选择。");
  if (size > MAX_FILE_BYTES) throw new Error("照片超过 20 MiB，请选择较小的照片。");
  const base = safeDownloadName(asset.fileName || fallbackName).replace(/\.[^.]+$/, "");
  return { uri, name: `${base}.${suffix}`, size, image: true };
}
