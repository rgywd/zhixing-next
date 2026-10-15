import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, FlatList, Keyboard, Pressable, StyleSheet, Text, View, type TextInputProps } from "react-native";
import * as Crypto from "expo-crypto";
import { useNotice } from "./Notice";
import { useThemedStyles } from "./ThemeProvider";
import { layout, radius, space, typography, type ThemeColors } from "./theme";
import { searchVaultEntries, type VaultEntry, type VaultInput } from "./vaultTypes";
import { usePasswordVault } from "./usePasswordVault";
import { ActionLink, BackLink, Button, Empty, Field, IconAction, PageHeading, PageScrollView, SwitchRow, useUi } from "./ui";

type ViewName = "list" | "detail" | "form" | "master";
const privateInput: TextInputProps = { autoCapitalize: "none", autoCorrect: false, autoComplete: "off", textContentType: "none", importantForAutofill: "no" };
const maskedValue = "••••••••";

type PasswordVault = ReturnType<typeof usePasswordVault>;
type VaultPanelProps = { vault: PasswordVault; onBack: () => void };

export function PasswordVaultPanel({ onBack }: { onBack: () => void }) {
  const vault = usePasswordVault();
  return vault.status === "unlocked"
    ? <UnlockedVaultPanel vault={vault} onBack={onBack} />
    : <LockedVaultPanel key={`${vault.status}:${vault.lockEpoch}`} vault={vault} onBack={onBack} />;
}

function LockedVaultPanel({ vault, onBack }: VaultPanelProps) {
  const { s } = useUi();
  const [master, setMaster] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const back = useCallback(() => {
    if (Keyboard.isVisible()) { Keyboard.dismiss(); return; }
    if (vault.busy) return;
    vault.lock(); setMaster(""); setConfirmation(""); onBack();
  }, [vault, onBack]);
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => handler.remove();
  }, [back]);
  async function submit() {
    if (vault.busy) return;
    setError("");
    if (vault.status === "create") {
      if (master.length < 12 || master.length > 1024) { setError("主密码需要12至1024个字符。"); return; }
      if (master !== confirmation) { setError("两次输入的主密码不一致。"); return; }
    }
    if (!master.length) { setError("请输入主密码。"); return; }
    try {
      const ok = vault.status === "create" ? await vault.create(master) : await vault.unlock(master);
      if (ok && active.current) { setMaster(""); setConfirmation(""); }
    } catch { if (active.current) setError("未能完成，请重试。"); }
  }
  const creating = vault.status === "create";
  const feedback = [...new Set([error, vault.error, vault.storageError].filter(Boolean))].map((message) => <Text key={message} accessibilityRole="alert" style={s.error}>{message}</Text>);
  return <View style={s.body}>
    <BackLink label="设置" onPress={back} />
    <PageScrollView>
      <PageHeading title="密码管理" description="网站、账号与密码，独立保存在本机。" />
      {vault.status === "loading" ? <ActivityIndicator accessibilityLabel="正在读取密码库" /> : creating || vault.status === "locked" ? <>
        <Empty compact icon="lock-closed-outline" title={creating ? "设置独立主密码" : "密码库已锁定"} />
        <View style={s.form}>
          <Field label={creating ? "主密码" : "输入主密码"} {...privateInput} secureTextEntry maxLength={1024} value={master} editable={!vault.busy} onChangeText={(value) => { setMaster(value); setError(""); }} />
          {creating ? <Field label="再次输入主密码" {...privateInput} secureTextEntry maxLength={1024} value={confirmation} editable={!vault.busy} onChangeText={(value) => { setConfirmation(value); setError(""); }} /> : null}
          <Text style={s.muted}>{creating ? "至少12个字符。仅保存在这台设备，主密码无法找回；卸载会丢失本机密码库。" : "输入独立主密码，查看这台设备上的密码记录。"}</Text>
        </View>
        {feedback}<Button disabled={vault.busy || !master.length} onPress={() => void submit()}>{vault.busy ? "正在处理…" : creating ? "创建密码库" : "解锁"}</Button>
      </> : <>
        <Empty compact icon="shield-outline" title={vault.status === "unsupported" ? "此设备暂不支持密码库" : "密码库暂时无法读取"}>原有内容不会被空记录替换。</Empty>
        {feedback}<Button secondary disabled={vault.busy} onPress={vault.retry}>重新检查</Button>
      </>}
    </PageScrollView>
  </View>;
}

