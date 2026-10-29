import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ActionLink, humanError, useUi } from "./ui";

/** Local feedback remains visible inside native modals; success follows the actual write. */
export function CopyAction({ text, label = "复制" }: { text: string; label?: string }) {
  const { s } = useUi();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <View>
    <ActionLink icon="copy-outline" disabled={busy} onPress={() => {
      setBusy(true); setError(""); setCopied(null);
      void Clipboard.setStringAsync(text).then(ok => {
        if (ok === false) throw new Error("复制失败，请重试。");
        setCopied(text);
      }).catch(e => setError(humanError(e))).finally(() => setBusy(false));
    }}>{copied === text ? "已复制" : label}</ActionLink>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
  </View>;
}
