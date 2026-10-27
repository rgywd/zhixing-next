import { Directory, File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import type { ImagePickerAsset } from "expo-image-picker";
import { fileUploadRequest, type Connection, type DraftPhoto, type Resource } from "./api";
import { preparePhoto } from "./photoUploads";

const photoDirectory = () => new Directory(Paths.document, "chat-photos");

// Keep an app-owned copy so an unsent photo survives a restart or picker cache cleanup.
export async function keepDraftPhoto(asset: ImagePickerAsset, id: string): Promise<DraftPhoto> {
  const directory = new Directory(photoDirectory(), id);
  directory.create({ intermediates: true, idempotent: true });
  const suffix = asset.uri.split(/[?#]/, 1)[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "image";
  const local = new File(directory, `original.${suffix}`);
  try { await new File(asset.uri).copy(local); }
  catch (error) { if (directory.exists) directory.delete(); throw error; }
  if (!local.size) { directory.delete(); throw new Error("照片暂时无法读取，请重新选择。"); }
  return { id, uri: local.uri, name: asset.fileName || `照片.${suffix}`, width: asset.width, height: asset.height };
}

export function discardDraftPhotos(photos: DraftPhoto[]) {
  for (const photo of photos) {
    // Only remove our private copy, never an original photo or an arbitrary stored URI.
    if (!/^[a-zA-Z0-9-]+$/.test(photo.id)) continue;
    const directory = new Directory(photoDirectory(), photo.id);
    if (!photo.uri.startsWith(`${directory.uri.replace(/\/$/, "")}/`)) continue;
    try { if (directory.exists) directory.delete(); } catch { /* A later OS cleanup can reclaim a failed deletion. */ }
  }
}

export async function sendDraftPhoto(
  connection: Connection, conversationId: string, photo: DraftPhoto,
  save: (photo: DraftPhoto) => Promise<void>, signal: AbortSignal,
): Promise<DraftPhoto> {
  const check = () => { if (signal.aborted) throw new Error("照片发送已中断，草稿已保留。"); };
  check();
  if (photo.resource) return photo;
  let prepared = photo.prepared;
  if (!prepared) {
    const result = await preparePhoto({ uri: photo.uri, fileName: photo.name, width: photo.width, height: photo.height }, photo.name);
    check();
    if (result.uri !== photo.uri) {
      const copy = new File(photoDirectory(), photo.id, "prepared.jpg");
      if (copy.exists) copy.delete();
      await new File(result.uri).copy(copy);
      check();
      prepared = { uri: copy.uri, name: result.name, size: result.size };
    } else prepared = { uri: result.uri, name: result.name, size: result.size };
    photo = { ...photo, prepared, error: undefined };
    // Persist converted bytes before PUT, so retries use the same ID and exact file.
    await save(photo);
  }
  check();
  const options = await fileUploadRequest(connection, new File(prepared.uri));
  check();
  const response = await expoFetch(
    `${connection.url}/v1/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(photo.id)}?filename=${encodeURIComponent(prepared.name)}`,
    { ...options, signal },
  );
  const data = await response.json();
  check();
  if (!response.ok) throw new Error(data.error?.message ?? "照片发送失败，请重试。");
  const resource = data as Resource;
  if (resource.id !== photo.id || resource.conversation_id !== conversationId || !resource.mime_type.startsWith("image/"))
    throw new Error("照片接收结果不匹配，请重试发送。");
  photo = { ...photo, resource, error: undefined };
  await save(photo);
  return photo;
}
