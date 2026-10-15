import { availablePreference } from "./providerEditing";
import { ThemeProvider } from "./ThemeProvider";
import { AppearanceControl } from "./AppearanceControl";
import { useUi, ActionLink, BackLink, Button, humanError, PageHeading, PageScrollView, IconAction } from "./ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
  type MessageInput,
  type ModelCatalog,
  type Page,
  type ReasoningEffort,
  type Resource,
  type Run,
  type ServiceStatus,
} from "./api";
import { ConnectionStatusProvider, ServiceStatusNotice, useSyncStatus } from "./ConnectionStatus";
import { NoticeProvider } from "./Notice";
import { ChatPanel } from "./ChatPanel";
import { AiHome } from "./AiHome";
import { AiDrawer } from "./AiDrawer";
import { ResourcesPanel } from "./ResourcesPanel";
import { ModelsPanel } from "./ModelsPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { ResourcePreview } from "./ResourcePreview";
import { useHomePreferences } from "./useHomePreferences";
import { useWelcomeDraft } from "./useWelcomeDraft";
import { targetKey } from "./homeEntries";
import { HomePanel } from "./OverviewPanels";
import { FinanceDashboard } from "./FinanceDashboard";
import { HealthPage } from "./HealthPage";
import { LifeSummary } from "./LifeSummary";
import { LifePanel } from "./LifePanel";
import { ConstructionPage } from "./ConstructionPage";
import { useHealthReminders } from "./useHealthReminders";
import { ConnectionSettingsPanel, PersonaSettingsPanel } from "./SettingsPanel";
import { SettingsHome, type SettingsDestination } from "./SettingsHome";
import { SearchPicker } from "./SearchPicker";
import { AgentsPanel } from "./AgentsPanel";
import { DeviceCapabilitiesPanel } from "./DeviceCapabilitiesPanel";
import {
  draftKey,
  clearDraft,
  readConnection,
  removeConnection,
  saveDraft,
} from "./storage";

type Tab = "home" | "life" | "chat" | "work" | "settings";
type LifePage = "overview" | "finance" | "health";
type ChatReturn = { tab: Exclude<Tab, "chat">; lifePage: LifePage };

export default function AssistantApp() {
  return <ThemeProvider><ThemedApp /></ThemeProvider>;
}

