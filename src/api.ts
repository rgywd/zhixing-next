export type Connection = { url: string; token: string };
export type Page<T> = {
  items: T[];
  next_cursor: string | null;
  previous_cursor?: string | null;
};
export type Assistant = { name: string; persona: string };
export type AgentTool = "inspect_environment" | "list_directory" | "read_text_file" | "read_document" | "view_image" | "write_text_file" | "fetch_public_page" | "record_finance_observation" | "list_finance_observations" | "remove_finance_observation";
export type FinanceObservation = { id: string; kind: "balance" | "income" | "expense"; platform: string; amount: string; note: string; created_at: string };
export type FinanceSummary = { balances: FinanceObservation[]; recent: FinanceObservation[] };
export type Agent = {
  id: string;
  kind: "service" | "custom";
  service: string | null;
  name: string;
  description: string;
  instructions: string;
  tools: AgentTool[];
  visible: boolean;
};
export type ServiceStatus = {
  model_ready: boolean;
  worker_online: boolean;
  execution_available: boolean;
};
export type ReasoningEffort = "auto" | "none" | "low" | "medium" | "high" | "xhigh";
export type ModelInfo = {
  id: string;
  name: string;
  model: string;
  provider: string;
  protocol: "chat_completions" | "responses" | "gemini";
  ready: boolean;
  image_input: boolean;
  reasoning_levels: ReasoningEffort[];
  default_reasoning_effort: Exclude<ReasoningEffort, "auto"> | null;
};
export type ModelCatalog = {
  items: ModelInfo[];
  roles: Partial<Record<"chat" | "task" | "memory", string | null>>;
};
export type Project = { id: string; name: string; workspace_path: string };
export type Conversation = {
  id: string;
  title: string;
  project_id: string | null;
  agent_id: string | null;
  model_id: string | null;
  reasoning_effort: ReasoningEffort | null;
  blocked: boolean;
  updated_at: string;
};
export type ConversationSearchResult = {
  conversation_id: string;
  title: string;
  agent_id: string | null;
  updated_at: string;
  message_id: string | null;
  message_seq: number | null;
  snippet: string;
};
export type Run = {
  phase?: "normal" | "approval" | "recovering";
  recovery_enabled?: number;
  recovery_count?: number;
  id: string;
  conversation_id: string;
  kind: "chat" | "task";
  model_id: string | null;
  reasoning_effort: ReasoningEffort | null;
  status:
    "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  prompt: string;
  cancel_requested: boolean;
  result: string | null;
  error: string | null;
  created_at: string;
};
export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  origin?: "assistant_task";
  content: string;
  attachments?: Resource[];
  intent: "queue" | "steer";
  run_id: string;
  status: "accepted" | "applied" | "rejected";
  created_at: string;
  seq: number;
};
export type MessageInput = {
  id: string;
  content: string;
  attachments?: string[];
  intent: "queue" | "steer";
  kind: "chat" | "task";
  target_run_id?: string;
  model_id?: string;
  reasoning_effort?: ReasoningEffort;
  search_provider_id?: string;
};
export type SearchProvider = { id: string; name: string; kind: "brave" | "tavily" | "serper" };
export type Resource = { id: string; name: string; path: string; size: number; mime_type: string; conversation_id: string };
export type Approval = {
  id: string;
  run_id: string;
  kind: "overwrite" | "network" | "uncertain";
  state: string;
  details: { title: string; description?: string; path?: string; bytes?: number; preview?: string; task?: string; tool?: string; arguments?: Record<string, unknown> };
};
export type Draft = { text: string; attachments?: Resource[]; pending: MessageInput | null };
export type Schedule = {
  id: string;
  conversation_id: string;
  prompt: string;
  next_run_at: string;
  interval_seconds: number | null;
  enabled: boolean;
  last_run_id: string | null;
};
export type ScheduleInput = {
  id: string;
  conversation_id: string;
  prompt: string;
  next_run_at: string;
  interval_seconds: number | null;
};
export type PlanDraft = {
  prompt: string;
  time: string;
  interval: string;
  pending: ScheduleInput | null;
};
export type RunEvent = {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
};

