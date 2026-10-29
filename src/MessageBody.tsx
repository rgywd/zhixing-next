import { memo, useDeferredValue, useMemo, type ReactNode } from "react";
import { ScrollView, Text, View, type TextProps } from "react-native";
import Markdown, { createMarkdownIt, parser, renderRules, sealIncompleteMarkdown, type ASTNode, type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { markdownBlockSignature } from "./messageMarkdown";
import { CopyAction } from "./CopyAction";

function CodeFence({ node, styles }: { node: ASTNode; styles: MarkdownStyleMap }) {
  const { colors, mode } = useTheme();
  const language = typeof node.sourceInfo === "string" ? node.sourceInfo.trim().split(/\s+/)[0] : "";
  return <View style={[styles._VIEW_SAFE_fence, { minWidth: 0 }]}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 12, backgroundColor: colors.neutral }}>
      <Text numberOfLines={1} style={[styles.fence_language_label, { flex: 1 }]}>{language || "代码"}</Text>
      <CopyAction text={node.content} label="复制代码" />
    </View>
    {renderRules(SelectableText).fence!(node, [], [], { ...styles,
      _VIEW_SAFE_fence: { borderWidth: 0, marginVertical: 0 },
      _VIEW_SAFE_fence_header: { display: "none" },
    }, undefined, mode)}
  </View>;
}

function SelectableText(props: TextProps) {
  return <Text selectable {...props} />;
}
function StreamingText(props: TextProps) {
  return <Text {...props} selectable={false} />;
}
const markdownParser = createMarkdownIt();
const tableRows = (node: ASTNode) => node.children.flatMap(part => part.children).filter(part => part.type === "tr");
const nodeText = (node: ASTNode): string => node.content || node.children.map(nodeText).join("");
const columnWidths = (node: ASTNode) => {
  const rows = tableRows(node), count = Math.max(1, ...rows.map(row => row.children.length));
  return Array.from({ length: count }, (_, index) => Math.min(220, Math.max(56, ...rows.map(row => {
    const text = row.children[index] ? nodeText(row.children[index]) : "";
    return [...text].reduce((width, char) => width + ((char.codePointAt(0) ?? 0) > 255 ? 15 : 8), 20);
  }))));
};
const tableWidth = (node: ASTNode) => columnWidths(node).reduce((total, width) => total + width, 0);
const cellStyle = (node: ASTNode, parents: ASTNode[]) => {
  const table = parents.find(part => part.type === "table"), row = parents.find(part => part.type === "tr");
  const index = row?.children.findIndex(part => part.key === node.key) ?? 0;
  const width = table ? columnWidths(table)[Math.max(0, index)] : 160;
  return { width, minWidth: width, maxWidth: width, flex: 0, flexGrow: 0, flexShrink: 0 };
};

const createMarkdownRules = (colors: ThemeColors) => ({
  fence: (node: ASTNode, _children: ReactNode[], _parents: ASTNode[], styles: MarkdownStyleMap) => <CodeFence key={node.key} node={node} styles={styles} />,
  code_block: (node: ASTNode, _children: ReactNode[], _parents: ASTNode[], styles: MarkdownStyleMap) => <CodeFence key={node.key} node={node} styles={styles} />,
  image: (node: ASTNode) => (
    <Text key={node.key} style={{ color: colors.muted }}>
      {node.attributes.alt || "[图片]"}
    </Text>
  ),
  table: (node: ASTNode, children: ReactNode[], _parents: ASTNode[], styles: MarkdownStyleMap) => {
    return <View key={node.key} style={{ minWidth: 0, marginVertical: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, backgroundColor: colors.neutral, borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
        <Text style={{ fontSize: 12, color: colors.muted, flex: 1 }}>表格 · 左右滑动</Text>
        <CopyAction text={tableRows(node).map(row => row.children.map(nodeText).join("\t")).join("\n")} label="复制表格" />
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <View style={[styles._VIEW_SAFE_table, { width: tableWidth(node) + 2 }]}>{children}</View>
      </ScrollView>
    </View>;
  },
  tr: (node: ASTNode, children: ReactNode[], parents: ASTNode[], styles: MarkdownStyleMap) => {
    const table = parents.find((part) => part.type === "table");
    return <View key={node.key} style={[styles._VIEW_SAFE_tr, { width: table ? tableWidth(table) : node.children.length * 160, flexDirection: "row", flexWrap: "nowrap" }]}>{children}</View>;
  },
  th: (node: ASTNode, children: ReactNode[], parents: ASTNode[], styles: MarkdownStyleMap) =>
    <View key={node.key} style={[styles._VIEW_SAFE_th, cellStyle(node, parents)]}>{children}</View>,
  td: (node: ASTNode, children: ReactNode[], parents: ASTNode[], styles: MarkdownStyleMap) =>
    <View key={node.key} style={[styles._VIEW_SAFE_td, cellStyle(node, parents)]}>{children}</View>,
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
  code_inline: { backgroundColor: colors.neutral, color: colors.ink, fontSize: 13, padding: 0, paddingHorizontal: 4, borderWidth: 0, borderRadius: 4 },
  code_block: { backgroundColor: colors.neutral, color: colors.ink, fontSize: 13, padding: 10, borderRadius: 10 },
  fence: { borderColor: colors.line, borderWidth: 1, borderRadius: 10, overflow: "hidden", marginVertical: 6 },
  fence_header: { backgroundColor: colors.neutral, borderBottomColor: colors.line },
  fence_language_label: { color: colors.muted },
  fence_copy_text: { color: colors.muted },
  fence_code: { backgroundColor: colors.surfaceRaised },
  blockquote: { backgroundColor: colors.neutral, borderLeftColor: colors.accent, borderLeftWidth: 3, paddingHorizontal: 10 },
  table: { borderColor: colors.line, borderWidth: 1, borderRadius: 10, overflow: "hidden", marginBottom: 10 },
  thead: { backgroundColor: colors.neutral },
  tr: { borderColor: colors.line, borderBottomWidth: 1 },
  th: { padding: 8 },
  td: { padding: 8 },
  link: { color: colors.blue, textDecorationLine: "underline" },
  hr: { backgroundColor: colors.line },
} satisfies MarkdownStyleMap);

type BlockProps = { node: ASTNode; signature: string; mode: "light" | "dark"; streaming: boolean;
  onOpenLink?: (url: string) => boolean; styles: ReturnType<typeof createMarkdownStyles>; rules: ReturnType<typeof createMarkdownRules> };
const MarkdownBlock = memo(function MarkdownBlock({ node, mode, streaming, styles, rules, onOpenLink }: BlockProps) {
  return <Markdown colorScheme={mode} style={styles} textcomponent={streaming ? StreamingText : SelectableText}
    rules={rules} onLinkPress={url => onOpenLink?.(url) ? false : openWebLink(url)}>{[node]}</Markdown>;
}, (previous, next) => previous.signature === next.signature && previous.mode === next.mode
  && previous.streaming === next.streaming && previous.styles === next.styles && previous.rules === next.rules && previous.onOpenLink === next.onOpenLink);

export function MessageBody({ children, streaming = false, onOpenLink }: { children: string; streaming?: boolean; onOpenLink?: (url: string) => boolean }) {
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
    mode={mode} streaming={streaming} onOpenLink={onOpenLink} styles={markdownStyles} rules={markdownRules} />)}</View>;
}