function UnlockedVaultPanel({ vault, onBack }: VaultPanelProps) {
  const current = useRef(vault);
  useEffect(() => { current.current = vault; }, [vault]);
  const active = useRef(true);
  const { s } = useUi();
  const v = useThemedStyles(createStyles);
  const { show, dismiss } = useNotice();
  const [view, setView] = useState<ViewName>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [master, setMaster] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localError, setLocalError] = useState("");
  const [more, setMore] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [shown, setShown] = useState<{ context: string; keys: string[] }>({ context: "", keys: [] });
  const unlocked = vault.status === "unlocked";
  const disabled = vault.busy || generating;
  const draft = vault.draft;
  const selected = unlocked ? vault.entries.find((entry) => entry.id === selectedId) : undefined;
  const context = view === "form" ? `form:${draft?.entryId ?? "new"}` : `${view}:${selectedId ?? ""}`;
  const visible = (key: string) => shown.context === context && shown.keys.includes(key);
  function toggle(key: string) {
    if (disabled || !unlocked) return;
    vault.touch();
    setShown((old) => ({ context, keys: old.context !== context ? [key] : old.keys.includes(key) ? old.keys.filter((item) => item !== key) : [...old.keys, key] }));
  }
  const resetPrivateUi = useCallback(() => {
    setView("list"); setSelectedId(null); setQuery(""); setMaster(""); setConfirmation(""); setLocalError(""); setMore(false); setGenerating(false); setShown({ context: "", keys: [] });
    dismiss("vault-copy");
  }, [dismiss]);
  useEffect(() => { active.current = true; return () => { active.current = false; dismiss("vault-copy"); }; }, [dismiss]);
  const back = useCallback(() => {
    if (Keyboard.isVisible()) { Keyboard.dismiss(); return; }
    if (current.current.busy || generating) return;
    if (active.current && current.current.status === "unlocked" && view !== "list") {
      setView("list"); setSelectedId(null); setShown({ context: "", keys: [] }); setMaster(""); setConfirmation(""); setLocalError(""); return;
    }
    current.current.lock(); resetPrivateUi(); onBack();
  }, [generating, onBack, resetPrivateUi, view]);
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => handler.remove();
  }, [back]);
  function lock() { vault.lock(); resetPrivateUi(); }
  function edit(entryId?: string) {
    if (disabled) return;
    const source = vault.draft?.input ?? vault.entries.find((entry) => entry.id === entryId);
    vault.touch(); vault.beginEdit(entryId); setShown({ context: "", keys: [] }); setLocalError("");
    setMore(Boolean(source && (source.recoveryEmail || source.phone || source.notes || source.questions.length || source.fields.length))); setView("form");
  }
  function update(input: VaultInput) { if (!disabled && unlocked) { vault.touch(); vault.updateDraft(input); setLocalError(""); } }
  async function copy(value: string) {
    if (disabled || !unlocked) return;
    vault.touch();
    try { if (await vault.copy(value) && active.current && current.current.status === "unlocked") show({ id: "vault-copy", message: "已复制，将尝试在30秒后清除", tone: "success" }); }
    catch { if (active.current && current.current.status === "unlocked") setLocalError("复制未完成，请重试。"); }
  }
  async function submitMaster() {
    if (disabled) return;
    setLocalError("");
    if (master.length < 12 || master.length > 1024) { setLocalError("主密码需要12至1024个字符。"); return; }
    if (master !== confirmation) { setLocalError("两次输入的主密码不一致。"); return; }
    try {
      if (await vault.changeMaster(master) && active.current && current.current.status === "unlocked") { setMaster(""); setConfirmation(""); setView("list"); }
    } catch { if (active.current) setLocalError("未能完成，请重试。"); }
  }
  async function save() {
    if (disabled || !unlocked) return;
    vault.touch(); setLocalError("");
    try { if (await vault.save() && active.current && current.current.status === "unlocked") { setView("list"); setSelectedId(null); setShown({ context: "", keys: [] }); } }
    catch { if (active.current && current.current.status === "unlocked") setLocalError("尚未保存，请重试。编辑内容仍保留。"); }
  }
  async function generate() {
    if (disabled || !unlocked || !draft) return;
    const entryId = draft.entryId;
    setGenerating(true); vault.touch();
    try {
      const password = await vault.generate();
      const next = current.current;
      if (password && active.current && next.status === "unlocked" && next.draft?.entryId === entryId) { next.updateDraft({ ...next.draft.input, password }); setShown({ context: "", keys: [] }); }
    } catch { if (active.current && current.current.status === "unlocked") setLocalError("生成未完成，请重试。"); }
    finally { setGenerating(false); }
  }
  function remove(entry: VaultEntry) {
    if (disabled) return;
    vault.touch();
    Alert.alert("删除这条密码记录？", "这条记录及其附加信息将从本机密码库移除。", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => {
        if (!active.current || current.current.status !== "unlocked") return;
        void current.current.removeEntry(entry.id).then((ok) => { if (ok && active.current && current.current.status === "unlocked") { setView("list"); setSelectedId(null); setShown({ context: "", keys: [] }); } }).catch(() => { if (active.current && current.current.status === "unlocked") setLocalError("删除未完成，请重试。"); });
      } },
    ]);
  }
  const errors = [...new Set([localError, vault.error, vault.storageError].filter(Boolean))];
  const feedback = errors.length ? <View style={s.stack}>{errors.map((error) => <Text key={error} accessibilityRole="alert" style={s.error}>{error}</Text>)}</View> : null;
  const header = <View style={v.toolbar}><BackLink label={unlocked && view !== "list" ? "密码管理" : "设置"} onPress={back} />{unlocked ? <IconAction icon="lock-closed-outline" label="锁定密码库" onPress={lock} /> : null}</View>;
  const masterFields = <View style={s.form}>
    <Field label="新主密码" {...privateInput} secureTextEntry maxLength={1024} value={master} editable={!disabled} onChangeText={(value) => { setMaster(value); setLocalError(""); if (unlocked) vault.touch(); }} />
    <Field label="再次输入新主密码" {...privateInput} secureTextEntry maxLength={1024} value={confirmation} editable={!disabled} onChangeText={(value) => { setConfirmation(value); setLocalError(""); if (unlocked) vault.touch(); }} />
    <Text style={s.muted}>至少12个字符，请妥善保管。主密码无法找回。</Text>
  </View>;

  if (view === "master") return <View style={s.body} onTouchStart={vault.touch}>
    {header}<PageScrollView><PageHeading title="修改主密码" description="更新这台设备上密码库的主密码。" />{masterFields}{feedback}<Button disabled={disabled || !master.length} onPress={() => void submitMaster()}>{vault.busy ? "正在更新…" : "更新主密码"}</Button></PageScrollView>
  </View>;

  if (view === "form" && draft) {
    const input = draft.input;
    const set = <K extends keyof VaultInput>(key: K, value: VaultInput[K]) => update({ ...input, [key]: value });
    const secretField = (label: string, key: string, value: string, onChange: (value: string) => void) => <View style={s.stack}>
      <Field label={label} {...privateInput} secureTextEntry={!visible(key)} maxLength={20000} value={value} editable={!disabled} onChangeText={onChange} />
      <View style={v.inlineActions}><ActionLink tone="neutral" disabled={disabled} onPress={() => toggle(key)}>{visible(key) ? `隐藏${label}` : `显示${label}`}</ActionLink></View>
    </View>;
    return <View style={s.body} onTouchStart={vault.touch}>
      {header}<PageScrollView>
        <PageHeading title={draft.entryId ? "编辑密码记录" : "添加密码记录"} description="网站/网址、账号和密码为必填项。编辑内容仅加密保存在本机。" />
        <View style={s.form}>
          <Field label="网站/网址" {...privateInput} maxLength={2000} value={input.site} editable={!disabled} onChangeText={(value) => set("site", value)} placeholder="网站名称或网址" />
          <Field label="账号" {...privateInput} maxLength={2000} value={input.account} editable={!disabled} onChangeText={(value) => set("account", value)} />
          {secretField("密码", "password", input.password, (value) => set("password", value))}
          <ActionLink icon="sparkles-outline" disabled={disabled} onPress={() => void generate()}>{generating ? "正在生成…" : "生成20位密码"}</ActionLink>
          <ActionLink icon={more ? "chevron-up" : "chevron-down"} tone="neutral" disabled={disabled} onPress={() => { vault.touch(); setMore(!more); }}>更多信息（选填）</ActionLink>
          {more ? <>
            <Field label="辅助邮箱" {...privateInput} keyboardType="email-address" maxLength={2000} value={input.recoveryEmail} editable={!disabled} onChangeText={(value) => set("recoveryEmail", value)} />
            <Field label="电话" {...privateInput} keyboardType="phone-pad" maxLength={2000} value={input.phone} editable={!disabled} onChangeText={(value) => set("phone", value)} />
            <View style={s.stack}>
              <Text style={s.heading}>密保问题</Text>
              {input.questions.map((item, index) => <View key={item.id} style={v.extraBlock}>
                <Field label={`密保问题 ${index + 1}`} {...privateInput} maxLength={2000} value={item.question} editable={!disabled} onChangeText={(value) => set("questions", input.questions.map((question) => question.id === item.id ? { ...question, question: value } : question))} />
                {secretField(`密保答案 ${index + 1}`, `question:${item.id}`, item.answer, (value) => set("questions", input.questions.map((question) => question.id === item.id ? { ...question, answer: value } : question)))}
                <ActionLink tone="neutral" disabled={disabled} onPress={() => set("questions", input.questions.filter((question) => question.id !== item.id))}>{`移除密保问题 ${index + 1}`}</ActionLink>
              </View>)}
              <ActionLink icon="add" disabled={disabled || input.questions.length >= 30} onPress={() => set("questions", [...input.questions, { id: Crypto.randomUUID(), question: "", answer: "" }])}>添加密保问题</ActionLink>
            </View>
            <View style={s.stack}>
              <Text style={s.heading}>自定义字段</Text>
              {input.fields.map((item, index) => <View key={item.id} style={v.extraBlock}>
                <Field label={`字段名称 ${index + 1}`} {...privateInput} maxLength={2000} value={item.label} editable={!disabled} onChangeText={(value) => set("fields", input.fields.map((field) => field.id === item.id ? { ...field, label: value } : field))} />
                {item.secret ? secretField(`字段内容 ${index + 1}`, `field:${item.id}`, item.value, (value) => set("fields", input.fields.map((field) => field.id === item.id ? { ...field, value } : field))) : <Field label={`字段内容 ${index + 1}`} {...privateInput} maxLength={20000} value={item.value} editable={!disabled} onChangeText={(value) => set("fields", input.fields.map((field) => field.id === item.id ? { ...field, value } : field))} />}
                <SwitchRow label={`隐藏字段内容 ${index + 1}`} value={item.secret} disabled={disabled} onValueChange={(secret) => { setShown({ context: "", keys: [] }); set("fields", input.fields.map((field) => field.id === item.id ? { ...field, secret } : field)); }} />
                <ActionLink tone="neutral" disabled={disabled} onPress={() => set("fields", input.fields.filter((field) => field.id !== item.id))}>{`移除自定义字段 ${index + 1}`}</ActionLink>
              </View>)}
              <ActionLink icon="add" disabled={disabled || input.fields.length >= 30} onPress={() => set("fields", [...input.fields, { id: Crypto.randomUUID(), label: "", value: "", secret: true }])}>添加自定义字段</ActionLink>
            </View>
            <Field label="备注" {...privateInput} multiline maxLength={20000} value={input.notes} editable={!disabled} onChangeText={(value) => set("notes", value)} />
          </> : null}
        </View>
        {vault.draftSaving ? <Text style={s.muted}>正在加密保留编辑…</Text> : null}
        {feedback}<Button disabled={disabled} onPress={() => void save()}>{vault.busy ? "正在保存…" : "保存"}</Button>
        <ActionLink tone="neutral" disabled={disabled} onPress={() => { void vault.discardDraft().then((ok) => { if (ok && active.current && current.current.status === "unlocked") { setView("list"); setShown({ context: "", keys: [] }); } }); }}>放弃这次编辑</ActionLink>
      </PageScrollView>
    </View>;
  }

  if (view === "detail" && selected) {
    const detail = (label: string, key: string, value: string, secret = false) => <View key={key} style={v.detailRow}>
      <View style={v.detailCopy}><Text style={s.muted}>{label}</Text><Text style={v.detailValue}>{secret && !visible(key) ? maskedValue : value || "未填写"}</Text></View>
      <View style={v.detailActions}>{secret ? <IconAction icon={visible(key) ? "eye-off-outline" : "eye-outline"} label={`${visible(key) ? "隐藏" : "显示"}${label}`} disabled={disabled} onPress={() => toggle(key)} /> : null}<IconAction icon="copy-outline" label={`复制${label}`} disabled={disabled || !value.length} onPress={() => void copy(value)} /></View>
    </View>;
    return <View style={s.body} onTouchStart={vault.touch}>
      {header}<PageScrollView>
        <PageHeading title="密码详情" action={<ActionLink disabled={disabled} onPress={() => edit(selected.id)}>编辑</ActionLink>} />
        <View style={s.card}>{detail("网站/网址", "site", selected.site)}{detail("账号", "account", selected.account)}{detail("密码", "password", selected.password, true)}</View>
        {selected.recoveryEmail || selected.phone || selected.questions.length || selected.fields.length || selected.notes ? <View style={s.card}>
          <Text style={s.heading}>附加信息</Text>
          {selected.recoveryEmail ? detail("辅助邮箱", "recoveryEmail", selected.recoveryEmail) : null}{selected.phone ? detail("电话", "phone", selected.phone) : null}
          {selected.questions.map((item, index) => <View key={item.id} style={s.stack}><Text style={s.text}>{item.question}</Text>{detail(`密保答案 ${index + 1}`, `question:${item.id}`, item.answer, true)}</View>)}
          {selected.fields.map((item) => detail(item.label || "自定义字段", `field:${item.id}`, item.value, item.secret))}
          {selected.notes ? detail("备注", "notes", selected.notes) : null}
        </View> : null}
        <Text style={s.muted}>离开或进入后台后自动锁定。复制内容将尝试在30秒后清除。</Text>
        {feedback}<ActionLink icon="trash-outline" tone="neutral" disabled={disabled} onPress={() => remove(selected)}>删除这条记录</ActionLink>
      </PageScrollView>
    </View>;
  }

  const entries = searchVaultEntries(vault.entries, query);
  return <View style={s.body} onTouchStart={vault.touch}>
    {header}
    <FlatList data={entries} keyExtractor={(entry) => entry.id} keyboardShouldPersistTaps="handled" contentContainerStyle={v.listContent}
      ListHeaderComponent={<View style={v.listHeader}>
        <PageHeading title="密码管理" description="仅在这台设备加密保存。" action={<IconAction icon="add" label="添加密码记录" disabled={disabled} onPress={() => edit()} />} />
        <Field label="搜索密码记录" {...privateInput} value={query} editable={!disabled} onChangeText={(value) => { vault.touch(); setQuery(value); }} placeholder="网站、账号、辅助邮箱或电话" />
        {draft ? <ActionLink tone="neutral" disabled={disabled} onPress={() => edit()}>继续未完成编辑</ActionLink> : null}
        {feedback}
      </View>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`打开密码记录：${item.site}`} disabled={disabled} accessibilityState={{ disabled }} onPress={() => { vault.touch(); setShown({ context: "", keys: [] }); setSelectedId(item.id); setView("detail"); }} style={({ pressed }) => [v.listItem, pressed && s.pressed]}><Text style={v.site}>{item.site}</Text><Text style={v.account}>{item.account}</Text></Pressable>}
      ListEmptyComponent={<Empty icon="key-outline" title={query.trim() ? "没有匹配的记录" : "还没有密码记录"}>{query.trim() ? "换一个网站名称或账号试试。" : "添加网站/网址、账号与密码，就能开始使用。"}</Empty>}
      ListFooterComponent={<View style={v.listFooter}><Text style={s.muted}>{entries.length} 条记录 · 离开或进入后台自动锁定</Text><ActionLink icon="key-outline" tone="neutral" disabled={disabled} onPress={() => { vault.touch(); setMaster(""); setConfirmation(""); setLocalError(""); setView("master"); }}>修改主密码</ActionLink></View>}
    />
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xs },
  listContent: { paddingHorizontal: layout.gutter, paddingTop: space.sm, paddingBottom: space.xl }, listHeader: { gap: space.lg, paddingBottom: space.md }, listFooter: { gap: space.md, paddingTop: space.lg },
  listItem: { backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.xs, minHeight: 64, justifyContent: "center" }, site: { ...typography.item, color: colors.ink }, account: { ...typography.caption, color: colors.muted },
  inlineActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm }, extraBlock: { gap: space.sm, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.md, backgroundColor: colors.surface },
  detailRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }, detailCopy: { flex: 1, minWidth: 100, gap: space.xs }, detailValue: { ...typography.body, color: colors.ink }, detailActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" },
});
