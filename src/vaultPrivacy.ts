import { Platform } from "react-native";
import * as ScreenCapture from "expo-screen-capture";

// Serialize acquire/release so a late unmount cannot disable a newer vault's guard.
const owners = new Set<string>();
let work: Promise<void> = Promise.resolve();
function queue(action: () => Promise<void>) {
  const result = work.catch(() => undefined).then(action);
  work = result; return result;
}
export function acquireVaultPrivacy(key: string): Promise<void> {
  return queue(async () => {
    if (owners.has(key)) return;
    try {
      await ScreenCapture.preventScreenCaptureAsync(key);
      if (Platform.OS === "ios") await ScreenCapture.enableAppSwitcherProtectionAsync();
      owners.add(key);
    } catch {
      await ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
      throw new Error("无法启用密码库隐私保护，请重试。");
    }
  });
}
export function releaseVaultPrivacy(key: string): Promise<void> {
  return queue(async () => {
    owners.delete(key);
    try {
      await ScreenCapture.allowScreenCaptureAsync(key);
      if (Platform.OS === "ios" && !owners.size) await ScreenCapture.disableAppSwitcherProtectionAsync();
    } catch { throw new Error("无法结束密码库隐私保护，请重试。"); }
  });
}
