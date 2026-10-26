import { ActivityIndicator, Platform, ScrollView, Text, View } from "react-native";
import { version } from "../package.json";
import { BottomSheet } from "./BottomSheet";
import { GITHUB_RELEASES_URL } from "./appUpdates";
import { hasVerifiedApkMetadata } from "./apkUpdate";
import { useApkUpdate } from "./useApkUpdate";
import { useAppUpdate } from "./useAppUpdate";
import { ActionRow, Button, SettingsGroup, useUi } from "./ui";

export function AppUpdateSettings() {
  const { s, colors } = useUi();
  const update = useAppUpdate(version);
  const apk = useApkUpdate();
  const result = update.state.status === "done" ? update.state.result : null;
  const release = result && result.kind !== "unpublished" ? result.release : null;
  const cached = update.state.status === "done" && update.state.source === "cache";
  const installable = result?.kind === "available" || result?.kind === "current" && release?.version === version;
  const downloading = apk.state.phase === "downloading";
  const verifying = apk.state.phase === "verifying";
  const busy = downloading || verifying;
  const close = () => { if (!verifying) { void apk.cancel(); update.close(); } };
  const title = update.state.status === "checking" ? "正在检查更新" : update.state.status === "error" ? "检查未完成"
    : cached ? `已保存版本 ${release?.version}` : result?.kind === "available" ? `发现新版本 ${release?.version}` : result?.kind === "pending" ? `新版本 ${release?.version} 正在发布`
      : result?.kind === "current" ? "已是最新正式版本" : "尚无正式版本";
  return <>
    <SettingsGroup title="关于">
      <ActionRow icon="download-outline" title="检查更新" description={`当前版本 ${version} · GitHub 正式版`} compact last tone="neutral" disabled={update.state.status === "checking" || busy} onPress={() => { void update.check(); }} />
    </SettingsGroup>
    <BottomSheet visible={update.visible} title={title} subtitle={`当前版本 ${version}`} onClose={close}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 16, gap: 16 }}>
        {update.state.status === "checking" ? <View style={s.row}><ActivityIndicator color={colors.gold} /><Text style={s.description}>正在读取 GitHub 最新正式版本…</Text></View> : null}
        {update.state.status === "error" ? <Text accessibilityRole="alert" style={s.description}>{update.state.error}</Text> : null}
        {cached && update.state.status === "done" ? <Text style={s.description}>{update.state.offline ? "暂时无法联网，已保留上次核验的版本和安装包链接，可能已有新版本。" : "使用最近核验的版本信息，可重新检查获取实时结果。"}</Text> : null}
        {update.state.status === "done" && result?.kind !== "unpublished" ? <Text style={s.muted}>核验时间：{new Date(update.state.verifiedAt).toLocaleString("zh-CN")}{cached ? " · 本机缓存" : ""}</Text> : null}
        {update.state.status === "done" && !update.state.cacheSaved ? <Text style={s.muted}>本机未能保存更新缓存，下次检查需要联网。</Text> : null}
        {result?.kind === "unpublished" ? <Text style={s.description}>GitHub 暂时没有可用的正式版本，可以稍后再检查。</Text> : null}
        {result?.kind === "current" && !cached ? <Text style={s.description}>GitHub 最新正式版本为 {release?.version}，当前版本无需更新。</Text> : null}
        {result?.kind === "pending" ? <Text style={s.description}>发布页已有新版本，Android 安装包尚未就绪。稍后再次检查即可。</Text> : null}
        {result?.kind === "available" && !cached ? <Text style={s.description}>{Platform.OS === "android" ? "安装包会直接下载到知行，校验后由系统确认安装，保留原有数据。" : "此版本提供 Android 安装包，可在 GitHub 查看发布说明。"}</Text> : null}
        {update.linkError ? <Text accessibilityRole="alert" style={s.description}>{update.linkError}</Text> : null}
        {downloading && apk.state.phase === "downloading" ? <View style={s.stack}>
          <View style={s.row}><ActivityIndicator color={colors.gold} /><Text accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: apk.state.total, now: apk.state.written }} style={s.description}>正在下载 {Math.min(100, Math.floor(apk.state.written / apk.state.total * 100))}% · {(apk.state.written / 1048576).toFixed(1)} / {(apk.state.total / 1048576).toFixed(1)} MB</Text></View>
          <Button secondary onPress={() => { void apk.cancel(); }}>取消下载</Button>
        </View> : null}
        {verifying ? <View style={s.row}><ActivityIndicator color={colors.gold} /><Text style={s.description}>正在校验安装包并打开系统安装确认…</Text></View> : null}
        {apk.state.phase === "permission" ? <View style={s.stack}>
          <Text style={s.description}>安装包已下载。请先允许知行安装应用更新，返回后点击“继续安装”。</Text>
          <Button onPress={() => { void apk.openSettings(); }}>打开安装权限设置</Button>
          <Button secondary onPress={() => { void apk.install(); }}>继续安装</Button>
        </View> : null}
        {apk.state.phase === "handed-off" ? <Text style={s.description}>已交给 Android 系统，请在系统界面确认安装。若取消了安装，可以重新下载。</Text> : null}
        {apk.state.phase === "cancelled" ? <Text style={s.muted}>下载已取消。</Text> : null}
        {apk.state.phase === "error" ? <Text accessibilityRole="alert" style={s.description}>{apk.state.message}</Text> : null}
        {installable && release?.apkUrl && Platform.OS === "android" && !busy && apk.state.phase !== "permission" ? hasVerifiedApkMetadata(release)
          ? <Button icon="download-outline" disabled={update.opening} onPress={() => { void apk.start(release); }}>{result?.kind === "current" ? "重新下载安装当前版本" : "下载并安装更新"}</Button>
          : <Text style={s.description}>此版本缺少 App 内安装所需的校验信息，请重新检查更新或查看 GitHub 发布页。</Text> : null}
        {(update.state.status === "done" || update.state.status === "error") && !busy ? <Button secondary icon="refresh" disabled={update.opening} onPress={() => { void apk.cancel(); void update.check(true); }}>重新检查</Button> : null}
        {update.state.status !== "checking" && update.state.status !== "idle" ? <Button secondary icon="logo-github" disabled={update.opening} onPress={() => { void update.openLink(release?.url ?? GITHUB_RELEASES_URL); }}>查看 GitHub 发布页</Button> : null}
        {release?.notes ? <View style={s.stack}><Text accessibilityRole="header" style={s.title}>版本说明</Text><Text selectable style={s.description}>{release.notes}</Text></View> : null}
      </ScrollView>
    </BottomSheet>
  </>;
}
