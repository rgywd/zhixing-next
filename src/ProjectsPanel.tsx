import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { mergeById, request, type Connection, type Conversation, type Page, type Project } from "./api";
import { ActionLink, ActionRow, Button, IconAction, PageHeading, PageScrollView, humanError, timeLabel, useUi } from "./ui";

export function ProjectsPanel({ connection, project, onOpenProject, onOpenConversation, onCreateProject, onNewConversation, onLoaded, onConversations, pinned, onTogglePin }: {
  connection: Connection; project: Project | null;
  onOpenProject: (project: Project) => void; onOpenConversation: (id: string) => void;
  onCreateProject: () => void; onNewConversation: () => void;
  onLoaded: (items: Project[]) => void; onConversations: (items: Conversation[]) => void;
  pinned: boolean; onTogglePin: () => void;
}) {
  const { s, colors } = useUi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const callbacks = useRef({ onLoaded, onConversations });
  useEffect(() => { callbacks.current = { onLoaded, onConversations }; }, [onLoaded, onConversations]);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    const path = project ? `/conversations?project_id=${encodeURIComponent(project.id)}&latest=true&limit=50` : "/projects?limit=50";
    request<Page<Project> | Page<Conversation>>(connection, path, { signal: controller.signal }).then((page) => {
      if (controller.signal.aborted) return;
      if (project) { setConversations((page.items as Conversation[]).filter((item) => item.project_id === project.id)); callbacks.current.onConversations(page.items as Conversation[]); }
      else { setProjects(page.items as Project[]); callbacks.current.onLoaded(page.items as Project[]); }
      setCursor(project ? page.previous_cursor ?? null : page.next_cursor);
    }).catch((e) => { if (!controller.signal.aborted) setError(humanError(e)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [connection, project, revision]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true); setError("");
    try {
      if (project) {
        const page = await request<Page<Conversation>>(connection, `/conversations?project_id=${encodeURIComponent(project.id)}&before=${encodeURIComponent(cursor)}&limit=50`);
        if (!alive.current) return;
        setConversations((old) => mergeById(old, page.items.filter((item) => item.project_id === project.id))); setCursor(page.previous_cursor ?? null); callbacks.current.onConversations(page.items);
      } else {
        const page = await request<Page<Project>>(connection, `/projects?cursor=${encodeURIComponent(cursor)}&limit=50`);
        if (!alive.current) return;
        setProjects((old) => mergeById(old, page.items)); setCursor(page.next_cursor); callbacks.current.onLoaded(page.items);
      }
    } catch (e) { if (alive.current) setError(humanError(e)); } finally { if (alive.current) setBusy(false); }
  }
  const ordered = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return <PageScrollView>
    <PageHeading title={project?.name ?? "全部项目"} description={project ? "相关对话放在一起，资料可以接着使用。" : "选择一个项目继续。"} action={project ? <IconAction icon={pinned ? "bookmark" : "bookmark-outline"} label={pinned ? "取消固定项目" : "固定项目到首页"} onPress={onTogglePin} /> : undefined} />
    <Button icon="add" onPress={project ? onNewConversation : onCreateProject}>{project ? "在项目中开始对话" : "创建项目"}</Button>
    {busy ? <ActivityIndicator color={colors.accent} /> : null}
    {error ? <View><Text accessibilityRole="alert" style={s.error}>{error}</Text><ActionLink icon="refresh-outline" onPress={() => { setError(""); setBusy(true); setRevision((old) => old + 1); }}>重新加载</ActionLink></View> : null}
    {project ? ordered.length ? <View style={s.card}>{ordered.map((item, index) => <ActionRow key={item.id} icon="chatbubble-outline" title={item.title} description={timeLabel(item.updated_at)} compact last={index === ordered.length - 1} onPress={() => onOpenConversation(item.id)} />)}</View> : !busy && !error ? <Text style={s.muted}>这个项目还没有对话，先从一件要做的事开始。</Text> : null : projects.length ? <View style={s.card}>{projects.map((item, index) => <ActionRow key={item.id} icon="folder-outline" title={item.name} compact last={index === projects.length - 1} tone="blue" onPress={() => onOpenProject(item)} />)}</View> : !busy && !error ? <Text style={s.muted}>还没有项目。</Text> : null}
    {cursor ? <ActionLink icon="chevron-down" disabled={busy} onPress={() => { void more(); }}>加载更多</ActionLink> : null}
  </PageScrollView>;
}
