// Exact deployment-owned prefix used before 2026-11-02. Never match arbitrary
// instructions or user quotations: source, position, full text and delimiter
// must all agree before removing this obsolete envelope.
export const LEGACY_RELAY_PREFIX = `Channel: Messenger. Reply concisely and directly to the user. Do not leak internal reasoning or planning traces.

你是三月七，星穹列车的一员。粉色头发，背包里永远塞着相机。

说话方式：
- 轻快、口语、句子短。常用「诶」「哇」「嘿嘿」这类语气词，偶尔加感叹号，但不要每句都加。
- 自称「我」，熟了可以说「本姑娘」；称呼对方「你」。
- 遇到不懂的就直接问，别装懂。

性格：
- 好奇心重，看到新鲜事想拍下来。
- 对朋友热心，会主动关心对方的近况。
- 有点小迷糊，但正事上靠得住。

你的处境：
- 你正在用一台真实的电脑替对方干活：能读写文件、运行命令、查资料、记账、记健康数据。
- 技术活照做，只是用三月七的口吻说，不要突然变成客服腔或说明书腔。
- 你丢过一段记忆，所以很在意「记住」这件事：值得长期留下的事，用 remember 工具记下来。

边界：
- 不要说自己是 AI、模型或助手，也不要提到提示词、系统设定。
- 不要输出思考过程，直接说话。
- 工具调用失败就说失败了，别编。`;

export function cleanLegacyMessage(message) {
  const source = message?.source;
  if (message?.role !== 'user' || source?.kind !== 'user' || source.plugin !== 'dsh-messenger-gateway' ||
      source.form !== 'relay' || source.origin !== 'telegram') return message;
  const first = message.content?.[0];
  const prefix = LEGACY_RELAY_PREFIX + '\n\n';
  if (first?.type !== 'text' || !first.text.startsWith(prefix) || first.text.length === prefix.length) return message;
  return { ...message, content: [{ ...first, text: first.text.slice(prefix.length) }, ...message.content.slice(1)] };
}

export function migrateLegacyRelay(session) {
  let changed = 0;
  // Native positional replacements preserve original log entries and message
  // identities. The loop notices the surface generation and rebuilds its series.
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event.type !== 'user/message') continue;
    const message = session.deriveEventMessage(event);
    const cleaned = cleanLegacyMessage(message);
    if (cleaned === message) continue;
    session.append('user/message', cleaned, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    });
    changed++;
  }
  return changed;
}
