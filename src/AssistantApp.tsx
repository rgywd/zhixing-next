import { availablePreference } from "./providerEditing";
import { useSessionData } from "./useSessionData";
import { ThemeProvider } from "./ThemeProvider";
import { AgentChatHeader } from "./AgentChatHeader";
import { ConversationMenu } from "./ConversationMenu";
import { ChatSettingsPanel } from "./ChatSettingsPanel";
import { useDshSettings } from "./useDshSettings";
import { useUi, BackLink, Button, humanError, PageHeading, PageScrollView } from "./ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  type Connection,
  type DraftPhoto,
  type Conversation,
  type MessageInput,
  type Page,
  type ReasoningEffort,
} from "./api";
import { ConnectionStatusProvider, ServiceStatusNotice } from "./ConnectionStatus";
import { NoticeProvider } from "./Notice";
import { DshChatPanel, DshHostSettings } from "./DshChatPanel";
import { AiHome } from "./AiHome";
import { AiDrawer } from "./AiDrawer";
import { useHomePreferences } from "./useHomePreferences";
import { useWelcomeDraft } from "./useWelcomeDraft";
import type { DshPermission } from "./dshPermissions";
import { usePhotoPicker } from "./usePhotoPicker";
import { targetKey } from "./homeEntries";
import { TodayHomePanel as HomePanel } from "./TodayHomePanel";
import { useTodayDeviceContext } from "./useTodayDeviceContext";
import { FinanceDashboard } from "./FinanceDashboard";
import { HealthPage } from "./HealthPage";
import { LifeSummary } from "./LifeSummary";
import { LifePanel } from "./LifePanel";
import { ConstructionPage } from "./ConstructionPage";
import { useHealthReminders } from "./useHealthReminders";
import { ConnectionSettingsPanel } from "./SettingsPanel";
import { SettingsHome, type SettingsDestination } from "./SettingsHome";
import { PasswordVaultPanel } from "./PasswordVaultPanel";
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
  const todayDevice = useTodayDeviceContext(tab === "home");
  const [lifePage, setLifePage] = useState<LifePage>("overview");
  const [localSettings, setLocalSettings] = useState<"overview" | "connection" | "device" | "vault" | "chat">("overview");
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (tab === "settings" && localSettings === "vault") return false;
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
    {tab === "home" ? <HomePanel device={todayDevice} conversations={[]} promptReady={false} onOpenConversation={connect} onLife={() => selectTab("life")} onWork={() => selectTab("work")}
      onFinance={() => { setLifePage("finance"); setTab("life"); }} onHealth={() => { setLifePage("health"); setTab("life"); }} />
      : tab === "work" ? <ConstructionPage />
      : tab === "life" ? lifePage === "overview" ? <LifePanel onFinance={() => setLifePage("finance")} onHealth={() => setLifePage("health")} onChat={connect} />
        : <><BackLink label="生活" onPress={() => setLifePage("overview")} /><PageScrollView><PageHeading title={lifePage === "finance" ? "财务" : "健康"} description="连接服务后，记录收支与饮食，继续自己的目标。" /><Button onPress={connect}>连接服务</Button></PageScrollView></>
      : tab === "settings" ? localSettings === "overview" ? <SettingsHome onOpen={(destination) => setLocalSettings(destination === "device" || destination === "vault" || destination === "chat" ? destination : "connection")} />
        : localSettings === "vault" ? <PasswordVaultPanel onBack={() => setLocalSettings("overview")} />
        : <><BackLink label="设置" onPress={() => setLocalSettings("overview")} />{localSettings === "device" ? <DeviceCapabilitiesPanel /> : localSettings === "chat" ? <ChatSettingsPanel /> : <ConnectionSettingsPanel onConnect={onConnect} />}</>
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
  const { s } = useUi();
  const [tab, setTab] = useState<Tab>("home");
  const todayDevice = useTodayDeviceContext(tab === "home");
  const [lifePage, setLifePage] = useState<LifePage>("overview");
  const [chatReturn, setChatReturn] = useState<ChatReturn>({ tab: "home", lifePage: "overview" });
  const [settingsView, setSettingsView] = useState<"overview" | SettingsDestination>("overview");
  const navigation = useRef(0);
  const home = useHomePreferences(connection.url);
  const dshSettings = useDshSettings(connection);
  const { assistant, status, lastSyncFailed, conversations, setConversations, removeConversation, agents, catalog,
     selectedId, setSelectedId, selectedRef, conversationCursor, setConversationCursor, loading, refresh, alive } = useSessionData(connection);
  const [focusMessage, setFocusMessage] = useState<{ conversationId: string; seq: number; version?: string } | null>(null);
  const [showAiDrawer, setShowAiDrawer] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [chatMenuTop, setChatMenuTop] = useState(64);
  const [chatAction, setChatAction] = useState<{ conversationId: string; id: number; type: "share" | "search" } | null>(null);
  const chatActionId = useRef(0);

  const [chatSettingsFor, setChatSettingsFor] = useState<string | null>(null);
  const [chatFilesFor, setChatFilesFor] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const welcome = useWelcomeDraft(connection.url);
  const { text: welcomeDraft, models: welcomeModels, efforts: welcomeEfforts } = welcome.value;
  const welcomeKind = "chat" as const;
  const { setText: setWelcomeDraft, setKind: setWelcomeKind } = welcome;
  const [chatStart, setChatStart] = useState<{ id: string; kind: "chat" | "task"; taskModelId: string | null; taskEffort: ReasoningEffort | null; searchId: string | null; files: boolean; send?: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const welcomePhotoPicker = usePhotoPicker({ scope: `${connection.url}\n${connection.token}\nwelcome`,
    ids: (welcome.value.photos ?? []).map((photo) => photo.id), locked: !welcome.ready || busy,
    add: welcome.addPhotos, onError: setError, maxAttachments: null });
  const creatingConversation = useRef(false);
  const creationReceipt = useRef<{ key: string; conversation: Conversation } | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const selectedAgent = agents.find((item) => item.id === selected?.agent_id);
  const chatAssistantName = selected?.agent_id ? selectedAgent?.name ?? (selected.agent_id === "finance" ? "财务助手" : selected.agent_id === "health" ? "健康助手" : "专属助手") : assistant?.name ?? "知行";
  const [serviceVersion, setServiceVersion] = useState(0);
  const showTabs = tab !== "chat" && (tab !== "life" || lifePage === "overview") && (tab !== "settings" || settingsView === "overview");
  const chatMenuScope = `${tab}:${selectedId ?? ""}:${showWelcome}`;
  const [previousChatMenuScope, setPreviousChatMenuScope] = useState(chatMenuScope);
  if (previousChatMenuScope !== chatMenuScope) {
    setPreviousChatMenuScope(chatMenuScope);
    setChatSettingsFor(null);
    setChatFilesFor(null);
    setChatMenuOpen(false);
  }
  useHealthReminders(connection, serviceVersion, () => openLifePage("health"));
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (tab === "settings" && settingsView === "vault") return false;
      navigation.current++;
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true; }
      if (tab === "chat") { setTab(chatReturn.tab); setLifePage(chatReturn.lifePage); return true; }
      if (tab === "settings" && settingsView !== "overview") { setSettingsView("overview"); return true; }
      if (tab === "life" && lifePage !== "overview") { setLifePage("overview"); return true; }
      if (tab !== "home") { setTab("home"); return true; }
      return false;
    });
    return () => listener.remove();
  }, [tab, chatReturn, lifePage, settingsView]);
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
    if (next === "settings") { setSettingsView("overview"); }
  }
  async function openConversation(id: string, messageSeq?: number, version?: string) {
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
    setFocusMessage(messageSeq != null ? { conversationId: id, seq: messageSeq, version } : null);
    setSelectedId(id);
    selectedRef.current = id;
    setShowAiDrawer(false);
    setShowWelcome(false);
    if (tab !== "chat") setChatReturn({ tab, lifePage });
    setTab("chat");
    refresh();
  }
  function focusHandled(seq: number) { setFocusMessage((old) => old?.seq === seq ? null : old); }

  async function newConversation(
    explore = false,
    agentId: string | null = null,
    quick = false,
    initial?: { text: string; kind: "chat" | "task"; modelId: string | null; effort: ReasoningEffort | null; searchId: string | null; filesOnly?: boolean; photos?: DraftPhoto[] },
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
        ...(initial && !agentId && welcome.value.permission ? { permission: welcome.value.permission } : {}),
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
      if (initial?.filesOnly || initial?.photos?.length) {
        await saveDraft(draftKey(connection.url, conversation.id), { text: initial.text, photos: initial.photos, pending: null });
        await welcome.consumeText(initial.text, initial.photos?.map((photo) => photo.id));
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
      setChatStart(initial ? { id: conversation.id, kind: initial.kind, taskModelId: initial.kind === "task" ? initial.modelId : null, taskEffort: initial.kind === "task" ? initial.effort : null, searchId: initial.searchId, files: !!initial.filesOnly, send: !initial.filesOnly && !!initial.photos?.length } : null);
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
  const welcomeModel = catalog?.items.find((item) => item.id === (welcomePreference.modelId ?? catalog.roles.chat));
  const welcomeStatus = lastSyncFailed ? "重新连接" : !status || !catalog ? "连接中" : !status.worker_online ? "服务离线" : (!welcomePreference.modelId && !status.model_ready) || !welcomeModel?.ready ? "未就绪" : busy ? "处理中" : "待命中";
  function submitWelcome() {
    const text = welcomeDraft.trim();
    if ((text || welcome.value.photos?.length) && welcome.ready && !busy && !welcomePhotoPicker.picking) void newConversation(false, null, true, { text, photos: welcome.value.photos, kind: welcomeKind, modelId: welcomePreference.modelId, effort: welcomePreference.effort, searchId: null });
  }
  const welcomeControls = {
    connection, catalog, modelId: welcomePreference.modelId, effort: welcomePreference.effort,
    permissions: status?.permissions ? { ...status.permissions, current: welcome.value.permission ?? dshSettings.snapshot?.settings.permission?.value ?? status.permissions.current } : null,
    onPermission: (value: DshPermission) => welcome.setPermission(value),
    draftReady: welcome.ready, draftError: welcome.error, onRetryDraft: welcome.retry,
    photos: welcome.value.photos, pickingPhotos: welcomePhotoPicker.picking,
    onPhotos: () => { void welcomePhotoPicker.pick(); },
    onRemovePhoto: (id: string) => { void welcome.removePhoto(id).catch((e) => setError(humanError(e))); },
    onModelId: (id: string | null) => welcome.setModel(welcomeKind, id),
    onEffort: (value: ReasoningEffort | null) => welcome.setEffort(welcomeKind, value),
    onFiles: () => { if (welcome.ready && !busy) void newConversation(false, null, true, { text: welcomeDraft, photos: welcome.value.photos, kind: welcomeKind, modelId: welcomePreference.modelId, effort: welcomePreference.effort, searchId: null, filesOnly: true }); },
  };
  function openAgent(agentId: string) {
    const existing = [...conversations].reverse().find((item) => item.agent_id === agentId);
    if (existing) openConversation(existing.id);
    else void newConversation(false, agentId);
  }
  const serviceChanged = useCallback(() => { setServiceVersion((old) => old + 1); refresh(); }, [refresh]);
  function lifeChat(prompt: string) {
    setWelcomeDraft((old) => `${old.trimEnd()}${old.trim() ? "\n\n" : ""}${prompt}`);
    openMainChat();
  }
  function homeChat(prompt: string) {
    if (!welcome.ready || busy || creatingConversation.current) return;
    lifeChat(prompt);
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
        <HomePanel device={todayDevice} conversations={conversations}
          connection={connection} refreshKey={serviceVersion} status={status ? { ...status, model_ready: !!welcomeModel?.ready && (!!welcomePreference.modelId || status.model_ready) } : null}
          loading={loading || !catalog} syncFailed={lastSyncFailed} onPrompt={homeChat} promptReady={welcome.ready && !busy}
          preferences={{ ...home.preferences, pins: home.preferences.pins.filter((item) => item.kind === "conversation"), visited: home.preferences.visited?.filter((item) => item.kind === "conversation") ?? [] }}
          preferencesReady={home.ready} preferenceError={home.error} onPreferenceRetry={home.retry} onTogglePin={home.toggle}
          onOpenConversation={openConversation}
          onLife={() => selectTab("life")} onWork={() => selectTab("work")}
          onFinance={() => openLifePage("finance")} onHealth={() => openLifePage("health")} />
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
          <AgentChatHeader
            modelName={(showWelcome ? welcomeModel : catalog?.items.find(model => model.id === (selected?.model_id ?? catalog.roles.chat)))?.name ?? "选择模型"}
            title={showWelcome ? assistant?.name ?? "知行" : chatAssistantName}
            subtitle={showWelcome ? "随时聊聊，把事情做成" : selected?.title ?? "新的对话"}
            status={showWelcome ? welcomeStatus : undefined}
            busy={busy}
            menuOpen={chatMenuOpen} onOptions={() => { Keyboard.dismiss(); setChatMenuOpen(value => !value); }}
            onLayout={event => setChatMenuTop(event.nativeEvent.layout.y + event.nativeEvent.layout.height - 2)}
            onMenu={() => setShowAiDrawer(true)}
            onNew={() => { if (!showWelcome && selected?.agent_id) void newConversation(false, selected.agent_id); else setShowWelcome(true); }}
          />
          {showWelcome ? (
            <AiHome name={assistant?.name ?? "知行"} draft={welcomeDraft} kind={welcomeKind} busy={busy} onDraft={setWelcomeDraft} onKind={setWelcomeKind} onSend={submitWelcome} {...welcomeControls} />
          ) : selected ? (
            <DshChatPanel key={selected.id} connection={connection} conversation={selected} assistantName={chatAssistantName}
              defaultBusyBehavior={dshSettings.snapshot?.settings.busy?.value}
              menuAction={chatAction?.conversationId === selected.id ? chatAction : undefined}
              onMessageOptions={() => setChatSettingsFor(selected.id)}
              focusMessageVersion={focusMessage?.conversationId === selected.id ? focusMessage.version : undefined}
              focusMessageSeq={focusMessage?.conversationId === selected.id ? focusMessage.seq : null} onFocusHandled={focusHandled}
              catalog={catalog} onRefresh={serviceChanged} webUrl={status?.web_url}
              onConversationChanged={updated => setConversations(old => mergeById(old, [updated]))}
              startWithFiles={chatStart?.id === selected.id && chatStart.files}
              onFilesOpened={() => setChatStart(old => old ? { ...old, files: false } : null)}
              startWithSend={chatStart?.id === selected.id && chatStart.send}
              onSendStarted={() => setChatStart(old => old ? { ...old, send: false } : null)}
              settingsOpen={chatSettingsFor === selected.id} onSettingsClose={() => setChatSettingsFor(null)}
              filesOpen={chatFilesFor === selected.id} onFilesClose={() => setChatFilesFor(null)}
              onFilesOpen={() => setChatFilesFor(selected.id)} />
          ) : <AiHome name={assistant?.name ?? "知行"} draft={welcomeDraft} kind={welcomeKind} busy={busy || loading} onDraft={setWelcomeDraft} onKind={setWelcomeKind} onSend={submitWelcome} {...welcomeControls} />}
        </>
      ) : settingsView === "overview" ? (
        <SettingsHome connectionUrl={connection.url} onOpen={setSettingsView} />
      ) : settingsView === "vault" ? (
        <PasswordVaultPanel onBack={() => { navigation.current++; setSettingsView("overview"); }} />
      ) : (
        <>
          <BackLink label="设置" onPress={() => { navigation.current++; setSettingsView("overview"); }} />
          {settingsView === "host" ? (
            <DshHostSettings webUrl={status?.web_url} />
          ) : settingsView === "chat" ? (
            <ChatSettingsPanel controller={dshSettings} />
          ) : settingsView === "device" ? (
            <DeviceCapabilitiesPanel onUseLocation={(text) => {
              setWelcomeDraft((old) => `${old.trimEnd()}${old.trim() ? "\n\n" : ""}${text}\n\n`);
              setShowWelcome(true); setChatReturn({ tab: "settings", lifePage }); setTab("chat");
            }} />
          ) : settingsView === "connection" ? (
            <ConnectionSettingsPanel connection={connection} onConnect={onConnect} onDisconnect={onDisconnect} onExplore={() => { void newConversation(true); }} />
          ) : null}
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
        onExit={() => { setShowAiDrawer(false); closeChat(); }}
        exitLabel={chatReturn.tab === "life" ? chatReturn.lifePage === "finance" ? "返回财务" : chatReturn.lifePage === "health" ? "返回健康" : "返回生活" : "返回首页"}
      />
      {tab === "chat" && chatMenuOpen ? <ConversationMenu title={showWelcome ? "新的对话" : selected?.title ?? "新的对话"} top={chatMenuTop} existing={!showWelcome && !!selected}
        onClose={() => setChatMenuOpen(false)}
        onRename={async title => {
          if (!selected) return;
          const updated = await request<Conversation>(connection, `/conversations/${encodeURIComponent(selected.id)}/title`, { method: "PUT", body: { title } });
          setConversations(old => mergeById(old, [updated])); serviceChanged();
        }}
        onShare={() => { if (selected) setChatAction({ conversationId: selected.id, id: ++chatActionId.current, type: "share" }); }}
        onSearch={() => { if (selected) setChatAction({ conversationId: selected.id, id: ++chatActionId.current, type: "search" }); }}
        onDelete={async () => {
          if (!selected) return;
          await request(connection, `/conversations/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
          removeConversation(selected.id);
          if (home.preferences.pins.some(item => targetKey(item) === `conversation:${selected.id}`)) home.toggle({ kind: "conversation", id: selected.id, title: selected.title });
          setShowWelcome(true); serviceChanged();
          void saveDraft(draftKey(connection.url, selected.id), { text: "", pending: null }).catch(() => undefined);
        }} /> : null}
    </View>
  );
}
