export type VaultQuestion = { id: string; question: string; answer: string };
export type VaultField = { id: string; label: string; value: string; secret: boolean };
export type VaultInput = {
  site: string; account: string; password: string; recoveryEmail: string; phone: string;
  questions: VaultQuestion[]; fields: VaultField[]; notes: string;
};
export type VaultEntry = VaultInput & { id: string; createdAt: string; updatedAt: string };
export type VaultDraft = { entryId: string | null; input: VaultInput };
export type VaultPayload = { version: 1; entries: VaultEntry[]; draft: VaultDraft | null };
export const emptyVaultInput = (): VaultInput => ({ site: "", account: "", password: "", recoveryEmail: "", phone: "", questions: [], fields: [], notes: "" });

export function validateVaultDraftInput(input: VaultInput): void {
  if (!inputShape(input)) throw new Error("编辑内容格式无法读取。");
  if ([input.site, input.account, input.recoveryEmail, input.phone].some((value) => value.length > 2000) || input.password.length > 20000 || input.notes.length > 20000) throw new Error("部分内容过长，请精简后再保存。");
  if (input.questions.length > 30 || input.fields.length > 30) throw new Error("每条记录最多保存 30 个密保问题和 30 个自定义字段。");
  if (input.questions.some((item) => item.question.length > 2000 || item.answer.length > 20000) || input.fields.some((item) => item.label.length > 2000 || item.value.length > 20000)) throw new Error("部分附加内容过长，请精简后再保存。");
  for (const items of [input.questions, input.fields]) {
    if (items.some((item) => !item.id || item.id.length > 128) || new Set(items.map((item) => item.id)).size !== items.length) throw new Error("附加字段标识重复或无效。");
  }
}

/** Only the three requested fields are required. Password bytes are never trimmed. */
export function validateVaultInput(input: VaultInput): VaultInput {
  validateVaultDraftInput(input);
  if (!input.site.trim()) throw new Error("请填写网站名称或网址。");
  if (!input.account.trim()) throw new Error("请填写账号。");
  if (!input.password.length) throw new Error("请填写密码。");
  if (input.questions.some((item) => !item.question.trim() && item.answer.length)) throw new Error("请给密保答案补充问题。");
  if (input.fields.some((item) => !item.label.trim() && item.value.length)) throw new Error("请给自定义内容补充字段名称。");
  return { ...input, site: input.site.trim(), account: input.account.trim(), recoveryEmail: input.recoveryEmail.trim(), phone: input.phone.trim(), questions: input.questions.filter((item) => item.question.trim() || item.answer).map((item) => ({ ...item, question: item.question.trim() })), fields: input.fields.filter((item) => item.label.trim() || item.value).map((item) => ({ ...item, label: item.label.trim() })) };
}

function inputShape(value: unknown): value is VaultInput {
  if (!value || typeof value !== "object") return false;
  const item = value as VaultInput;
  return [item.site, item.account, item.password, item.recoveryEmail, item.phone, item.notes].every((part) => typeof part === "string") &&
    Array.isArray(item.questions) && item.questions.every((part) => part && typeof part.id === "string" && typeof part.question === "string" && typeof part.answer === "string") &&
    Array.isArray(item.fields) && item.fields.every((part) => part && typeof part.id === "string" && typeof part.label === "string" && typeof part.value === "string" && typeof part.secret === "boolean");
}
/** A corrupt/unknown document must never be replaced by an empty new vault. */
export function decodeVaultPayload(text: string): VaultPayload {
  try {
    const value = JSON.parse(text) as VaultPayload;
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 5000) throw new Error();
    const ids = new Set<string>();
    for (const item of value.entries) {
      if (!inputShape(item) || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id) || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") throw new Error();
      validateVaultInput(item); ids.add(item.id);
    }
    if (value.draft !== null) {
      if (!value.draft || !inputShape(value.draft.input) || (value.draft.entryId !== null && (typeof value.draft.entryId !== "string" || !ids.has(value.draft.entryId)))) throw new Error();
      validateVaultDraftInput(value.draft.input);
    }
    return value;
  } catch { throw new Error("密码库内容无法读取，原加密文件已保留。"); }
}

export function searchVaultEntries(entries: VaultEntry[], query: string): VaultEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((item) => terms.every((term) => `${item.site}\n${item.account}\n${item.recoveryEmail}\n${item.phone}`.toLocaleLowerCase().includes(term))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
