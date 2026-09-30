export type SyncFailure = { since: number; attempts: number; status?: number };
export const SYNC_GRACE_MS = 15_000;

export function failedSync(previous: SyncFailure | undefined, status: number | undefined, now: number): SyncFailure {
  return { since: previous?.since ?? now, attempts: (previous?.attempts ?? 0) + 1, status };
}

export function syncNotice(failures: SyncFailure[], now: number): string | null {
  if (failures.some((failure) => failure.status === 401 || failure.status === 403)) {
    return "访问受限，请在连接设置中检查凭证";
  }
  return failures.some((failure) => failure.attempts >= 3 && now - failure.since >= SYNC_GRACE_MS)
    ? "暂时无法同步，正在自动重连" : null;
}
