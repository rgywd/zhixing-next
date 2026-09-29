import { Text, type TextProps } from "react-native";
import Markdown, { type ASTNode, type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import { colors } from "./theme";

function SelectableText(props: TextProps) {
  return <Text selectable {...props} />;
}

const markdownRules = {
  image: (node: ASTNode) => (
    <Text key={node.key} style={{ color: colors.muted }}>
      {node.attributes.alt || "[图片]"}
    </Text>
  ),
};

const openWebLink = (url: string) => /^https?:\/\//i.test(url);

const markdownStyles = {
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
  fence_code: { backgroundColor: colors.white },
  blockquote: { backgroundColor: colors.pale, borderLeftColor: colors.accent, borderLeftWidth: 3, paddingHorizontal: 10 },
  table: { borderColor: colors.line, borderWidth: 1, borderRadius: 10, overflow: "hidden", marginBottom: 10 },
  thead: { backgroundColor: colors.neutral },
  tr: { borderColor: colors.line, borderBottomWidth: 1 },
  th: { padding: 8 },
  td: { padding: 8 },
  link: { color: colors.accent, textDecorationLine: "underline" },
} satisfies MarkdownStyleMap;

export function MessageBody({ children }: { children: string }) {
  return <Markdown style={markdownStyles} textcomponent={SelectableText} rules={markdownRules} onLinkPress={openWebLink}>{children}</Markdown>;
}
