import { requireOptionalNativeModule } from "expo";
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, getRandomBytesAsync } from "expo-crypto";
import { decodeVaultPayload, type VaultPayload } from "./vaultTypes";

export type VaultKey = AESEncryptionKey;
export type VaultEnvelope = { version: 1; kdf: "pbkdf2-sha256"; iterations: 600000; salt: string; sealed: string };
type VaultNative = {
  isSupported(): boolean;
  deriveKey(master: string, salt: string): Promise<string>;
  copyValue(value: string): Promise<void>;
  clearClipboard(): Promise<void>;
  readVaultRaw(): Promise<string | null>;
  writeVaultRaw(raw: string, expectedRaw: string | null): Promise<void>;
};
const native = requireOptionalNativeModule<VaultNative>("ZhixingVault");
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const invalid = () => new Error("密码库文件无法读取，原加密文件已保留。");
const saltValid = (salt: string) => /^[0-9a-f]{32}$/.test(salt);

export function isVaultSupported(): boolean {
  try { return native?.isSupported() === true; } catch { return false; }
}
function platform(): VaultNative {
  if (!native || !isVaultSupported()) throw new Error("密码管理需要 Android 8.0 或更新版本，且须安装支持密码库的原生 App。");
  return native;
}
function masterValid(master: string) {
  if (typeof master !== "string" || master.length < 12 || master.length > 1024) throw new Error("主密码需为 12 至 1024 个字符。");
  for (let i = 0; i < master.length; i++) {
    const unit = master.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = master.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("主密码包含无效字符。");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("主密码包含无效字符。");
  }
}
function utf8(value: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);
  // URI encoding is a standards-based fallback for native runtimes lacking TextEncoder.
  const encoded = encodeURIComponent(value), bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  return new Uint8Array(bytes);
}
function text(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let encoded = "";
  for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, "0")}`;
  return decodeURIComponent(encoded);
}
function aad(salt: string): Uint8Array { return utf8(JSON.stringify({ version: 1, kdf: "pbkdf2-sha256", iterations: 600000, salt })); }
function base64Valid(value: string): boolean {
  if (!value.length || value.length % 4) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let i = 0; i < value.length - padding; i++) if (alphabet.indexOf(value[i]) < 0) return false;
  if (padding === 2 && (alphabet.indexOf(value.at(-3)!) & 15) || padding === 1 && (alphabet.indexOf(value.at(-2)!) & 3)) return false;
  return value.length / 4 * 3 - padding >= 29;
}
function base64Bytes(value: string): Uint8Array {
  // Called only after canonical Base64 validation. Expo 57's Android
  // fromCombined bridge requires Uint8Array despite the public string type.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - padding);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]), b = alphabet.indexOf(value[i + 1]);
    const c = value[i + 2] === "=" ? 0 : alphabet.indexOf(value[i + 2]);
    const d = value[i + 3] === "=" ? 0 : alphabet.indexOf(value[i + 3]);
    const combined = a << 18 | b << 12 | c << 6 | d;
    bytes[offset++] = combined >>> 16 & 255;
    if (offset < bytes.length) bytes[offset++] = combined >>> 8 & 255;
    if (offset < bytes.length) bytes[offset++] = combined & 255;
  }
  return bytes;
}
export function parseVaultEnvelope(raw: string): VaultEnvelope {
  try {
    if (typeof raw !== "string" || raw.length > MAX_RAW_BYTES || utf8(raw).length > MAX_RAW_BYTES) throw invalid();
    const value = JSON.parse(raw) as VaultEnvelope;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "iterations,kdf,salt,sealed,version" || value.version !== 1 || value.kdf !== "pbkdf2-sha256" || value.iterations !== 600000 || typeof value.salt !== "string" || !saltValid(value.salt) || typeof value.sealed !== "string" || !base64Valid(value.sealed)) throw invalid();
    return value;
  } catch { throw invalid(); }
}
async function derive(master: string, salt: string): Promise<VaultKey> {
  masterValid(master);
  const hex = await platform().deriveKey(master, salt);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("主密码密钥尚未生成，请重试。");
  return AESEncryptionKey.import(hex, "hex");
}
export async function createVaultKey(master: string): Promise<{ key: VaultKey; salt: string }> {
  masterValid(master); platform();
  const salt = Array.from(await getRandomBytesAsync(16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key: await derive(master, salt), salt };
}
export async function sealVault(payload: VaultPayload, key: VaultKey, salt: string): Promise<VaultEnvelope> {
  platform();
  if (!saltValid(salt) || key.size !== 256) throw invalid();
  const source = JSON.stringify(payload);
  decodeVaultPayload(source);
  const bytes = utf8(source);
  if (bytes.length > Math.floor((MAX_RAW_BYTES - 256) * 3 / 4)) throw new Error("密码库内容过多，尚未保存。");
  try {
    const sealed = await aesEncryptAsync(bytes, key, { nonce: { length: 12 }, tagLength: 16, additionalData: aad(salt) });
    return parseVaultEnvelope(JSON.stringify({ version: 1, kdf: "pbkdf2-sha256", iterations: 600000, salt, sealed: await sealed.combined("base64") }));
  } finally { bytes.fill(0); }
}
export async function unlockVault(envelope: VaultEnvelope, master: string): Promise<{ key: VaultKey; payload: VaultPayload }> {
  const verified = parseVaultEnvelope(JSON.stringify(envelope));
  const key = await derive(master, verified.salt);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await aesDecryptAsync(AESSealedData.fromCombined(base64Bytes(verified.sealed), { ivLength: 12, tagLength: 16 }), key, { additionalData: aad(verified.salt) });
    return { key, payload: decodeVaultPayload(text(bytes)) };
  } catch { throw new Error("主密码不正确，或密码库内容已损坏；原加密文件已保留。"); }
  finally { bytes?.fill(0); }
}
export async function generateVaultPassword(): Promise<string> {
  platform();
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";
  const limit = Math.floor(256 / chars.length) * chars.length;
  let password = "";
  while (password.length < 20) {
    for (const byte of await getRandomBytesAsync(32)) {
      if (byte < limit) password += chars[byte % chars.length];
      if (password.length === 20) break;
    }
  }
  return password;
}
export async function copyVaultValue(value: string): Promise<void> { await platform().copyValue(value); }
export async function clearVaultClipboard(): Promise<void> { await platform().clearClipboard(); }
export async function readVaultRaw(): Promise<string | null> {
  const raw = await platform().readVaultRaw();
  if (raw !== null) parseVaultEnvelope(raw);
  return raw;
}
export async function writeVaultRaw(raw: string, expectedRaw: string | null): Promise<void> {
  parseVaultEnvelope(raw); if (expectedRaw !== null) parseVaultEnvelope(expectedRaw);
  await platform().writeVaultRaw(raw, expectedRaw);
}
