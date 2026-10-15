import { ActivityIndicator, Platform, ScrollView, Text, View } from "react-native";
import { version } from "../package.json";
import { BottomSheet } from "./BottomSheet";
import { GITHUB_RELEASES_URL } from "./appUpdates";
import { useAppUpdate } from "./useAppUpdate";
import { ActionRow, Button, SettingsGroup, useUi } from "./ui";

export function AppUpdateSettings() {
  const { s, colors } = useUi();
  const update = useAppUpdate(version);
  const result = update.state.status === "done" ? update.state.result : null;
  const release = result && result.kind !== "unpublished" ? result.release : null;
  const title = update.state.status === "checking" ? "正在检查更新" : update.state.status === "error" ? "检查未完成"
    : result?.kind === "available" ? `发现新版本 ${release?.version}` : result?.kind === "pending" ? `新版本 ${release?.version} 正在发布`
      : result?.kind === "current" ? "已是最新正式版本" : "尚无正式版本";
  return <>
    <SettingsGroup title="关于">
      <ActionRow icon="download-outline" title="检查更新" description={`当前版本 ${version} · GitHub 正式版`} compact last tone="neutral" disabled={update.state.status === "checking"} onPress={() => { void update.check(); }} />
    </SettingsGroup>
    <BottomSheet visible={update.visible} title={title} subtitle={`当前版本 ${version}`} onClose={update.close}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 16, gap: 16 }}>
        {update.state.status === "checking" ? <View style={s.row}><ActivityIndicator color={colors.gold} /><Text style={s.description}>正在读取 GitHub 最新正式版本…</Text></View> : null}
        {update.state.status === "error" ? <Text accessibilityRole="alert" style={s.description}>{update.state.error}</Text> : null}
        {result?.kind === "unpublished" ? <Text style={s.description}>GitHub 暂时没有可用的正式版本，可以稍后再检查。</Text> : null}
        {result?.kind === "current" ? <Text style={s.description}>GitHub 最新正式版本为 {release?.version}，当前版本无需更新。</Text> : null}
        {result?.kind === "pending" ? <Text style={s.description}>发布页已有新版本，Android 安装包尚未就绪。稍后再次检查即可。</Text> : null}
        {result?.kind === "available" ? <Text style={s.description}>{Platform.OS === "android" ? "打开 GitHub 下载 Android 安装包，下载后按系统提示覆盖安装。" : "此版本提供 Android 安装包，可在 GitHub 查看发布说明。"}</Text> : null}
        {update.linkError ? <Text accessibilityRole="alert" style={s.description}>{update.linkError}</Text> : null}
        {result?.kind === "available" && release?.apkUrl && Platform.OS === "android" ? <Button icon="download-outline" disabled={update.opening} onPress={() => { void update.openLink(release.apkUrl!); }}>下载 Android 安装包</Button> : null}
        {update.state.status === "error" || result?.kind === "pending" || result?.kind === "unpublished" ? <Button icon="refresh" disabled={update.opening} onPress={() => { void update.check(); }}>重新检查</Button> : null}
        {update.state.status !== "checking" && update.state.status !== "idle" ? <Button secondary icon="logo-github" disabled={update.opening} onPress={() => { void update.openLink(release?.url ?? GITHUB_RELEASES_URL); }}>查看 GitHub 发布页</Button> : null}
        {release?.notes ? <View style={s.stack}><Text accessibilityRole="header" style={s.title}>版本说明</Text><Text selectable style={s.description}>{release.notes}</Text></View> : null}
      </ScrollView>
    </BottomSheet>
  </>;
}
