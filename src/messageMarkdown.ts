import type { ASTNode } from "@ronradtke/react-native-markdown-display";

/** Parser keys are random on every parse. Compare the actual block instead. */
export function markdownBlockSignature(node: ASTNode): string {
  return JSON.stringify([node.type, node.sourceType, node.sourceInfo, node.sourceMeta, node.block,
    node.content, node.markup, node.attributes, node.children.map(markdownBlockSignature)]);
}
