import { memo, useDeferredValue, useMemo, type ReactNode } from "react";
import { ScrollView, Text, View, type TextProps } from "react-native";
import Markdown, { createMarkdownIt, parser, sealIncompleteMarkdown, type ASTNode, type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { markdownBlockSignature } from "./messageMarkdown";

function SelectableText(props: TextProps) {
  return <Text selectable {...props} />;
}
function StreamingText(props: TextProps) {
  return <Text {...props} selectable={false} />;
}
const markdownParser = createMarkdownIt();
const tableColumnWidth = 160;
const tableWidth = (node: ASTNode) => Math.max(1, ...node.children.flatMap((part) => part.children)
  .filter((part) => part.type === "tr").map((part) => part.children.length)) * tableColumnWidth;
const cellStyle = { width: tableColumnWidth, minWidth: tableColumnWidth, maxWidth: tableColumnWidth, flex: 0, flexGrow: 0, flexShrink: 0 };

const createMarkdownRules = (colors: ThemeColors) => ({
  image: (node: ASTNode) => (
    <Text key={node.key} style={{ color: colors.muted }}>
      {node.attributes.alt || "[图片]"}
    </Text>
  ),
  table: (node: ASTNode, children: ReactNode[], _parents: ASTNode[], styles: MarkdownStyleMap) => {
    return <ScrollView key={node.key} horizontal nestedScrollEnabled showsHorizontalScrollIndicator contentContainerStyle={{ flexGrow: 1 }}>
      <View style={[styles._VIEW_SAFE_table, { width: tableWidth(node) + 2 }]}>{children}</View>
    </ScrollView>;
  },
  tr: (node: ASTNode, children: ReactNode[], parents: ASTNode[], styles: MarkdownStyleMap) => {
    const table = parents.find((part) => part.type === "table");
    return <View key={node.key} style={[styles._VIEW_SAFE_tr, { width: table ? tableWidth(table) : node.children.length * tableColumnWidth, flexDirection: "row", flexWrap: "nowrap" }]}>{children}</View>;
  },
  th: (node: ASTNode, children: ReactNode[], _parents: ASTNode[], styles: MarkdownStyleMap) =>
    <View key={node.key} style={[styles._VIEW_SAFE_th, cellStyle]}>{children}</View>,
  td: (node: ASTNode, children: ReactNode[], _parents: ASTNode[], styles: MarkdownStyleMap) =>
    <View key={node.key} style={[styles._VIEW_SAFE_td, cellStyle]}>{children}</View>,
});

const openWebLink = (url: string) => /^https?:\/\//i.test(url);

const createMarkdownStyles = (colors: ThemeColors) => ({
  body: { color: colors.ink, fontSize: 15, lineHeight: 24 },
  text: { color: colors.ink, fontSize: 15, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  heading1: { color: colors.ink, fontSize: 20, fontWeight: "600", marginBottom: 8 },
  heading2: { color: colors.ink, fontSize: 18, fontWeight: "600", marginBottom: 7 },
  heading3: { color: colors.ink, fontSize: 16, fontWeight: "600", marginBottom: 6 },
  bullet_list: { marginVertical: 5 },
  ordered_list: { marginVertical: 5 },
  code_inline: { backgroundColor: colors.pale, color: colors.ink, fontSize: 13, padding: 0, paddingHorizontal: 4, borderWidth: 0, borderRadius: 4 },
  code_block: { backgroundColor: colors.pale, color: colors.ink, fontSize: 13, padding: 10, borderRadius: 10 },
  fence: { borderColor: colors.line, borderWidth: 1, borderRadius: 10, overflow: "hidden", marginVertical: 6 },
  fence_header: { backgroundColor: colors.pale, borderBottomColor: colors.line },
  fence_language_label: { color: colors.muted },
  fence_copy_text: { color: colors.muted },
  fence_code: { backgroundColor: colors.surfaceRaised },
  blockquote: { backgroundColor: colors.pale, borderLeftColor: colors.accent, borderLeftWidth: 3, paddingHorizontal: 10 },
  table: { borderColor: colors.line, borderWidth: 1, borderRadius: 10, overflow: "hidden", marginBottom: 10 },
  thead: { backgroundColor: colors.neutral },
  tr: { borderColor: colors.line, borderBottomWidth: 1 },
  th: { padding: 8 },
  td: { padding: 8 },
  link: { color: colors.blue, textDecorationLine: "underline" },
  hr: { backgroundColor: colors.line },
} satisfies MarkdownStyleMap);

type BlockProps = { node: ASTNode; signature: string; mode: "light" | "dark"; streaming: boolean;
  styles: ReturnType<typeof createMarkdownStyles>; rules: ReturnType<typeof createMarkdownRules> };
const MarkdownBlock = memo(function MarkdownBlock({ node, mode, streaming, styles, rules }: BlockProps) {
  return <Markdown colorScheme={mode} style={styles} textcomponent={streaming ? StreamingText : SelectableText}
    rules={rules} onLinkPress={openWebLink}>{[node]}</Markdown>;
}, (previous, next) => previous.signature === next.signature && previous.mode === next.mode
  && previous.streaming === next.streaming && previous.styles === next.styles && previous.rules === next.rules);

export function MessageBody({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const { mode } = useTheme();
  const markdownStyles = useThemedStyles(createMarkdownStyles);
  const markdownRules = useThemedStyles(createMarkdownRules);
  // Defer only the display projection. The caller keeps the entire received text;
  // completion bypasses the deferred value so the final characters never wait.
  const deferred = useDeferredValue(children);
  const source = streaming ? deferred : children;
  const blocks = useMemo(() => {
    let nodes: ASTNode[] = [];
    parser(streaming ? sealIncompleteMarkdown(source) : source, (value) => { nodes = value; return null; }, markdownParser);
    return nodes.map((node, index) => ({ node, key: `${index}:${node.type}`, signature: markdownBlockSignature(node) }));
  }, [source, streaming]);
  return <View style={{ minWidth: 0 }}>{blocks.map(({ node, key, signature }) => <MarkdownBlock key={key} node={node} signature={signature}
    mode={mode} streaming={streaming} styles={markdownStyles} rules={markdownRules} />)}</View>;
}
