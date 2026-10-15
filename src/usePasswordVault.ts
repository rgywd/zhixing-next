import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { VaultController, type VaultPorts } from "./vaultController";
import { clearVaultClipboard, copyVaultValue, createVaultKey, generateVaultPassword, isVaultSupported, parseVaultEnvelope, readVaultRaw, sealVault, unlockVault, writeVaultRaw } from "./vaultCrypto";
import { acquireVaultPrivacy, releaseVaultPrivacy } from "./vaultPrivacy";

const ports: VaultPorts = {
  supported: isVaultSupported, readRaw: readVaultRaw, writeRaw: writeVaultRaw, parse: parseVaultEnvelope,
  createKey: createVaultKey, unlock: unlockVault, seal: sealVault, copy: copyVaultValue, clearClipboard: clearVaultClipboard, generate: generateVaultPassword,
  id: randomUUID, now: Date.now, later: (action, ms) => setTimeout(action, ms), cancel: clearTimeout,
};

export function usePasswordVault() {
  const [controller] = useState(() => new VaultController(ports));
  const [privacy, setPrivacy] = useState({ ready: false, error: "" });
  const retryPrivacy = useRef<() => void>(() => {});
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.activate();
    let active = true, settingUp = false;
    const key = `zhixing-vault-${randomUUID()}`;
    async function start() {
      if (settingUp || !active) return;
      settingUp = true;
      try {
        if (!isVaultSupported()) { if (active) { setPrivacy({ ready: true, error: "" }); await controller.start(); } return; }
        await acquireVaultPrivacy(key);
        if (!active) return;
        setPrivacy({ ready: true, error: "" });
        await controller.start();
      } catch { if (active) setPrivacy({ ready: false, error: "无法启用密码库隐私保护，请重试。" }); }
      finally { settingUp = false; }
    }
    retryPrivacy.current = () => { controller.lock(); void start(); };
    const subscription = AppState.addEventListener("change", (value) => {
      if (value !== "active") controller.lockInBackground();
      else void clearVaultClipboard().catch(() => undefined);
    });
    void start();
    return () => {
      active = false; retryPrivacy.current = () => {}; controller.dispose(); subscription.remove();
      void releaseVaultPrivacy(key).catch(() => undefined);
    };
  }, [controller]);
  return {
    ...state,
    ...(!privacy.ready ? { status: privacy.error ? "error" as const : "loading" as const, error: privacy.error } : {}),
    create: controller.create, unlock: controller.unlock, beginEdit: controller.beginEdit, updateDraft: controller.updateDraft,
    save: controller.save, discardDraft: controller.discardDraft, removeEntry: controller.removeEntry, changeMaster: controller.changeMaster,
    lock: controller.lock, touch: controller.touch, copy: controller.copy, generate: controller.generate,
    retry: () => retryPrivacy.current(),
  };
}