function ThemedApp() {
  const { s, colors, mode, ready: themeReady } = useUi();
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
        <StatusBar style={mode === "dark" ? "light" : "dark"} animated />
        <KeyboardAvoidingView
          style={s.body}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <NoticeProvider>{!ready || !themeReady ? (
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
          )}</NoticeProvider>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function BottomTabs({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  const { s, colors } = useUi();
  return (
    <View pointerEvents="box-none" style={s.floatingTabs}>
      <View pointerEvents="none" style={s.tabs}>
        <Image accessible={false} source={require("../assets/navigation-notch.webp")} style={s.tabNotch} />
      </View>
      <View pointerEvents="box-none" style={s.tabItems}>
        {([
          { id: "home", label: "首页", icon: "home-outline" },
          { id: "life", label: "生活", icon: "leaf-outline" },
          { id: "chat", label: "知行", icon: null },
          { id: "work", label: "施工中", icon: "construct-outline" },
          { id: "settings", label: "设置", icon: "settings-outline" },
        ] as const).map((item) => (
          <Pressable
            accessibilityRole={item.id === "chat" ? "button" : "tab"}
            accessibilityLabel={item.label}
            accessibilityState={{ selected: value === item.id }}
            key={item.id}
            onPress={() => onChange(item.id)}
            style={({ pressed }) => [s.tab, item.id === "chat" ? s.aiTab : value === item.id && s.activeTab, pressed && s.pressed]}
          >
            {item.id === "chat" ? (
              <View style={s.aiButton}>
                <Image accessible={false} source={require("../assets/ai-radial.webp")} style={s.aiButtonIcon} />
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
    </View>
  );
}

function DisconnectedShell({ onConnect, error }: { onConnect: (value: Connection) => void; error: string }) {
  const { s } = useUi();
  const [tab, setTab] = useState<Tab>("home");
  const [lifePage, setLifePage] = useState<LifePage>("overview");
  const [localSettings, setLocalSettings] = useState<"overview" | "connection" | "device">("overview");
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true; }
      if (tab === "settings" && localSettings !== "overview") { setLocalSettings("overview"); return true; }
      if (tab === "life" && lifePage !== "overview") { setLifePage("overview"); return true; }
      if (tab !== "home") { setTab("home"); return true; }
      return false;
    });
    return () => listener.remove();
  }, [tab, localSettings, lifePage]);
  const connect = () => { setLocalSettings("connection"); setTab("settings"); };
  const selectTab = (next: Tab) => { setTab(next); if (next === "life") setLifePage("overview"); if (next === "settings") setLocalSettings("overview"); };
  const showTabs = (tab !== "life" || lifePage === "overview") && (tab !== "settings" || localSettings === "overview");
  return <View style={s.body}>
    {tab === "home" ? <HomePanel conversations={[]} onChat={connect} onOpenConversation={connect} onLife={() => selectTab("life")} onWork={() => selectTab("work")} />
      : tab === "work" ? <ConstructionPage />
      : tab === "life" ? lifePage === "overview" ? <LifePanel onFinance={() => setLifePage("finance")} onHealth={() => setLifePage("health")} onChat={connect} />
        : <><BackLink label="生活" onPress={() => setLifePage("overview")} /><PageScrollView><PageHeading title={lifePage === "finance" ? "财务" : "健康"} description="连接服务后，记录收支与饮食，继续自己的目标。" /><Button onPress={connect}>连接服务</Button></PageScrollView></>
      : tab === "settings" ? localSettings === "overview" ? <SettingsHome onOpen={(destination) => setLocalSettings(destination === "device" ? "device" : "connection")} />
        : <><BackLink label="设置" onPress={() => setLocalSettings("overview")} />{localSettings === "device" ? <DeviceCapabilitiesPanel /> : <ConnectionSettingsPanel onConnect={onConnect} />}</>
      : <PageScrollView tabs><PageHeading title="连接知行" description="连接服务后，和知行聊聊。" /><Button onPress={connect}>连接服务</Button></PageScrollView>}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {showTabs ? <BottomTabs value={tab} onChange={selectTab} /> : null}
  </View>;
}

function Connected(props: Parameters<typeof ConnectedSession>[0]) {
  return <ConnectionStatusProvider><ConnectedSession {...props} /></ConnectionStatusProvider>;
}

function ConnectedSession({
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
  const { s, colors } = useUi();
  const [tab, setTab] = useState<Tab>("home");
  const [lifePage, setLifePage] = useState<LifePage>("overview");
  const [chatReturn, setChatReturn] = useState<ChatReturn>({ tab: "home", lifePage: "overview" });
  const [settingsView, setSettingsView] = useState<"overview" | Exclude<SettingsDestination, "search">>("overview");
  const navigation = useRef(0);
  const [resourceReturnTab, setResourceReturnTab] = useState<Tab>("settings");
  const [recentResources, setRecentResources] = useState<Resource[]>([]);
  const [previewResource, setPreviewResource] = useState<Resource | null>(null);
  const home = useHomePreferences(connection.url);
  const [showSearchSettings, setShowSearchSettings] = useState(false);
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<{ conversationId: string; seq: number } | null>(null);
  const selectedRef = useRef(selectedId);
  const [conversationCursor, setConversationCursor] = useState<string | null>(
    null,
  );
  const [showAiDrawer, setShowAiDrawer] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const welcome = useWelcomeDraft(connection.url);
  const { text: welcomeDraft, models: welcomeModels, efforts: welcomeEfforts, searchId: welcomeSearchId } = welcome.value;
  const welcomeKind = "chat" as const;
  const { setText: setWelcomeDraft, setKind: setWelcomeKind, setSearch: setWelcomeSearchId } = welcome;
  const [chatStart, setChatStart] = useState<{ id: string; kind: "chat" | "task"; taskModelId: string | null; taskEffort: ReasoningEffort | null; searchId: string | null; files: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const creatingConversation = useRef(false);
  const creationReceipt = useRef<{ key: string; conversation: Conversation } | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const refreshRef = useRef<() => void>(() => undefined);
  const alive = useRef(true);
  const refresh = useCallback(() => refreshRef.current(), []);
  const reportSync = useSyncStatus(refresh);
  const [composerContext, setComposerContext] = useState<{ conversationId: string; modelId: string | null; kind: "chat" | "task" } | null>(null);
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const currentComposer = composerContext?.conversationId === selectedId ? composerContext : null;
  const selectedModel = catalog?.items.find((item) => item.id === (currentComposer ? currentComposer.modelId : selected?.model_id ?? catalog.roles.chat));
  const [serviceVersion, setServiceVersion] = useState(0);
  const observedRunStates = useRef(new Map<string, Run["status"]>());
  const showTabs = tab !== "chat" && (tab !== "life" || lifePage === "overview") && (tab !== "settings" || settingsView === "overview");
  useHealthReminders(connection, serviceVersion, () => openLifePage("health"));
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      navigation.current++;
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true; }
      if (tab === "chat") { setTab(chatReturn.tab); setLifePage(chatReturn.lifePage); return true; }
      if (tab === "settings" && settingsView !== "overview") { setSettingsView("overview"); if (settingsView === "resources") setTab(resourceReturnTab); return true; }
      if (tab === "life" && lifePage !== "overview") { setLifePage("overview"); return true; }
      if (tab !== "home") { setTab("home"); return true; }
      return false;
    });
    return () => listener.remove();
  }, [tab, chatReturn, lifePage, settingsView, resourceReturnTab]);
  function closeChat() {
    navigation.current++;
    setTab(chatReturn.tab);
    setLifePage(chatReturn.lifePage);
  }
  function openLifePage(page: LifePage) {
    navigation.current++;
    setLifePage(page);
    setTab("life");
  }
  function openMainChat() {
    navigation.current++;
    if (tab !== "chat") setChatReturn({ tab, lifePage });
    setShowWelcome(true);
    setTab("chat");
  }
  function selectTab(next: typeof tab) {
    navigation.current++;
    if (next === "chat") openMainChat();
    else setTab(next);
    if (next === "life") setLifePage("overview");
    if (next === "settings") setSettingsView("overview");
  }
  async function openConversation(id: string, messageSeq?: number) {
    const requestId = ++navigation.current;
    let target = conversations.find((item) => item.id === id);
    if (!target) {
      try {
        const fetched = await request<Conversation>(connection, `/conversations/${id}`);
        if (!alive.current || requestId !== navigation.current) return;
        target = fetched;
        setConversations((old) => mergeById(old, [fetched]));
      } catch (e) { if (alive.current && requestId === navigation.current) setError(humanError(e)); return; }
    }
    home.opened({ kind: "conversation", id, title: target.title });
    setFocusMessage(messageSeq ? { conversationId: id, seq: messageSeq } : null);
    setSelectedId(id);
    selectedRef.current = id;
    setShowAiDrawer(false);
    setShowWelcome(false);
    if (tab !== "chat") setChatReturn({ tab, lifePage });
    setTab("chat");
    refresh();
  }
  function openResources() { navigation.current++; setResourceReturnTab(tab); setSettingsView("resources"); setTab("settings"); }
  async function openResource(id: string) {
    const requestId = ++navigation.current;
    try {
      const item = recentResources.find((resource) => resource.id === id) ?? await request<Resource>(connection, `/resources/${id}`);
      if (!alive.current || requestId !== navigation.current) return;
      home.opened({ kind: "resource", id, title: item.name });
      setPreviewResource(item);
    } catch (e) { if (alive.current && requestId === navigation.current) setError(humanError(e)); }
  }
  function focusHandled(seq: number) { setFocusMessage((old) => old?.seq === seq ? null : old); }
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
        const [health, person, chats, agentPage, modelPage, current, resources, recentChats] = await Promise.all([
          request<ServiceStatus>(connection, "/status", { signal: controller.signal }),
          request<Assistant>(connection, "/assistant", { signal: controller.signal }),
          request<Page<Conversation>>(connection, "/conversations?latest=true&limit=100", { signal: controller.signal }),
          request<Page<Agent>>(connection, "/agents", { signal: controller.signal }),
          request<ModelCatalog>(connection, "/models", { signal: controller.signal }).catch(() => null),
          selectedRef.current ? request<Conversation>(connection, `/conversations/${selectedRef.current}`, { signal: controller.signal }) : Promise.resolve(null),
          request<Page<Resource>>(connection, "/resources?latest=true&limit=10", { signal: controller.signal }).catch(() => null),
          request<Page<Conversation>>(connection, "/conversations/recent?limit=10", { signal: controller.signal }).catch(() => null),
        ]);
        if (!active) return;
        setStatus(health);
        setAssistant(person);
        if (resources) setRecentResources(resources.items);
        setConversations((old) =>
          mergeById(old, [...chats.items, ...(recentChats?.items ?? []), ...(current ? [current] : [])]),
        );
        setAgents(agentPage.items);
        if (modelPage) setCatalog(modelPage);
        if (initial) {
          setConversationCursor(chats.previous_cursor ?? null);
          initial = false;
        }
        setSelectedId(
          (old) => old ?? [...chats.items].reverse().find((item) => !item.agent_id)?.id ?? null,
        );
        reportSync();
      } catch (e) {
        if (active) {
          reportSync(e);
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
  }, [connection, reportSync]);

  async function newConversation(
    explore = false,
    agentId: string | null = null,
    quick = false,
    initial?: { text: string; kind: "chat" | "task"; modelId: string | null; effort: ReasoningEffort | null; searchId: string | null; filesOnly?: boolean },
  ) {
    if (creatingConversation.current || busy) return;
    creatingConversation.current = true;
    setBusy(true);
    setError("");
    try {
      const body = {
        title: explore ? "认识运行环境" : agentId ? `${agents.find((item) => item.id === agentId)?.name ?? "助手"}对话` : initial ? initial.text.trim().split(/\r?\n/)[0].slice(0, 80) || "新的对话" : quick ? "新的对话" : "新的对话",
        project_id: null,
        agent_id: agentId,
      };
      const creationKey = JSON.stringify(body);
      // Reuse a received creation receipt if a later model/draft step failed.
      const reusing = creationReceipt.current?.key === creationKey;
      let conversation = reusing ? creationReceipt.current!.conversation
        : await request<Conversation>(connection, "/conversations", { method: "POST", body });
      creationReceipt.current = { key: creationKey, conversation };
      if (initial?.kind === "chat" && (reusing || initial.modelId || initial.effort)) {
        conversation = await request<Conversation>(connection, `/conversations/${conversation.id}/model`, {
          method: "PUT", body: { model_id: initial.modelId, reasoning_effort: initial.effort },
        });
      }
      if (initial?.filesOnly) {
        await saveDraft(draftKey(connection.url, conversation.id), { text: initial.text, pending: null });
        await welcome.consumeText(initial.text);
      } else if (explore || initial) {
        const payload: MessageInput = {
          id: Crypto.randomUUID(),
          kind: "chat",
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
        if (initial && !agentId) await welcome.consumeText(initial.text);
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
      creationReceipt.current = null;
      setConversations((old) => mergeById(old, [conversation]));
      setSelectedId(conversation.id);
      selectedRef.current = conversation.id;
      setShowAiDrawer(false);
      setShowWelcome(false);
      setChatStart(initial ? { id: conversation.id, kind: initial.kind, taskModelId: initial.kind === "task" ? initial.modelId : null, taskEffort: initial.kind === "task" ? initial.effort : null, searchId: initial.searchId, files: !!initial.filesOnly } : null);
      if (tab !== "chat") setChatReturn({ tab, lifePage });
      setTab("chat");
      refresh();
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      creatingConversation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const welcomePreference = availablePreference(catalog, welcomeKind, welcomeModels[welcomeKind], welcomeEfforts[welcomeKind]);
  function submitWelcome() {
    const text = welcomeDraft.trim();
    if (text && welcome.ready && !busy) void newConversation(false, null, true, { text, kind: welcomeKind, modelId: welcomePreference.modelId, effort: welcomePreference.effort, searchId: welcomeSearchId });
  }
  const welcomeControls = {
    connection, catalog, modelId: welcomePreference.modelId, effort: welcomePreference.effort, searchProviderId: welcomeSearchId,
    draftReady: welcome.ready, draftError: welcome.error, onRetryDraft: welcome.retry,
    onModelId: (id: string | null) => welcome.setModel(welcomeKind, id),
    onEffort: (value: ReasoningEffort | null) => welcome.setEffort(welcomeKind, value),
    onSearchProviderId: setWelcomeSearchId,
    onFiles: () => { if (welcome.ready && !busy) void newConversation(false, null, true, { text: welcomeDraft, kind: welcomeKind, modelId: welcomePreference.modelId, effort: welcomePreference.effort, searchId: welcomeSearchId, filesOnly: true }); },
  };
  function openAgent(agentId: string) {
    const existing = [...conversations].reverse().find((item) => item.agent_id === agentId);
    if (existing) openConversation(existing.id);
    else void newConversation(false, agentId);
  }
  const serviceChanged = useCallback(() => { setServiceVersion((old) => old + 1); refresh(); }, [refresh]);
  const chatRunsChanged = useCallback((runs: Run[]) => {
    let settled = false;
    for (const run of runs) {
      const previous = observedRunStates.current.get(run.id);
      observedRunStates.current.set(run.id, run.status);
      // A failed/cancelled response can still have completed service writes.
      if (previous !== run.status && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) settled = true;
    }
    if (settled) serviceChanged();
  }, [serviceChanged]);
  function lifeChat(prompt: string) {
    setWelcomeDraft((old) => `${old.trimEnd()}${old.trim() ? "\n\n" : ""}${prompt}`);
    openMainChat();
  }
  function serviceChat(agentId: string, prompt?: string) {
    if (prompt) void newConversation(false, agentId, true, { text: prompt, kind: "chat", modelId: null, effort: null, searchId: null });
    else openAgent(agentId);
  }
  async function loadMore() {
    if (!conversationCursor || busy) return;
    setBusy(true);
    try {
      const page = await request<Page<Conversation>>(connection, `/conversations?before=${encodeURIComponent(conversationCursor)}&limit=100`);
      if (alive.current) { setConversations((old) => mergeById(page.items, old)); setConversationCursor(page.previous_cursor ?? null); }
    } catch (e) { if (alive.current) setError(humanError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return (
    <View style={s.body}>
      <ServiceStatusNotice status={status} />
      {error || connectionError ? (
        <Text
          accessibilityRole="alert"
          style={[s.error, { marginHorizontal: 20, marginBottom: 8 }]}
        >
          {error || connectionError}
        </Text>
      ) : null}
      {tab === "home" ? (
        <HomePanel conversations={conversations} resources={recentResources}
          preferences={{ ...home.preferences, pins: home.preferences.pins.filter((item) => item.kind !== "project"), visited: home.preferences.visited?.filter((item) => item.kind !== "project") ?? [] }}
          preferencesReady={home.ready} preferenceError={home.error} onPreferenceRetry={home.retry} onTogglePin={home.toggle}
          onOpenResource={openResource} onResources={openResources} onChat={openMainChat} onOpenConversation={openConversation}
          onLife={() => selectTab("life")} onWork={() => selectTab("work")} />
      ) : tab === "work" ? (
        <ConstructionPage />
      ) : tab === "life" ? lifePage === "overview" ? (
        <LifePanel onFinance={() => openLifePage("finance")} onHealth={() => openLifePage("health")} onChat={lifeChat}
          intro={<LifeSummary connection={connection} refreshKey={serviceVersion} onFinance={() => openLifePage("finance")} onHealth={() => openLifePage("health")} />} />
      ) : lifePage === "finance" ? (
        <FinanceDashboard connection={connection} onBack={() => openLifePage("overview")} onChat={(prompt) => serviceChat("finance", prompt)} onChanged={serviceChanged} refreshKey={serviceVersion} />
      ) : (
        <HealthPage connection={connection} onBack={() => openLifePage("overview")} onChat={(prompt) => serviceChat("health", prompt)} onChanged={serviceChanged} refreshKey={serviceVersion} />
      ) : tab === "chat" ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 5, gap: 5 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={() => setShowAiDrawer(true)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="menu-outline" size={25} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={() => setShowAiDrawer(true)} style={s.grow}>
              <Text numberOfLines={1} style={[s.itemTitle, { textAlign: "left" }]}>{showWelcome ? assistant?.name ?? "知行" : selected?.title ?? "新的对话"}</Text>
              <Text numberOfLines={1} style={[s.muted, { textAlign: "left" }]}>
                {showWelcome ? "随时聊聊，把事情做成" : `${currentComposer?.kind === "task" ? "任务 · " : ""}${selectedModel?.name ?? "知行"}`}
              </Text>
            </Pressable>
            {!showWelcome && selected ? <IconAction icon={home.preferences.pins.some((item) => targetKey(item) === `conversation:${selected.id}`) ? "bookmark" : "bookmark-outline"} label="固定或取消固定此对话" disabled={!home.ready} onPress={() => home.toggle({ kind: "conversation", id: selected.id, title: selected.title })} /> : null}
            <AppearanceControl />
            <Pressable accessibilityRole="button" accessibilityLabel="新建对话" onPress={() => setShowWelcome(true)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="create-outline" size={23} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="返回上一页" onPress={closeChat} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="close" size={22} color={colors.ink} />
            </Pressable>
          </View>
          {showWelcome ? (
            <AiHome name={assistant?.name ?? "知行"} draft={welcomeDraft} kind={welcomeKind} busy={busy} onDraft={setWelcomeDraft} onKind={setWelcomeKind} onSend={submitWelcome} {...welcomeControls} />
          ) : selected ? (
            <ChatPanel
              key={selected.id}
              connection={connection}
              conversation={selected}
              focusMessageSeq={focusMessage?.conversationId === selected.id ? focusMessage.seq : null}
              onFocusHandled={focusHandled}
              assistantName={agents.find((item) => item.id === selected.agent_id)?.name ?? assistant?.name ?? "知行"}
              catalog={catalog}
              agentModelId={agents.find((item) => item.id === selected.agent_id)?.model_id ?? null}
              initialKind={chatStart?.id === selected.id ? chatStart.kind : "chat"}
              initialTaskModelId={chatStart?.id === selected.id ? chatStart.taskModelId : null}
              initialTaskEffort={chatStart?.id === selected.id ? chatStart.taskEffort : null}
              initialSearchId={chatStart?.id === selected.id ? chatStart.searchId : null}
              startWithFiles={chatStart?.id === selected.id && chatStart.files}
              onFilesOpened={() => setChatStart((old) => old ? { ...old, files: false } : null)}
              onConversationChanged={(updated) => setConversations((old) => mergeById(old, [updated]))}
              onComposerContext={setComposerContext}
              onRefresh={refresh}
              onRunsChanged={chatRunsChanged}
            />
          ) : <AiHome name={assistant?.name ?? "知行"} draft={welcomeDraft} kind={welcomeKind} busy={busy || loading} onDraft={setWelcomeDraft} onKind={setWelcomeKind} onSend={submitWelcome} {...welcomeControls} />}
        </>
      ) : settingsView === "overview" ? (
        <SettingsHome assistant={assistant} catalog={catalog} connectionUrl={connection.url} onOpen={(destination) => {
          if (destination === "search") setShowSearchSettings(true);
          else { if (destination === "resources") setResourceReturnTab("settings"); setSettingsView(destination); }
        }} />
      ) : (
        <>
          <BackLink label={settingsView === "resources" && resourceReturnTab === "home" ? "首页" : "设置"} onPress={() => { navigation.current++; setSettingsView("overview"); if (settingsView === "resources") setTab(resourceReturnTab); }} />
          {settingsView === "device" ? (
            <DeviceCapabilitiesPanel onUseLocation={(text) => {
              setWelcomeDraft((old) => `${old.trimEnd()}${old.trim() ? "\n\n" : ""}${text}\n\n`);
              setShowWelcome(true); setChatReturn({ tab: "settings", lifePage }); setTab("chat");
            }} />
          ) : settingsView === "agents" ? (
            <AgentsPanel connection={connection} agents={agents} onChanged={refresh} onChat={openAgent} onNewChat={(id) => { void newConversation(false, id); }} />
          ) : settingsView === "models" ? (
            <ModelsPanel connection={connection} catalog={catalog} onCatalog={setCatalog} />
          ) : settingsView === "providers" ? (
            <ProvidersPanel connection={connection} catalog={catalog} onCatalog={setCatalog} />
          ) : settingsView === "resources" ? (
            <ResourcesPanel connection={connection} onOpenConversation={openConversation} />
          ) : settingsView === "connection" ? (
            <ConnectionSettingsPanel connection={connection} onConnect={onConnect} onDisconnect={onDisconnect} onExplore={() => { void newConversation(true); }} />
          ) : assistant ? (
            <PersonaSettingsPanel connection={connection} assistant={assistant} onAssistant={setAssistant} />
          ) : (
            <PageScrollView>
              <PageHeading title="人格偏好" description="暂时无法读取人格设定，连接恢复后可继续编辑。" />
              <ActionLink icon="refresh-outline" onPress={refresh}>重新加载</ActionLink>
            </PageScrollView>
          )}
        </>
      )}
      {showTabs && !keyboardVisible ? <BottomTabs value={tab} onChange={selectTab} /> : null}
      <AiDrawer
        visible={showAiDrawer}
        connection={connection}
        name={assistant?.name ?? "知行"}
        conversations={conversations}
        selectedId={showWelcome ? null : selectedId}
        hasMore={!!conversationCursor}
        busy={busy}
        onClose={() => setShowAiDrawer(false)}
        onOpen={openConversation}
        onMore={() => { void loadMore(); }}
        onNew={() => { setShowAiDrawer(false); openMainChat(); }}
      />
      <ResourcePreview connection={connection} resource={previewResource} onClose={() => setPreviewResource(null)} />
      <SearchPicker visible={showSearchSettings} connection={connection} management selectedId={welcomeSearchId} onSelect={setWelcomeSearchId}
        onRemoved={(id) => setChatStart((old) => old?.searchId === id ? { ...old, searchId: null } : old)} onClose={() => setShowSearchSettings(false)} />

    </View>
  );
}
