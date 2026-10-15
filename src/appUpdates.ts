export const GITHUB_RELEASES_URL = "https://github.com/rgywd/zhixing-next/releases";
export const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/rgywd/zhixing-next/releases/latest";

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

export type AppRelease = { version: string; name: string; notes: string; url: string; apkUrl: string | null };
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
  const release: AppRelease = {
    version, name: typeof value.name === "string" && value.name.trim() ? value.name.slice(0, 200) : `知行 Next ${version}`,
    notes: typeof value.body === "string" ? value.body.slice(0, 12000) : "", url, apkUrl: asset ? expectedApk : null,
  };
  const comparison = compareVersions(version, currentVersion)!;
  return { kind: comparison > 0 ? (release.apkUrl ? "available" : "pending") : "current", release };
}

const abortError = () => Object.assign(new Error("检查已取消"), { name: "AbortError" });

/** Public GitHub request: no service connection, Authorization or user credentials. */
export async function checkGitHubUpdate(currentVersion: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<UpdateResult> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let rejectInterrupted: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const abort = () => { controller.abort(); rejectInterrupted(abortError()); };
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); rejectInterrupted(new UpdateCheckError("检查更新超时，请检查网络后重试。")); }, 15000);
  try {
    return await Promise.race([interrupted, (async (): Promise<UpdateResult> => {
      const response = await fetcher(GITHUB_LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", signal: controller.signal });
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
      if (response.status === 404) return { kind: "unpublished" };
      if (response.status === 403 || response.status === 429) throw new UpdateCheckError("GitHub 暂时限制访问，请稍后重试，或直接查看发布页。");
      if (!response.ok) throw new UpdateCheckError(`GitHub 暂时无法访问（${response.status}），请稍后重试。`);
      const payload: unknown = await response.json();
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
      return readReleaseResponse(payload, currentVersion);
    })()]);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new UpdateCheckError("检查更新超时，请检查网络后重试。");
    if (error instanceof UpdateCheckError) throw error;
    throw new UpdateCheckError("未能获取 GitHub 版本信息，请检查网络后重试。");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
