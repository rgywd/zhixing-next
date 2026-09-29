import type { ManagedModel, ManagedModelInput, ModelProtocol, ModelProvider, ProviderInput, ModelCatalog, ReasoningEffort } from "./api";

export const protocolLabels: Record<ModelProtocol, string> = { chat_completions: "OpenAI 兼容", responses: "Responses", gemini: "Gemini" };
export const protocolUrls: Record<ModelProtocol, string> = {
  chat_completions: "https://api.openai.com/v1", responses: "https://api.openai.com/v1", gemini: "https://generativelanguage.googleapis.com",
};
export function providerInput(provider: ModelProvider | undefined, form: ProviderInput, key: string, clearKey: boolean): ProviderInput {
  const input: ProviderInput = { name: form.name.trim(), protocol: form.protocol, base_url: form.base_url.trim(), enabled: form.enabled };
  if (!input.name || !input.base_url) throw new Error("请填写供应商名称与 API 地址。");
  let url: URL;
  try { url = new URL(input.base_url); } catch { throw new Error("请输入完整的 API 地址。"); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("API 地址不能包含密钥、查询参数或锚点。");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("远程 API 地址需要使用 HTTPS。");
  if (key.trim() && !clearKey) input.api_key = key.trim();
  if (provider) { input.revision = provider.revision; input.clear_api_key = clearKey; }
  return input;
}
export function modelInput(model?: ManagedModel): ManagedModelInput {
  return {
    model: model?.model ?? "", display_name: model?.name ?? null, enabled: model?.enabled ?? true,
    image_input: model?.image_input ?? false, reasoning_levels: model?.reasoning_levels ?? [],
    reasoning_effort: model?.default_reasoning_effort ?? null, temperature: model?.temperature ?? null, timeout: model?.timeout ?? 60,
  };
}
export function matchesModel(query: string, ...values: string[]) {
  const text = values.join(" ").toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/).every((part) => text.includes(part));
}

export function availablePreference(catalog: ModelCatalog | null, kind: "chat" | "task", modelId: string | null, effort: ReasoningEffort | null) {
  if (!catalog) return { modelId, effort };
  const chosen = modelId && catalog.items.some((model) => model.id === modelId) ? modelId : null;
  const model = catalog.items.find((item) => item.id === (chosen ?? catalog.roles[kind]));
  return { modelId: chosen, effort: model && (!modelId || chosen) && effort && model.reasoning_levels.includes(effort) ? effort : null };
}
