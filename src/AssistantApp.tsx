import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
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
import {
  mergeById,
  normalizeServerUrl,
  request,
  type Assistant,
  type Connection,
  type Conversation,
  type MessageInput,
  type Page,
  type Project,
  type Schedule,
  type ServiceStatus,
} from "./api";
import { ChatPanel } from "./ChatPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { SettingsPanel, Welcome } from "./SettingsPanel";
import {
  draftKey,
  clearDraft,
  readConnection,
  removeConnection,
  saveDraft,
} from "./storage";
import { Button, colors, Empty, Field, humanError, s, timeLabel } from "./ui";

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
            <ActivityIndicator style={s.body} color={colors.green} />
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
            <Welcome onConnect={connect} error={error} />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
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
  const [tab, setTab] = useState<"chat" | "schedules" | "settings">("chat");
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  const [conversationCursor, setConversationCursor] = useState<string | null>(
    null,
  );
  const [scheduleCursor, setScheduleCursor] = useState<string | null>(null);
  const [showConversations, setShowConversations] = useState(false);
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
        const [health, person, chats, folders, plans, current] =
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
        if (initial) {
          setConversationCursor(chats.previous_cursor ?? null);
          setScheduleCursor(plans.next_cursor);
          initial = false;
        }
        setSelectedId(
          (old) => old ?? chats.items[chats.items.length - 1]?.id ?? null,
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

  async function newConversation(explore = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const conversation = await request<Conversation>(
        connection,
        "/conversations",
        {
          method: "POST",
          body: {
            title: explore ? "认识运行环境" : title.trim() || "新的对话",
            project_id: explore ? null : projectId,
          },
        },
      );
      if (explore) {
        const payload: MessageInput = {
          id: Crypto.randomUUID(),
          kind: "task",
          intent: "queue",
          content:
            "请只读探索你当前的运行环境：系统与架构、你实际可用的工具、当前项目工作目录和已授权额外目录。给出能做什么、尚缺什么与验证依据。不要读取凭据或扫描目录内容，不要修改文件、安装软件或调整系统；无法验证的能力明确标记为未知。",
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
              "环境探索提交尚未确认，原请求已保存到该会话草稿，可安全重试。",
            );
        }
      }
      if (!alive.current) return;
      setConversations((old) => mergeById(old, [conversation]));
      setSelectedId(conversation.id);
      selectedRef.current = conversation.id;
      setTitle("");
      setShowConversations(false);
      setTab("chat");
      refresh();
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function newProject() {
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
        setProjectId(project.id);
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
  const statusLabel = syncError
    ? "连接已断开"
    : !status
      ? "连接中"
      : !status.model_ready
        ? "模型待配置"
        : !status.worker_online
          ? "执行服务离线"
          : "陪伴在线";

  return (
    <View style={s.body}>
      <View style={s.header}>
        <View style={s.brand}>
          <Text style={s.brandText}>知</Text>
        </View>
        <View style={s.grow}>
          <Text style={s.eyebrow}>ZHIXING · PERSONAL ASSISTANT</Text>
          <Text style={s.heading}>{assistant?.name || "知行"}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={refresh} style={s.chip}>
          <Text style={s.chipText}>{statusLabel}</Text>
        </Pressable>
      </View>
      {syncError ? (
        <View style={[s.notice, { marginHorizontal: 18, marginBottom: 8 }]}>
          <Text style={s.noticeText}>{syncError}</Text>
          <Button secondary small onPress={refresh}>
            重新连接
          </Button>
        </View>
      ) : status &&
        (!status.model_ready ||
          !status.worker_online ||
          !status.execution_available) ? (
        <View style={[s.notice, { marginHorizontal: 18, marginBottom: 8 }]}>
          <Text style={s.noticeText}>
            {!status.model_ready
              ? "服务已连接，模型尚未配置。请在服务器上设置模型后开始使用。"
              : !status.worker_online
                ? "执行服务暂时离线。已接收任务会保留，等待 worker 恢复。"
                : "服务器执行能力尚未就绪，请查看后端配置。"}
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
      {tab === "chat" ? (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowConversations(true)}
            style={{
              paddingHorizontal: 22,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Text numberOfLines={1} style={[s.title, s.grow]}>
              {selected?.title ?? "选择一段对话"}
            </Text>
            <Text style={s.muted}>切换 / 新建 ›</Text>
          </Pressable>
          <View style={s.divider} />
          {selected ? (
            <ChatPanel
              key={selected.id}
              connection={connection}
              conversation={selected}
              assistantName={assistant?.name || "知行"}
              onRefresh={refresh}
            />
          ) : loading ? (
            <ActivityIndicator style={s.body} color={colors.green} />
          ) : (
            <View style={s.body}>
              <Empty title="一段新的开始">
                可以聊日常，也可以一起研究。{"\n"}为长期话题留一段专属对话。
              </Empty>
              <View style={{ padding: 24 }}>
                <Button onPress={() => setShowConversations(true)}>
                  开启对话
                </Button>
              </View>
            </View>
          )}
        </>
      ) : tab === "schedules" ? (
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
      <View style={s.tabs}>
        {(
          [
            { id: "chat", label: "对话" },
            { id: "schedules", label: "计划" },
            { id: "settings", label: "我们" },
          ] as const
        ).map((item) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item.id }}
            key={item.id}
            onPress={() => setTab(item.id)}
            style={[s.tab, tab === item.id && s.activeTab]}
          >
            <Text style={[s.tabText, tab === item.id && s.activeTabText]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
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
                    setSelectedId(conversation.id);
                    selectedRef.current = conversation.id;
                    setShowConversations(false);
                    setTab("chat");
                    refresh();
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
