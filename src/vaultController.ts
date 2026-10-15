import type { VaultEnvelope, VaultKey } from "./vaultCrypto";
import { emptyVaultInput, validateVaultDraftInput, validateVaultInput, type VaultDraft, type VaultEntry, type VaultInput, type VaultPayload } from "./vaultTypes";

export type VaultStatus = "loading" | "create" | "locked" | "unlocked" | "error" | "unsupported";
export type VaultState = { status: VaultStatus; lockEpoch: number; entries: VaultEntry[]; draft: VaultDraft | null; busy: boolean; draftSaving: boolean; error: string; storageError: string };
export type VaultPorts = {
  supported(): boolean; readRaw(): Promise<string | null>; writeRaw(raw: string, expected: string | null): Promise<void>;
  parse(raw: string): VaultEnvelope; createKey(master: string): Promise<{ key: VaultKey; salt: string }>;
  unlock(envelope: VaultEnvelope, master: string): Promise<{ key: VaultKey; payload: VaultPayload }>;
  seal(payload: VaultPayload, key: VaultKey, salt: string): Promise<VaultEnvelope>;
  copy(value: string): Promise<void>; clearClipboard(): Promise<void>; generate(): Promise<string>;
  id(): string; now(): number; later(action: () => void, ms: number): ReturnType<typeof setTimeout>; cancel(timer: ReturnType<typeof setTimeout>): void;
};
type Session = { key: VaultKey; salt: string; payload: VaultPayload; revision: number; dirty: boolean };
const initialState = (status: VaultStatus): VaultState => ({ status, lockEpoch: 0, entries: [], draft: null, busy: false, draftSaving: false, error: "", storageError: "" });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const VAULT_IDLE_MS = 120000;
export function validateMasterPassword(value: string) {
  if (value.length < 12 || value.length > 1024) throw new Error("主密码请使用 12 至 1024 个字符，不会去除空格。");
}