export function normalizeServerUrl(input: string, development = false): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("请输入完整服务地址，例如 https://assistant.example.com");
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(
    url.hostname,
  );
  if (
    url.protocol !== "https:" &&
    !(development && local && url.protocol === "http:")
  ) {
    throw new Error(
      "服务地址需要 HTTPS；开发模式仅允许本机或 Android 模拟器使用 HTTP。",
    );
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("服务地址不能包含账号、令牌、查询参数或锚点。");
  return url.toString().replace(/\/+$/, "");
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function fileUploadRequest(
  connection: Connection,
  file: { size: number; bytes(): Promise<Uint8Array<ArrayBuffer>> },
) {
  if (file.size > MAX_FILE_BYTES) throw new Error("单个文件最多 20 MiB。");
  // Expo fetch replaces Content-Type with File/Blob.type; raw bytes retain our protocol header.
  const body = await file.bytes();
  if (body.byteLength > MAX_FILE_BYTES) throw new Error("单个文件最多 20 MiB。");
  return {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/octet-stream",
    },
    body,
    redirect: "error" as const,
  };
}

export async function request<T>(
  connection: Connection,
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 15000);
  try {
    const response = await fetch(`${connection.url}/v1${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: "error",
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        data.error?.message ?? `服务请求失败（${response.status}）`,
        data.error?.code ?? "http_error",
        response.status,
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (options.signal?.aborted) throw error;
    throw new Error("暂时连接不上服务，请检查网络、服务地址与证书后重试。");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function mergeById<T extends { id: string }>(
  previous: T[],
  incoming: T[],
): T[] {
  const map = new Map(previous.map((item) => [item.id, item]));
  incoming.forEach((item) => map.set(item.id, item));
  return [...map.values()];
}

export function prepareMessage(
  draft: Draft,
  intent: MessageInput["intent"],
  kind: MessageInput["kind"],
  target: string | null,
  runningId: string | null,
  newId: () => string,
): MessageInput {
  if (draft.pending) return draft.pending;
  if (!draft.text.trim() && !draft.attachments?.length) throw new Error("先写下要说的话或添加资料。");
  if ((draft.attachments?.length ?? 0) > 8) throw new Error("每条消息最多 8 份资料。");
  if (intent === "steer" && (!target || target !== runningId))
    throw new Error("原目标已经结束。请选择排队发送，或重新选择当前运行。");
  return {
    id: newId(),
    content: draft.text.trim(),
    ...(draft.attachments?.length ? { attachments: draft.attachments.map((item) => item.id) } : {}),
    intent,
    kind,
    ...(intent === "steer" && target ? { target_run_id: target } : {}),
  };
}

export function safeDownloadName(name: string): string {
  const cleaned = name.replace(/[\\/\x00-\x1f]/g, "_");
  return !cleaned || cleaned === "." || cleaned === ".." ? "artifact" : cleaned;
}

export function prepareSchedule(
  draft: PlanDraft,
  conversationId: string | null,
  newId: () => string,
): ScheduleInput {
  if (draft.pending) return draft.pending;
  if (!conversationId) throw new Error("请先选择一个会话，作为结果归属。");
  if (!draft.prompt.trim()) throw new Error("请填写计划要做的事。");
  const seconds = draft.interval.trim() ? Number(draft.interval) * 60 : null;
  if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 60))
    throw new Error("重复间隔至少 1 分钟，请输入有效分钟数。");
  return {
    id: newId(),
    conversation_id: conversationId,
    prompt: draft.prompt.trim(),
    next_run_at: parseLocalTime(draft.time),
    interval_seconds: seconds,
  };
}

export function parseLocalTime(input: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(input.trim());
  if (!match)
    throw new Error("时间格式为 YYYY-MM-DD HH:mm，使用手机当地时间。");
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  )
    throw new Error("这个当地时间不存在，请检查日期与时间。");
  if (date.getTime() <= Date.now()) throw new Error("请选择未来的执行时间。");
  return date.toISOString();
}
