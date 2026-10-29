import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { DshAttachment } from "./dshProtocol";
import { useUi } from "./ui";
import { radius, space, typography } from "./theme";

export function ChatFileCard({ file, onOpen, onShare, busy = false }: { file: DshAttachment; onOpen: () => void; onShare?: () => void; busy?: boolean }) {
  const { colors } = useUi();
  const kind = file.name.split(".").at(-1)?.toUpperCase() ?? "文件";
  return <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.surface, borderRadius: radius.item, minWidth: 0, marginVertical: space.xs }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`打开文件 ${file.name}`} onPress={onOpen}
      style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", padding: space.md, gap: space.md, minHeight: 76 }}>
      <View style={{ width: 42, height: 48, backgroundColor: colors.neutral, borderRadius: radius.small, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="document-text-outline" size={24} color={colors.ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text numberOfLines={2} style={{ ...typography.item, color: colors.ink }}>{file.name}</Text>
        <Text numberOfLines={2} style={{ ...typography.detail, color: colors.muted }}>{file.description || `${kind} 文件${file.bytes ? ` · ${file.bytes < 1024 ? `${file.bytes} B` : `${(file.bytes / 1024).toFixed(1)} KB`}` : ""} · 轻点预览`}</Text>
      </View>
    </Pressable>
    {onShare ? <Pressable accessibilityRole="button" accessibilityLabel={`分享文件 ${file.name}`} accessibilityState={{ disabled: busy }}
      disabled={busy} onPress={onShare} style={{ width: 44, minHeight: 60, alignItems: "center", justifyContent: "center", opacity: busy ? 0.4 : 1 }}>
      <Ionicons name="share-outline" size={20} color={colors.muted} />
    </Pressable> : null}
  </View>;
}
