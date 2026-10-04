import type { Conversation, Project, Resource } from "./api";

export type HomeTarget = { kind: "conversation" | "project" | "resource"; id: string; title: string };
export type HomePreferences = { pins: HomeTarget[]; visited: HomeTarget[]; opened: Record<string, string> };
export const emptyHomePreferences: HomePreferences = { pins: [], visited: [], opened: {} };
export const targetKey = (target: Pick<HomeTarget, "kind" | "id">) => `${target.kind}:${target.id}`;
export function parseHomePreferences(value: string | null): HomePreferences {
  if (!value) return emptyHomePreferences;
  const parsed = JSON.parse(value);
  const valid = (item: HomeTarget) => item && ["conversation", "project", "resource"].includes(item.kind) && typeof item.id === "string" && typeof item.title === "string";
  const pins: HomeTarget[] = Array.isArray(parsed.pins) ? parsed.pins.filter(valid) : [];
  const visited: HomeTarget[] = Array.isArray(parsed.visited) ? parsed.visited.filter(valid).slice(0, 100) : [];
  return { pins: [...new Map(pins.map((item) => [targetKey(item), item])).values()], visited, opened: Object.fromEntries(Object.entries(parsed.opened ?? {}).filter(([, value]) => typeof value === "string" && Number.isFinite(Date.parse(value)))) as Record<string, string> };
}
export function toggleHomePin(prefs: HomePreferences, target: HomeTarget): HomePreferences {
  const key = targetKey(target);
  return { ...prefs, pins: prefs.pins.some((item) => targetKey(item) === key) ? prefs.pins.filter((item) => targetKey(item) !== key) : [...prefs.pins, target] };
}
export function recordHomeOpen(prefs: HomePreferences, target: HomeTarget, now: string): HomePreferences {
  const opened = Object.fromEntries(Object.entries({ ...prefs.opened, [targetKey(target)]: now }).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 100));
  const visited = [target, ...prefs.visited.filter((item) => targetKey(item) !== targetKey(target))].filter((item) => !!opened[targetKey(item)]).slice(0, 100);
  return { ...prefs, opened, visited };
}
export function homeEntries(conversations: Conversation[], projects: Project[], resources: Resource[], prefs: HomePreferences) {
  const candidates = [
    ...prefs.visited.map((item) => ({ ...item, time: prefs.opened[targetKey(item)] ?? "" })),
    ...conversations.map((item) => ({ kind: "conversation" as const, id: item.id, title: item.title, time: item.updated_at })),
    ...resources.map((item) => ({ kind: "resource" as const, id: item.id, title: item.name, time: item.created_at ?? "" })),
    ...projects.map((item) => ({ kind: "project" as const, id: item.id, title: item.name, time: "" })),
  ].map((item) => ({ ...item, time: [item.time, prefs.opened[targetKey(item)] ?? ""].sort((a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0)).at(-1)! }));
  const lookup = new Map(candidates.map((item) => [targetKey(item), item]));
  return {
    pins: prefs.pins.map((item) => lookup.get(targetKey(item)) ?? { ...item, time: prefs.opened[targetKey(item)] ?? "" }),
    recent: [...lookup.values()].filter((item) => item.time).sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || targetKey(a).localeCompare(targetKey(b))).slice(0, 10),
  };
}