/** No network or general draft store. A session key never survives lock/dispose. */
export class VaultController {
  private state = initialState("loading");
  private listeners = new Set<() => void>();
  private raw: string | null = null;
  private session: Session | null = null;
  private generation = 0;
  private lockEpoch = 0;
  private disposed = false;
  private committing: number | null = null;
  private writes: Promise<void> = Promise.resolve();
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private ports: VaultPorts) {}
  // React development Strict Effects can attach again after a complete cleanup.
  activate = () => { if (this.disposed) { this.disposed = false; this.generation++; this.state = initialState("loading"); } };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<VaultState>) { if (this.disposed) return; this.state = { ...this.state, ...patch, lockEpoch: this.lockEpoch }; this.listeners.forEach((listener) => listener()); }
  private current(session: Session, own: number) { return !this.disposed && this.session === session && this.generation === own; }
  private expose(session: Session, patch: Partial<VaultState> = {}) { this.emit({ entries: clone(session.payload.entries), draft: clone(session.payload.draft), draftSaving: session.dirty, ...patch }); }
  private stopDraftTimer() { if (this.draftTimer !== null) this.ports.cancel(this.draftTimer); this.draftTimer = null; }
  private stopIdleTimer() { if (this.idleTimer !== null) this.ports.cancel(this.idleTimer); this.idleTimer = null; }
  touch = () => { this.stopIdleTimer(); if (this.session && !this.disposed) this.idleTimer = this.ports.later(this.lock, VAULT_IDLE_MS); };
  start = async () => {
    if (this.disposed) return;
    if (this.session) this.lock();
    const own = ++this.generation;
    if (!this.ports.supported()) { this.emit({ ...initialState("unsupported") }); return; }
    this.emit(initialState("loading"));
    try {
      await this.writes.catch(() => undefined);
      if (this.disposed || own !== this.generation) return;
      const raw = await this.ports.readRaw();
      if (raw !== null) this.ports.parse(raw);
      if (this.disposed || own !== this.generation) return;
      this.raw = raw; this.emit(initialState(raw === null ? "create" : "locked"));
    } catch { if (!this.disposed && own === this.generation) this.emit({ ...initialState("error"), error: "密码库暂时无法读取。原加密文件已保留，请重试。" }); }
  };
  private persist(payload: VaultPayload, key: VaultKey, salt: string, expected?: string | null): Promise<void> {
    const frozen = clone(payload);
    const next = this.writes.catch(() => undefined).then(async () => {
      const raw = JSON.stringify(await this.ports.seal(frozen, key, salt));
      try { await this.ports.writeRaw(raw, expected === undefined ? this.raw : expected); }
      catch {
        // A lost bridge receipt must not turn a successful atomic commit into a duplicate.
        const received = await this.ports.readRaw();
        if (received !== raw) throw new Error("vault_write_failed");
      }
      this.raw = raw;
      if (!this.session && !this.disposed && ["create", "locked"].includes(this.state.status)) this.emit({ status: "locked" });
    });
    this.writes = next; return next;
  }
  private flush(session: Session): Promise<void> {
    this.stopDraftTimer();
    if (!session.dirty) return this.writes.catch(() => undefined);
    const revision = session.revision;
    return this.persist(session.payload, session.key, session.salt).then(() => {
      if (session.revision === revision) session.dirty = false;
      if (this.session === session) this.expose(session, { storageError: "" });
    }).catch(() => {
      if (this.session === session) this.emit({ draftSaving: false, storageError: "编辑尚未加密保存，请保持页面打开并重试保存。" });
      throw new Error("vault_draft_write_failed");
    });
  }
  create = async (master: string): Promise<boolean> => {
    if (this.disposed || this.state.status !== "create" || this.state.busy) return false;
    try { validateMasterPassword(master); } catch { this.emit({ error: "主密码请使用 12 至 1024 个字符，不会去除空格。" }); return false; }
    const own = ++this.generation; this.emit({ busy: true, error: "" });
    try {
      await this.writes.catch(() => undefined);
      if (this.disposed || own !== this.generation) return false;
      const existing = await this.ports.readRaw();
      if (this.disposed || own !== this.generation) return false;
      if (existing !== null) {
        try { this.ports.parse(existing); }
        catch { this.emit({ ...initialState("error"), error: "密码库暂时无法读取。原加密文件已保留，请重试。" }); return false; }
        this.raw = existing;
        this.emit({ ...initialState("locked"), error: "密码库已存在，请使用主密码解锁。" }); return false;
      }
      const { key, salt } = await this.ports.createKey(master);
      if (this.disposed || own !== this.generation) return false;
      const payload: VaultPayload = { version: 1, entries: [], draft: null };
      this.committing = own;
      await this.persist(payload, key, salt, null);
      if (this.disposed || own !== this.generation) return false;
      this.session = { key, salt, payload, revision: 0, dirty: false };
      this.emit(initialState("unlocked")); this.touch(); return true;
    } catch { if (!this.disposed && own === this.generation) this.emit({ error: "密码库尚未创建，请重试；已有文件不会被覆盖。" }); return false; }
    finally { if (this.committing === own) this.committing = null; if (!this.disposed && own === this.generation) this.emit({ busy: false }); }
  };
  unlock = async (master: string): Promise<boolean> => {
    if (this.disposed || this.state.status !== "locked" || this.state.busy) return false;
    const own = ++this.generation; this.emit({ busy: true, error: "" });
    try {
      await this.writes.catch(() => undefined);
      if (this.disposed || own !== this.generation) return false;
      const raw = await this.ports.readRaw();
      if (this.disposed || own !== this.generation) return false;
      if (raw === null) throw new Error();
      const result = await this.ports.unlock(this.ports.parse(raw), master);
      if (this.disposed || own !== this.generation) return false;
      this.raw = raw; this.session = { ...result, salt: this.ports.parse(raw).salt, revision: 0, dirty: false };
      this.emit({ ...initialState("unlocked"), entries: clone(result.payload.entries), draft: clone(result.payload.draft) }); this.touch(); return true;
    } catch { if (!this.disposed && own === this.generation) this.emit({ error: "主密码不正确，或密码库文件无法解密。原文件已保留。" }); return false; }
    finally { if (!this.disposed && own === this.generation) this.emit({ busy: false }); }
  };
  beginEdit = (entryId?: string) => {
    const session = this.session; if (!session || this.state.busy) return;
    if (!session.payload.draft) {
      const entry = entryId ? session.payload.entries.find((item) => item.id === entryId) : null;
      if (entryId && !entry) { this.emit({ error: "这条记录已不存在，请刷新密码库。" }); return; }
      const input = entry ? clone(entry) : emptyVaultInput();
      if (entry) { delete (input as Partial<VaultEntry>).id; delete (input as Partial<VaultEntry>).createdAt; delete (input as Partial<VaultEntry>).updatedAt; }
      session.payload = { ...session.payload, draft: { entryId: entry?.id ?? null, input } };
      this.markDirty(session);
    }
    this.touch(); this.expose(session, { error: "" });
  };
  updateDraft = (input: VaultInput) => {
    const session = this.session; if (!session?.payload.draft || this.state.busy) return;
    try { validateVaultDraftInput(input); }
    catch { this.emit({ error: "部分编辑内容过长或格式无效，请精简后再保存。" }); return; }
    session.payload = { ...session.payload, draft: { ...session.payload.draft, input: clone(input) } };
    this.markDirty(session); this.touch(); this.expose(session, { error: "" });
  };
  private markDirty(session: Session) {
    session.dirty = true; session.revision++; this.stopDraftTimer();
    this.draftTimer = this.ports.later(() => { this.draftTimer = null; void this.flush(session).catch(() => undefined); }, 250);
  }
  private mutate = async (build: (session: Session) => VaultPayload, message: string, replacement?: { key: VaultKey; salt: string }): Promise<boolean> => {
    const session = this.session, own = this.generation;
    if (!session || this.state.busy || this.disposed) return false;
    this.emit({ busy: true, error: "" }); this.touch();
    try {
      await this.flush(session);
      if (!this.current(session, own)) return false;
      const payload = build(session);
      this.committing = own;
      await this.persist(payload, replacement?.key ?? session.key, replacement?.salt ?? session.salt);
      if (!this.current(session, own)) return false;
      session.payload = payload; session.dirty = false;
      if (replacement) { session.key = replacement.key; session.salt = replacement.salt; }
      this.expose(session, { error: "", storageError: "" }); return true;
    } catch { if (this.current(session, own)) this.emit({ error: message }); return false; }
    finally { if (this.committing === own) this.committing = null; if (this.current(session, own)) this.emit({ busy: false }); }
  };
  save = async (): Promise<boolean> => {
    const session = this.session; if (!session?.payload.draft || this.state.busy) return false;
    let input: VaultInput;
    try { input = validateVaultInput(session.payload.draft.input); }
    catch (error) { this.emit({ error: error instanceof Error ? error.message : "请检查必填内容。" }); return false; }
    const draft = session.payload.draft, previous = session.payload.entries.find((item) => item.id === draft.entryId);
    const now = new Date(this.ports.now()).toISOString();
    const entry: VaultEntry = { ...input, id: previous?.id ?? this.ports.id(), createdAt: previous?.createdAt ?? now, updatedAt: now };
    return this.mutate((current) => ({ ...current.payload, entries: [...current.payload.entries.filter((item) => item.id !== entry.id), entry], draft: null }), "尚未保存，原记录和编辑内容仍保留。请重试。");
  };
  discardDraft = () => this.mutate((session) => ({ ...session.payload, draft: null }), "尚未放弃编辑，请重试。");
  removeEntry = (id: string) => this.mutate((session) => ({ ...session.payload, entries: session.payload.entries.filter((item) => item.id !== id), draft: session.payload.draft?.entryId === id ? null : session.payload.draft }), "尚未删除，原记录仍保留。请重试。");
  changeMaster = async (master: string): Promise<boolean> => {
    const session = this.session, own = this.generation; if (!session || this.state.busy) return false;
    try { validateMasterPassword(master); } catch { this.emit({ error: "主密码请使用 12 至 1024 个字符，不会去除空格。" }); return false; }
    this.emit({ busy: true, error: "" });
    try {
      await this.flush(session);
      if (!this.current(session, own)) return false;
      const replacement = await this.ports.createKey(master);
      if (!this.current(session, own)) return false;
      this.committing = own;
      await this.persist(session.payload, replacement.key, replacement.salt);
      if (!this.current(session, own)) return false;
      session.key = replacement.key; session.salt = replacement.salt; session.dirty = false;
      this.expose(session, { storageError: "" }); this.touch(); return true;
    } catch { if (this.current(session, own)) this.emit({ error: "主密码尚未修改，请使用原主密码重试。" }); return false; }
    finally { if (this.committing === own) this.committing = null; if (this.current(session, own)) this.emit({ busy: false }); }
  };
  copy = async (value: string): Promise<boolean> => {
    if (!this.session || this.disposed) return false;
    const own = this.generation; this.touch();
    try { await this.ports.copy(value); if (own !== this.generation || this.disposed) { await this.ports.clearClipboard(); return false; } return true; }
    catch { if (!this.disposed && own === this.generation) this.emit({ error: "尚未复制，请重试。" }); return false; }
  };
  generate = async (): Promise<string | null> => {
    if (!this.session || this.disposed) return null;
    const own = this.generation; this.touch();
    try { const result = await this.ports.generate(); return !this.disposed && own === this.generation ? result : null; }
    catch { if (!this.disposed && own === this.generation) this.emit({ error: "暂时无法生成密码，请重试。" }); return null; }
  };
  lock = () => {
    if (this.disposed) return;
    this.lockEpoch++;
    const session = this.session;
    this.stopDraftTimer(); this.stopIdleTimer();
    if (this.state.status === "loading") { this.emit({}); void this.ports.clearClipboard().catch(() => undefined); return; }
    if (session?.dirty && this.committing !== this.generation) void this.flush(session).catch(() => undefined);
    this.generation++; this.session = null;
    const status = this.state.status === "unsupported" ? "unsupported" : this.state.status === "error" ? "error" : this.raw === null ? "create" : "locked";
    this.emit(initialState(status)); void this.ports.clearClipboard().catch(() => undefined);
  };
  dispose = () => { if (this.disposed) return; this.lock(); this.disposed = true; this.listeners.clear(); };
}
