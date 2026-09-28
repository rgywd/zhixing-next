import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import {
  mergeById,
  normalizeServerUrl,
  request,
  type Assistant,
  type Agent,
  type Connection,
  type Conversation,
  type FinanceSummary,
  type MessageInput,
  type ModelCatalog,
  type Page,
  type Project,
  type ReasoningEffort,
  type Schedule,
  type ServiceStatus,
} from "./api";
import { ChatPanel } from "./ChatPanel";
import { AiHome } from "./AiHome";
import { AiDrawer } from "./AiDrawer";
import { FinancePage } from "./FinancePage";
import { ModelsPanel } from "./ModelsPanel";
import { HomePanel, LifePanel, ToolboxPanel, WorkPanel } from "./OverviewPanels";
import { SchedulesPanel } from "./SchedulesPanel";
import { ConnectionForm, SettingsPanel } from "./SettingsPanel";
import { AgentsPanel } from "./AgentsPanel";
import {
  draftKey,
  clearDraft,
  readConnection,
  removeConnection,
  saveDraft,
} from "./storage";
import { Button, colors, Field, humanError, s, timeLabel } from "./ui";

type Tab = "home" | "life" | "chat" | "work" | "toolbox";

export default function AssistantApp() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    readConnection()
      .then((value) => {
        if (active && value) {
          normalizeServerUrl(value.url, __DEV__);
          setConnection(value);
        }
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  function connect(value: Connection) {
    setConnection(value);
    setGeneration((old) => old + 1);
    setError("");
  }
  async function disconnect() {
    try {
      await removeConnection();
      setConnection(null);
      setGeneration((old) => old + 1);
    } catch (e) {
      setError(humanError(e));
    }
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          style={s.body}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {!ready ? (
            <ActivityIndicator style={s.body} color={colors.accent} />
          ) : connection ? (
            <Connected
              key={generation}
              connection={connection}
              onConnect={connect}
              onDisconnect={() => {
                void disconnect();
              }}
              connectionError={error}
            />
          ) : (
            <DisconnectedShell onConnect={connect} error={error} />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function BottomTabs({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  return (
    <View style={s.tabs}>
      {(
        [
          { id: "home", label: "首页", icon: "home-outline" },
          { id: "life", label: "生活", icon: "leaf-outline" },
          { id: "chat", label: "AI", icon: null },
          { id: "work", label: "工作", icon: "briefcase-outline" },
          { id: "toolbox", label: "工具箱", icon: "grid-outline" },
        ] as const
      ).map((item) => (
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: value === item.id }}
          key={item.id}
          onPress={() => onChange(item.id)}
          style={[s.tab, item.id === "chat" ? s.aiTab : value === item.id && s.activeTab]}
        >
          {item.id === "chat" ? (
            <View style={[s.aiButton, value === "chat" && s.activeAiButton]}>
              <Text style={s.aiButtonText}>AI</Text>
            </View>
          ) : (
            <>
              <Ionicons name={item.icon!} size={23} color={value === item.id ? colors.accent : colors.muted} />
              <Text style={[s.tabText, value === item.id && s.activeTabText]}>
                {item.label}
              </Text>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
}

function DisconnectedShell({ onConnect, error }: { onConnect: (value: Connection) => void; error: string }) {
  const [tab, setTab] = useState<Tab>("home");
  const [lifeView, setLifeView] = useState<"overview" | "finance">("overview");
  useEffect(() => {
    if (tab !== "chat") return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { setTab("home"); return true; });
    return () => listener.remove();
  }, [tab]);
  return (
    <View style={s.body}>
      {tab === "home" ? (
        <HomePanel conversations={[]} onChat={() => setTab("chat")}
          onOpenConversation={() => setTab("chat")} onLife={() => setTab("life")}
          onWork={() => setTab("work")} />
      ) : tab === "life" ? (
        lifeView === "overview" ? (
          <LifePanel onFinance={() => setLifeView("finance")} finance={{ balances: [], recent: [] }} />
        ) : (
          <ScrollView contentContainerStyle={s.content}>
            <Button secondary small onPress={() => setLifeView("overview")}>‹ 生活</Button>
            <Text style={s.heading}>财务</Text>
            <Text style={s.muted}>连接服务后，可以在这里和财务助手聊。</Text>
            <Button onPress={() => setTab("chat")}>连接知行</Button>
          </ScrollView>
        )
      ) : tab === "work" ? (
        <WorkPanel conversations={[]} projects={[]} schedules={[]}
          onOpenConversation={() => setTab("chat")}
          onChooseConversation={() => setTab("chat")}
          onCreateProject={() => setTab("chat")}
          onSchedules={() => setTab("chat")} />
      ) : tab === "toolbox" ? (
        <ToolboxPanel onSettings={() => setTab("chat")} onAgents={() => setTab("chat")} onModels={() => setTab("chat")} />
      ) : (
        <View style={s.body}>
          <View style={[s.header, s.spread]}>
            <Text style={s.heading}>连接知行</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="返回首页" onPress={() => setTab("home")} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Ionicons name="close" size={26} color={colors.ink} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
            <Text style={s.muted}>连接后可以聊天、运行任务，并看到自己的真实资料。</Text>
            {error ? <Text style={s.error}>{error}</Text> : null}
            <ConnectionForm onConnect={onConnect} />
          </ScrollView>
        </View>
      )}
      {tab !== "chat" ? <BottomTabs value={tab} onChange={setTab} /> : null}
    </View>
  );
}

function Connected({
  connection,
  onConnect,
  onDisconnect,
  connectionError,
}: {
  connection: Connection;
  onConnect: (value: Connection) => void;
  onDisconnect: () => void;
  connectionError: string;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [returnTab, setReturnTab] = useState<Exclude<Tab, "chat">>("home");
  const [lifeView, setLifeView] = useState<"overview" | "finance">("overview");
  const [workView, setWorkView] = useState<"overview" | "schedules">("overview");
  const [toolView, setToolView] = useState<"overview" | "settings" | "agents" | "models">("overview");
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [finance, setFinance] = useState<FinanceSummary>({ balances: [], recent: [] });
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [financeId, setFinanceId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  const [conversationCursor, setConversationCursor] = useState<string | null>(
    null,
  );
  const [scheduleCursor, setScheduleCursor] = useState<string | null>(null);
  const [showConversations, setShowConversations] = useState(false);
  const [showAiDrawer, setShowAiDrawer] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeDraft, setWelcomeDraft] = useState("");
  const [welcomeKind, setWelcomeKind] = useState<"chat" | "task">("chat");
  const [welcomeModels, setWelcomeModels] = useState<{ chat: string | null; task: string | null }>({ chat: null, task: null });
  const [welcomeEfforts, setWelcomeEfforts] = useState<{ chat: ReasoningEffort | null; task: ReasoningEffort | null }>({ chat: null, task: null });
  const [welcomeSearchId, setWelcomeSearchId] = useState<string | null>(null);
  const [chatStart, setChatStart] = useState<{ id: string; kind: "chat" | "task"; taskModelId: string | null; taskEffort: ReasoningEffort | null; searchId: string | null; files: boolean } | null>(null);
  const [showProjectCreator, setShowProjectCreator] = useState(false);
  const [title, setTitle] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => undefined);
  const alive = useRef(true);
  const refresh = useCallback(() => refreshRef.current(), []);
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const selectedModel = catalog?.items.find((item) => item.id === (selected?.model_id ?? catalog.roles.chat));
  const financeConversation = conversations.find((item) => item.id === financeId) ?? null;
  useEffect(() => {
    if (tab !== "chat") return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { setTab(returnTab); return true; });
    return () => listener.remove();
  }, [tab, returnTab]);
  function openMainChat() {
    if (tab !== "chat") setReturnTab(tab);
    setShowWelcome(true);
    setTab("chat");
  }
  function selectTab(next: typeof tab) {
    if (next === "chat") openMainChat();
    else setTab(next);
    if (next === "life") setLifeView("overview");
    if (next === "work") setWorkView("overview");
    if (next === "toolbox") setToolView("overview");
  }
  function openConversation(id: string) {
    if (conversations.find((item) => item.id === id)?.agent_id === "finance") {
      setFinanceId(id);
      setLifeView("finance");
      setShowConversations(false);
      setShowAiDrawer(false);
      setTab("life");
      return;
    }
    setSelectedId(id);
    selectedRef.current = id;
    setShowConversations(false);
    setShowAiDrawer(false);
    setShowWelcome(false);
    if (tab !== "chat") setReturnTab(tab);
    setTab("chat");
    refresh();
  }
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    let polling = false;
    let initial = true;
    alive.current = true;
    const controller = new AbortController();
    async function poll() {
      if (!active || polling || AppState.currentState === "background") return;
      polling = true;
      try {
        const [health, person, chats, folders, plans, agentPage, financePage, modelPage, current] =
          await Promise.all([
            request<ServiceStatus>(connection, "/status", {
              signal: controller.signal,
            }),
            request<Assistant>(connection, "/assistant", {
              signal: controller.signal,
            }),
            request<Page<Conversation>>(
              connection,
              "/conversations?latest=true&limit=100",
              { signal: controller.signal },
            ),
            request<Page<Project>>(connection, "/projects?limit=100", {
              signal: controller.signal,
            }),
            request<Page<Schedule>>(connection, "/schedules?limit=100", {
              signal: controller.signal,
            }),
            request<Page<Agent>>(connection, "/agents", { signal: controller.signal }),
            request<FinanceSummary>(connection, "/finance/observations", { signal: controller.signal }),
            request<ModelCatalog>(connection, "/models", { signal: controller.signal }).catch(() => null),
            selectedRef.current
              ? request<Conversation>(
                  connection,
                  `/conversations/${selectedRef.current}`,
                  { signal: controller.signal },
                )
              : Promise.resolve(null),
          ]);
        if (!active) return;
        setStatus(health);
        setAssistant(person);
        setProjects(folders.items);
        setConversations((old) =>
          mergeById(old, [...chats.items, ...(current ? [current] : [])]),
        );
        setSchedules((old) => mergeById(old, plans.items));
        setAgents(agentPage.items);
        setFinance(financePage);
        if (modelPage) setCatalog(modelPage);
        if (initial) {
          setConversationCursor(chats.previous_cursor ?? null);
          setScheduleCursor(plans.next_cursor);
          initial = false;
        }
        setSelectedId(
          (old) => old ?? [...chats.items].reverse().find((item) => !item.agent_id)?.id ?? null,
        );
        setSyncError("");
      } catch (e) {
        if (active) {
          setSyncError(humanError(e));
          setStatus(null);
        }
      } finally {
        polling = false;
        if (active) setLoading(false);
      }
    }
    refreshRef.current = () => {
      void poll();
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 5000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
    });
    return () => {
      active = false;
      alive.current = false;
      clearInterval(timer);
      controller.abort();
      listener.remove();
    };
  }, [connection]);

  async function newConversation(
    explore = false,
    agentId: string | null = null,
    quick = false,
    initial?: { text: string; kind: "chat" | "task"; modelId: string | null; effort: ReasoningEffort | null; searchId: string | null; filesOnly?: boolean },
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let conversation = await request<Conversation>(
        connection,
        "/conversations",
        {
          method: "POST",
          body: {
            title: explore ? "认识运行环境" : agentId ? `${agents.find((item) => item.id === agentId)?.name ?? "助手"}对话` : initial ? initial.text.trim().split(/\r?\n/)[0].slice(0, 80) || "新的对话" : quick ? "新的对话" : title.trim() || "新的对话",
            project_id: explore || agentId || quick ? null : projectId,
            agent_id: agentId,
          },
        },
      );
      if (initial?.kind === "chat" && (initial.modelId || initial.effort)) {
        conversation = await request<Conversation>(connection, `/conversations/${conversation.id}/model`, {
          method: "PUT", body: { model_id: initial.modelId, reasoning_effort: initial.effort },
        });
      }
      if (initial?.filesOnly) {
        await saveDraft(draftKey(connection.url, conversation.id), { text: initial.text, pending: null });
      } else if (explore || initial) {
        const payload: MessageInput = {
          id: Crypto.randomUUID(),
          kind: explore ? "task" : initial!.kind,
          intent: "queue",
          content: explore
            ? "请只读探索你当前的运行环境：系统与架构、你实际可用的工具、当前项目工作目录和已授权额外目录。给出能做什么、尚缺什么与验证依据。不要读取凭据或扫描目录内容，不要修改文件、安装软件或调整系统；无法验证的能力明确标记为未知。"
            : initial!.text,
          ...(initial?.kind === "task" && initial.modelId ? { model_id: initial.modelId } : {}),
          ...(initial?.kind === "task" && initial.effort ? { reasoning_effort: initial.effort } : {}),
          ...(initial?.searchId ? { search_provider_id: initial.searchId } : {}),
        };
        const key = draftKey(connection.url, conversation.id);
        await saveDraft(key, { text: payload.content, pending: payload });
        try {
          await request(
            connection,
            `/conversations/${conversation.id}/messages`,
            { method: "POST", body: payload },
          );
          await clearDraft(key, payload.id);
        } catch {
          if (alive.current)
            setError(
              initial
                ? "消息提交尚未确认，原请求已保存到该会话草稿，可安全重试。"
                : "环境探索提交尚未确认，原请求已保存到该会话草稿，可安全重试。",
            );
        }
      }
      if (!alive.current) return;
      setConversations((old) => mergeById(old, [conversation]));
      if (agentId === "finance") {
        setFinanceId(conversation.id);
        setLifeView("finance");
      } else {
        setSelectedId(conversation.id);
        selectedRef.current = conversation.id;
      }
      setTitle("");
      setShowConversations(false);
      setShowAiDrawer(false);
      setShowWelcome(false);
      if (initial) setWelcomeDraft("");
      setChatStart(initial ? { id: conversation.id, kind: initial.kind, taskModelId: initial.kind === "task" ? initial.modelId : null, taskEffort: initial.kind === "task" ? initial.effort : null, searchId: initial.searchId, files: !!initial.filesOnly } : null);
      if (agentId !== "finance" && tab !== "chat") setReturnTab(tab);
      setTab(agentId === "finance" ? "life" : "chat");
      refresh();
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function submitWelcome() {
    const text = welcomeDraft.trim();
    if (text && !busy) void newConversation(false, null, true, { text, kind: welcomeKind, modelId: welcomeModels[welcomeKind], effort: welcomeEfforts[welcomeKind], searchId: welcomeSearchId });
  }
  const welcomeControls = {
    connection, catalog, modelId: welcomeModels[welcomeKind], effort: welcomeEfforts[welcomeKind], searchProviderId: welcomeSearchId,
    onModelId: (id: string | null) => setWelcomeModels((old) => ({ ...old, [welcomeKind]: id })),
    onEffort: (value: ReasoningEffort | null) => setWelcomeEfforts((old) => ({ ...old, [welcomeKind]: value })),
    onSearchProviderId: setWelcomeSearchId,
    onFiles: () => { if (!busy) void newConversation(false, null, true, { text: welcomeDraft, kind: welcomeKind, modelId: welcomeModels[welcomeKind], effort: welcomeEfforts[welcomeKind], searchId: welcomeSearchId, filesOnly: true }); },
  };
  function openAgent(agentId: string) {
    const existing = [...conversations].reverse().find((item) => item.agent_id === agentId);
    if (existing) openConversation(existing.id);
    else void newConversation(false, agentId);
  }
  function openFinance() {
    setLifeView("finance");
    const existing = [...conversations].reverse().find((item) => item.agent_id === "finance");
    if (existing) setFinanceId(existing.id);
    else void newConversation(false, "finance");
  }
  async function newProject(fromWork = false) {
    if (!projectName.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const project = await request<Project>(connection, "/projects", {
        method: "POST",
        body: { name: projectName.trim() },
      });
      if (alive.current) {
        setProjects((old) => mergeById(old, [project]));
        if (fromWork) setShowProjectCreator(false);
        else setProjectId(project.id);
        setProjectName("");
      }
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function loadMore(which: "conversations" | "schedules") {
    const cursor =
      which === "conversations" ? conversationCursor : scheduleCursor;
    if (!cursor || busy) return;
    setBusy(true);
    try {
      if (which === "conversations") {
        const page = await request<Page<Conversation>>(
          connection,
          `/conversations?before=${encodeURIComponent(cursor)}&limit=100`,
        );
        if (alive.current) {
          setConversations((old) => mergeById(page.items, old));
          setConversationCursor(page.previous_cursor ?? null);
        }
      } else {
        const page = await request<Page<Schedule>>(
          connection,
          `/schedules?cursor=${encodeURIComponent(cursor)}&limit=100`,
        );
        if (alive.current) {
          setSchedules((old) => mergeById(old, page.items));
          setScheduleCursor(page.next_cursor);
        }
      }
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <View style={s.body}>
      {syncError ? (
        <View style={[s.notice, { marginHorizontal: 18, marginBottom: 8 }]}>
          <Text style={s.noticeText}>{syncError}</Text>
          <Button secondary small onPress={refresh}>
            重新连接
          </Button>
        </View>
      ) : status && (!status.model_ready || !status.worker_online) ? (
        <View style={[s.notice, { marginHorizontal: 18, marginBottom: 8 }]}>
          <Text style={s.noticeText}>
            {!status.model_ready
              ? "服务已连接，模型尚未配置。请在服务器上设置模型后开始使用。"
              : "执行服务暂时离线。已接收任务会保留，等待 worker 恢复。"}
          </Text>
        </View>
      ) : null}
      {error || connectionError ? (
        <Text
          accessibilityRole="alert"
          style={[s.error, { marginHorizontal: 20, marginBottom: 8 }]}
        >
          {error || connectionError}
        </Text>
      ) : null}
      {tab === "home" ? (
        <HomePanel
          conversations={conversations}
          onChat={openMainChat}
          onOpenConversation={openConversation}
          onLife={() => selectTab("life")}
          onWork={() => selectTab("work")}
        />
      ) : tab === "life" ? (
        lifeView === "overview" ? (
          <LifePanel onFinance={openFinance} finance={finance} />
        ) : financeConversation ? (
          <FinancePage key={financeConversation.id} connection={connection} conversation={financeConversation} finance={finance} onBack={() => setLifeView("overview")} onRefresh={refresh} />
        ) : (
          <View style={[s.body, { padding: 22, gap: 18 }]}>
            <Button secondary small onPress={() => setLifeView("overview")}>‹ 生活</Button>
            <Text style={s.heading}>财务</Text>
            {busy ? <ActivityIndicator color={colors.accent} /> : <Button onPress={openFinance}>连接财务助手</Button>}
          </View>
        )
      ) : tab === "chat" ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 9, gap: 8 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={() => setShowAiDrawer(true)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="menu-outline" size={29} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={() => setShowAiDrawer(true)} style={s.grow}>
              <Text numberOfLines={1} style={[s.title, { textAlign: "center" }]}>{assistant?.name ?? "知行"}</Text>
              <Text numberOfLines={1} style={[s.muted, { textAlign: "center" }]}>
                {showWelcome ? "AI 伙伴" : selected?.title ?? "新的对话"}{!showWelcome && selectedModel ? ` · ${selectedModel.name}` : ""}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="新建对话" onPress={() => setShowWelcome(true)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="add" size={29} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="返回上一页" onPress={() => setTab(returnTab)} style={{ width: 38, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="close" size={26} color={colors.ink} />
            </Pressable>
          </View>
          {showWelcome ? (
            <AiHome name={assistant?.name ?? "知行"} draft={welcomeDraft} kind={welcomeKind} busy={busy} onDraft={setWelcomeDraft} onKind={setWelcomeKind} onSend={submitWelcome} {...welcomeControls} />
          ) : selected ? (
            <ChatPanel
              key={selected.id}
              connection={connection}
              conversation={selected}
              assistantName={agents.find((item) => item.id === selected.agent_id)?.name ?? assistant?.name ?? "知行"}
              catalog={catalog}
              initialKind={chatStart?.id === selected.id ? chatStart.kind : "chat"}
              initialTaskModelId={chatStart?.id === selected.id ? chatStart.taskModelId : null}
              initialTaskEffort={chatStart?.id === selected.id ? chatStart.taskEffort : null}
              initialSearchId={chatStart?.id === selected.id ? chatStart.searchId : null}
              startWithFiles={chatStart?.id === selected.id && chatStart.files}
              onFilesOpened={() => setChatStart((old) => old ? { ...old, files: false } : null)}
              onConversationChanged={(updated) => setConversations((old) => mergeById(old, [updated]))}
              onRefresh={refresh}
            />
          ) : <AiHome name={assistant?.name ?? "知行"} draft={welcomeDraft} kind={welcomeKind} busy={busy || loading} onDraft={setWelcomeDraft} onKind={setWelcomeKind} onSend={submitWelcome} {...welcomeControls} />}
        </>
      ) : tab === "work" ? (
        workView === "overview" ? (
          <WorkPanel
            conversations={conversations}
            projects={projects}
            schedules={schedules}
            onOpenConversation={openConversation}
            onChooseConversation={() => setShowConversations(true)}
            onCreateProject={() => { setError(""); setShowProjectCreator(true); }}
            onSchedules={() => setWorkView("schedules")}
          />
        ) : (
          <>
            <Pressable accessibilityRole="button" onPress={() => setWorkView("overview")} style={s.backLink}>
              <Text style={s.backLinkText}>‹ 返回工作</Text>
            </Pressable>
            <SchedulesPanel
              connection={connection}
              schedules={schedules}
              conversation={selected}
              conversationName={(id) =>
                conversations.find((item) => item.id === id)?.title ??
                `会话 ${id.slice(0, 8)}`
              }
              onRefresh={refresh}
              onChanged={(schedule) =>
                setSchedules((old) => mergeById(old, [schedule]))
              }
              hasMore={!!scheduleCursor}
              loadMore={() => {
                void loadMore("schedules");
              }}
            />
          </>
        )
      ) : toolView === "overview" ? (
        <ToolboxPanel onSettings={() => setToolView("settings")} onAgents={() => setToolView("agents")} onModels={() => setToolView("models")} />
      ) : (
        <>
          <Pressable accessibilityRole="button" onPress={() => setToolView("overview")} style={s.backLink}>
            <Text style={s.backLinkText}>‹ 返回工具箱</Text>
          </Pressable>
          {toolView === "agents" ? (
            <AgentsPanel connection={connection} agents={agents} onChanged={refresh} onChat={openAgent} onNewChat={(id) => { void newConversation(false, id); }} />
          ) : toolView === "models" ? (
            <ModelsPanel connection={connection} catalog={catalog} onCatalog={setCatalog} />
          ) : assistant ? (
            <SettingsPanel
              connection={connection}
              assistant={assistant}
              onAssistant={setAssistant}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onExplore={() => {
                void newConversation(true);
              }}
            />
          ) : (
            <ScrollView contentContainerStyle={s.content}>
              <Text style={s.title}>连接设置</Text>
              <Text style={s.muted}>服务连接恢复后，可以编辑人格设定。</Text>
              <Button secondary onPress={onDisconnect}>
                移除当前连接，重新设置
              </Button>
            </ScrollView>
          )}
        </>
      )}
      {tab !== "chat" ? <BottomTabs value={tab} onChange={selectTab} /> : null}
      <AiDrawer
        visible={showAiDrawer}
        name={assistant?.name ?? "知行"}
        conversations={conversations}
        selectedId={showWelcome ? null : selectedId}
        hasMore={!!conversationCursor}
        busy={busy}
        onClose={() => setShowAiDrawer(false)}
        onOpen={openConversation}
        onMore={() => { void loadMore("conversations"); }}
        onNew={() => { setShowWelcome(true); setShowAiDrawer(false); setTab("chat"); }}
        onSettings={() => { setShowAiDrawer(false); setToolView("settings"); setTab("toolbox"); }}
      />
      <Modal
        visible={showProjectCreator}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowProjectCreator(false)}
      >
        <SafeAreaView style={s.root}>
          <View style={s.header}>
            <Text style={[s.heading, s.grow]}>创建项目</Text>
            <Button secondary onPress={() => setShowProjectCreator(false)}>关闭</Button>
          </View>
          <View style={s.content}>
            <Text style={s.muted}>为相关对话、文件和任务留一个持久工作目录。</Text>
            <Field label="项目名称" placeholder="例如：我的项目" value={projectName} onChangeText={setProjectName} maxLength={100} />
            <Button disabled={busy || !projectName.trim()} onPress={() => { void newProject(true); }}>
              {busy ? "正在创建…" : "创建项目"}
            </Button>
            {error ? <Text style={s.error}>{error}</Text> : null}
          </View>
        </SafeAreaView>
      </Modal>
      <Modal
        visible={showConversations}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowConversations(false)}
      >
        <SafeAreaView style={s.root}>
          <View style={s.header}>
            <Text style={[s.heading, s.grow]}>你的对话</Text>
            <Button secondary onPress={() => setShowConversations(false)}>
              关闭
            </Button>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.content}
          >
            <View style={s.card}>
              <Text style={s.title}>留一个新的话题</Text>
              <Field
                label="对话名称"
                placeholder="例如：周末计划、游戏攻略"
                value={title}
                onChangeText={setTitle}
                maxLength={160}
              />
              <Text style={s.label}>工作项目（可选）</Text>
              <View style={s.wrap}>
                <Button
                  small
                  secondary={projectId !== null}
                  onPress={() => setProjectId(null)}
                >
                  日常对话
                </Button>
                {projects.map((project) => (
                  <Button
                    key={project.id}
                    small
                    secondary={projectId !== project.id}
                    onPress={() => setProjectId(project.id)}
                  >
                    {project.name}
                  </Button>
                ))}
              </View>
              <View style={s.row}>
                <View style={s.grow}>
                  <Field
                    label="创建持久工作目录"
                    placeholder="新项目名称"
                    value={projectName}
                    onChangeText={setProjectName}
                    maxLength={100}
                  />
                </View>
                <View style={{ paddingTop: 23 }}>
                  <Button
                    small
                    secondary
                    disabled={busy || !projectName.trim()}
                    onPress={() => {
                      void newProject();
                    }}
                  >
                    创建
                  </Button>
                </View>
              </View>
              {projectId ? (
                <Text selectable style={s.muted}>
                  {
                    projects.find((project) => project.id === projectId)
                      ?.workspace_path
                  }
                </Text>
              ) : null}
              <Button
                disabled={busy}
                onPress={() => {
                  void newConversation();
                }}
              >
                {busy ? "正在创建…" : "开启这段对话"}
              </Button>
              {error ? <Text style={s.error}>{error}</Text> : null}
            </View>
            <Text style={s.label}>已有的对话</Text>
            {[...conversations]
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .map((conversation) => (
                <Pressable
                  key={conversation.id}
                  accessibilityRole="button"
                  onPress={() => {
                    openConversation(conversation.id);
                  }}
                  style={[
                    s.card,
                    conversation.id === selectedId && {
                      backgroundColor: colors.pale,
                    },
                  ]}
                >
                  <Text style={s.title}>{conversation.title}</Text>
                  <Text style={s.muted}>
                    {timeLabel(conversation.updated_at)}
                    {conversation.blocked ? " · 队列等待继续" : ""}
                  </Text>
                </Pressable>
              ))}
            {conversationCursor ? (
              <Button
                secondary
                disabled={busy}
                onPress={() => {
                  void loadMore("conversations");
                }}
              >
                更早的对话
              </Button>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
