import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import type { DraftPhoto } from "./api";
import { discardDraftPhotos, keepDraftPhoto } from "./chatPhotos";
import { humanError } from "./ui";

export function usePhotoPicker({ scope, ids, locked, add, onError, maxAttachments = 8 }: {
  scope: string; ids: string[]; locked: boolean; maxAttachments?: number | null;
  add: (photos: DraftPhoto[]) => Promise<void>; onError: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const working = useRef(false);
  const alive = useRef(true);
  const current = useRef({ scope, ids, locked, add, onError, maxAttachments });
  useEffect(() => { current.current = { scope, ids, locked, add, onError, maxAttachments }; }, [scope, ids, locked, add, onError, maxAttachments]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function pick() {
    const source = current.current;
    if (!alive.current || working.current || source.locked) return;
    const remaining = source.maxAttachments === null ? undefined : source.maxAttachments - new Set(source.ids).size;
    if (remaining !== undefined && remaining <= 0) { source.onError("每条消息最多 8 份附件，请先移除一份。"); return; }
    working.current = true; setPicking(true);
    const valid = () => alive.current && current.current.scope === source.scope && !current.current.locked;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: remaining,
        orderedSelection: true, allowsEditing: false, quality: 1,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (result.canceled || !valid()) return;
      if (source.maxAttachments !== null && result.assets.length + new Set(current.current.ids).size > source.maxAttachments) throw new Error("每条消息最多 8 份附件，请减少照片后重新选择。");
      const photos: DraftPhoto[] = [], errors: string[] = [];
      for (const asset of result.assets) {
        try { photos.push(await keepDraftPhoto(asset, Crypto.randomUUID())); }
        catch (e) { errors.push(humanError(e)); }
      }
      if (!valid()) { discardDraftPhotos(photos); return; }
      if (photos.length) await current.current.add(photos);
      if (errors.length) current.current.onError(`${errors.length} 张照片未能加入，其他照片已保留。${errors[0]}`);
    } catch (e) { if (valid()) current.current.onError(humanError(e)); }
    finally { working.current = false; if (alive.current) setPicking(false); }
  }
  return { pick, picking };
}
