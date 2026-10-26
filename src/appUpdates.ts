export const GITHUB_RELEASES_URL = "https://github.com/rgywd/zhixing-next/releases";
export const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/rgywd/zhixing-next/releases/latest";
export const GITHUB_UPDATE_MANIFEST = `${GITHUB_RELEASES_URL}/latest/download/app-update.json`;
export const UPDATE_CACHE_KEY = "zhixing.app-update.v1";
export const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000;
export const UPDATE_API_TIMEOUT_MS = 5000;
export const UPDATE_MANIFEST_TIMEOUT_MS = 8000;

type Semver = { core: number[]; prerelease: string[] };
const semverPattern = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function parseVersion(value: string): Semver | null {
  const match = semverPattern.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split(".") ?? [];
  if (core.some((part) => !Number.isSafeInteger(part)) || prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core, prerelease };
}

/** SemVer precedence; build metadata never changes which version is newer. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return x.length !== y.length ? (x.length > y.length ? 1 : -1) : x > y ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export type AppRelease = { version: string; name: string; notes: string; url: string; apkUrl: string | null; apkSize: number | null; apkSha256: string | null };
export type UpdateResult = { kind: "available" | "current" | "pending"; release: AppRelease } | { kind: "unpublished" };

export class UpdateCheckError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isReleaseLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === "/rgywd/zhixing-next/releases" || /^\/rgywd\/zhixing-next\/releases\/(?:tag\/[^/]+|download\/[^/]+\/[^/]+\.apk)$/.test(url.pathname))
      && !/[%\\]/.test(url.pathname);
  } catch { return false; }
}

export function readReleaseResponse(value: unknown, currentVersion: string): UpdateResult {
  if (!parseVersion(currentVersion)) throw new UpdateCheckError("当前版本信息异常，请从 GitHub 查看正式版本。");
  if (!object(value) || typeof value.tag_name !== "string" || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean") throw new UpdateCheckError("GitHub 返回的版本信息不完整，请稍后重试。");
  const parsed = parseVersion(value.tag_name);
  if (!parsed) throw new UpdateCheckError("GitHub 版本号格式异常，请查看发布页。");
  if (value.draft || value.prerelease || parsed.prerelease.length) return { kind: "unpublished" };
  const url = `${GITHUB_RELEASES_URL}/tag/${value.tag_name}`;
  if (value.html_url !== url || !isReleaseLink(url) || !Array.isArray(value.assets)) throw new UpdateCheckError("GitHub 返回的发布信息异常，请稍后重试。");
  const version = value.tag_name.replace(/^v/, "");
  const apkName = `zhixing-next-${version}-arm64.apk`;
  const expectedApk = `${GITHUB_RELEASES_URL}/download/${value.tag_name}/${apkName}`;
  const asset = value.assets.find((item) => object(item) && item.name === apkName && item.state === "uploaded" && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size > 0 && item.browser_download_url === expectedApk && isReleaseLink(item.browser_download_url));
  const digest = asset && typeof asset.digest === "string" && asset.digest.length === 71 ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest) : null;
  const release: AppRelease = {
    version, name: typeof value.name === "string" && value.name.trim() ? value.name.slice(0, 200) : `知行 Next ${version}`,
    notes: typeof value.body === "string" ? value.body.slice(0, 12000) : "", url, apkUrl: asset ? expectedApk : null,
    apkSize: asset ? asset.size : null, apkSha256: digest ? digest[1].toLowerCase() : null,
  };
  const comparison = compareVersions(version, currentVersion)!;
  return { kind: comparison > 0 ? (release.apkUrl ? "available" : "pending") : "current", release };
}

const abortError = () => Object.assign(new Error("检查已取消"), { name: "AbortError" });
const assertActive = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
type ReleaseRead = { result: UpdateResult; payload: unknown };
type ReadOptions = { skipApi?: boolean; onRateLimit?: (retryAt: number) => void; now?: () => number };

/** Each source has its own deadline, including response-body parsing. */
async function readSource(url: string, currentVersion: string, timeoutMs: number, signal: AbortSignal | undefined, fetcher: typeof fetch, options: ReadOptions): Promise<ReleaseRead> {
  assertActive(signal);
  const controller = new AbortController();
  let rejectInterrupted: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const abort = () => { controller.abort(); rejectInterrupted(abortError()); };
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true; controller.abort(); rejectInterrupted(new UpdateCheckError("检查更新超时，请检查网络后重试。"));
  }, timeoutMs);
  try {
    return await Promise.race([interrupted, (async (): Promise<ReleaseRead> => {
      const response = await fetcher(url, { headers: url === GITHUB_LATEST_RELEASE_API
        ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Zhixing-Next-App-Updates" }
        : { Accept: "application/json" }, credentials: "omit", signal: controller.signal });
      assertActive(signal);
      if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
      if (response.status === 403 || response.status === 429) {
        const now = (options.now ?? Date.now)();
        const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
        const retryHeader = response.headers.get("retry-after");
        const retry = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1000
          : retryHeader ? Math.max(Date.parse(retryHeader) - now, 0) : NaN;
        let limited = response.status === 429 || exhausted || Number.isFinite(retry);
        // Error bodies are optional evidence, never text to display. Inspect only
        // a declared small JSON response within the same source deadline.
        const length = response.headers.get("content-length");
        if (!limited && length !== null && /^\d+$/.test(length) && Number(length) <= 16_384
          && response.headers.get("content-type")?.includes("application/json")) {
          try {
            const body: unknown = await response.json();
            limited = object(body) && typeof body.message === "string" && body.message.length <= 1000
              && /\b(?:rate limit exceeded|secondary rate limit|abuse detection)\b/i.test(body.message);
          } catch { /* The HTTP status remains useful when error JSON is absent. */ }
        }
        assertActive(signal);
        if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
        if (limited && url === GITHUB_LATEST_RELEASE_API) {
          const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
          const wait = Math.max(exhausted && Number.isFinite(reset) ? reset - now : 0,
            Number.isFinite(retry) ? retry : 0, 60_000);
          options.onRateLimit?.(now + Math.min(Number.isFinite(wait) ? Math.max(wait, 15 * 60_000) : 15 * 60_000, 6 * 60 * 60_000));
        }
        throw new UpdateCheckError(limited ? "GitHub 暂时限制请求频率，请稍后重试。" : "GitHub 拒绝访问（403），请稍后重试。");
      }
      if (response.status === 404) return { result: { kind: "unpublished" }, payload: null };
      if (!response.ok) throw new UpdateCheckError(`GitHub 暂时无法访问（${response.status}），请稍后重试。`);
      const payload: unknown = await response.json();
      assertActive(signal);
      if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
      return { result: readReleaseResponse(payload, currentVersion), payload };
    })()]);
  } catch (error) {
    assertActive(signal);
    if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
    if (error instanceof UpdateCheckError) throw error;
    throw new UpdateCheckError("未能获取 GitHub 版本信息，请检查网络后重试。");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function readLatestRelease(currentVersion: string, signal: AbortSignal | undefined, fetcher: typeof fetch, options: ReadOptions): Promise<ReleaseRead> {
  const diagnostics: string[] = [];
  let failed = false;
  for (const [url, timeout] of options.skipApi ? [[GITHUB_UPDATE_MANIFEST, UPDATE_MANIFEST_TIMEOUT_MS]] as const
    : [[GITHUB_UPDATE_MANIFEST, UPDATE_MANIFEST_TIMEOUT_MS], [GITHUB_LATEST_RELEASE_API, UPDATE_API_TIMEOUT_MS]] as const) {
    const source = url === GITHUB_UPDATE_MANIFEST ? "官方更新清单" : "GitHub API";
    try {
      const read = await readSource(url, currentVersion, timeout, signal, fetcher, options);
      if (read.result.kind !== "unpublished") return read;
      diagnostics.push(`${source}：未找到可用正式版本。`);
    } catch (error) {
      assertActive(signal); failed = true;
      diagnostics.push(`${source}：${error instanceof Error ? error.message : "读取失败，请稍后重试。"}`);
    }
  }
  if (failed) {
    if (options.skipApi) diagnostics.push("GitHub API：仍在限流冷却期，稍后再试。");
    throw new UpdateCheckError(diagnostics.join("\n"));
  }
  return { result: { kind: "unpublished" }, payload: null };
}

/** Public official sources only; fallback assets do not use the REST API quota. */
export async function checkGitHubUpdate(currentVersion: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<UpdateResult> {
  return (await readLatestRelease(currentVersion, signal, fetcher, {})).result;
}

export type CheckedUpdate = { result: UpdateResult; verifiedAt: number; source: "network" | "cache"; offline: boolean; cacheSaved: boolean };
type UpdateStore = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<unknown> };
type CacheRecord = { schema: 1; apiRetryAt: number; verifiedAt: number | null; release: unknown };

/** Persist only bounded, validated public release metadata, never connection or account data. */
function releasePayload(release: AppRelease, payload: unknown) {
  const tag = release.url.slice(`${GITHUB_RELEASES_URL}/tag/`.length);
  const name = `zhixing-next-${release.version}-arm64.apk`;
  const asset = object(payload) && Array.isArray(payload.assets) ? payload.assets.find((item) => object(item) && item.name === name
    && item.state === "uploaded" && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size > 0 && item.browser_download_url === release.apkUrl) : null;
  return { tag_name: tag, draft: false, prerelease: false, html_url: release.url, name: release.name, body: release.notes,
    assets: release.apkUrl && object(asset) ? [{ name, state: "uploaded", size: release.apkSize, browser_download_url: release.apkUrl,
      ...(release.apkSha256 ? { digest: `sha256:${release.apkSha256}` } : {}) }] : [] };
}

export function createAppUpdateChecker(store: UpdateStore, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let record: CacheRecord = { schema: 1, apiRetryAt: 0, verifiedAt: null, release: null };
  let loaded: Promise<void> | null = null;
  let writes = Promise.resolve();
  let cacheSaved = true;
  const jobs = new Map<string, { controller: AbortController; promise: Promise<CheckedUpdate>; readers: number }>();
  async function load() {
    loaded ??= (async () => {
      try {
        const raw = await store.getItem(UPDATE_CACHE_KEY);
        if (!raw || raw.length > 24_000) return;
        const value: unknown = JSON.parse(raw);
        if (!object(value) || value.schema !== 1 || typeof value.apiRetryAt !== "number" || !Number.isFinite(value.apiRetryAt)) return;
        record.apiRetryAt = value.apiRetryAt > now() && value.apiRetryAt <= now() + 6 * 60 * 60_000 ? value.apiRetryAt : 0;
        if (typeof value.verifiedAt !== "number" || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.verifiedAt > now() + 60_000) return;
        const parsed = readReleaseResponse(value.release, "0.0.0");
        if (parsed.kind !== "unpublished" && parsed.release.apkUrl) record = { ...record, verifiedAt: value.verifiedAt, release: releasePayload(parsed.release, value.release) };
      } catch { /* A damaged or unavailable cache must not prevent an online check. */ }
    })();
    await loaded;
  }
  async function persist() {
    const snapshot = JSON.stringify(record);
    const saving = writes.then(() => store.setItem(UPDATE_CACHE_KEY, snapshot)).then(() => true, () => false);
    writes = saving.then(() => {});
    cacheSaved = await saving;
    return cacheSaved;
  }
  async function perform(currentVersion: string, signal: AbortSignal, force: boolean): Promise<CheckedUpdate> {
    await load(); assertActive(signal);
    const cachedAt = record.verifiedAt;
    const cachedResult = cachedAt && record.release ? readReleaseResponse(record.release, currentVersion) : null;
    const cached = (offline: boolean): CheckedUpdate => ({ result: cachedResult!, verifiedAt: cachedAt!, source: "cache", offline, cacheSaved });
    if (!force && cachedResult && now() - record.verifiedAt! < UPDATE_CACHE_TTL_MS) return cached(false);
    try {
      const read = await readLatestRelease(currentVersion, signal, fetcher, { now, skipApi: record.apiRetryAt > now(),
        onRateLimit: (retryAt) => { record.apiRetryAt = retryAt; } });
      assertActive(signal);
      const verifiedAt = now();
      if (read.result.kind !== "unpublished" && read.result.release.apkUrl) {
        record = { ...record, verifiedAt, release: releasePayload(read.result.release, read.payload) };
      }
      const cacheSaved = await persist(); assertActive(signal);
      return { result: read.result, verifiedAt, source: "network", offline: false, cacheSaved };
    } catch (error) {
      assertActive(signal);
      await persist(); assertActive(signal);
      if (cachedResult) return cached(true);
      throw error;
    }
  }
  return {
    check(currentVersion: string, signal?: AbortSignal, force = false): Promise<CheckedUpdate> {
      assertActive(signal);
      let job = jobs.get(currentVersion);
      if (!job) {
        const controller = new AbortController();
        const promise = perform(currentVersion, controller.signal, force);
        job = { controller, promise, readers: 0 };
        jobs.set(currentVersion, job);
        const ownJob = job;
        void promise.finally(() => { if (jobs.get(currentVersion) === ownJob) jobs.delete(currentVersion); }).catch(() => {});
      }
      const shared = job;
      shared.readers++;
      return new Promise<CheckedUpdate>((resolve, reject) => {
        let complete = false;
        const finish = (result: CheckedUpdate | null, error?: unknown) => {
          if (complete) return;
          complete = true; signal?.removeEventListener("abort", abort);
          shared.readers--;
          if (!shared.readers) {
            shared.controller.abort();
            if (jobs.get(currentVersion) === shared) jobs.delete(currentVersion);
          }
          if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(null, abortError());
        signal?.addEventListener("abort", abort, { once: true });
        shared.promise.then((result) => finish(result), (error) => finish(null, error));
      });
    },
  };
}
