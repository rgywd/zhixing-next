import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

// App navigation and publication receipts are sidecars, never invented native events.
const revision = z.object({
  request: z.string(), signature: z.string(), source: z.string(), seq: z.number().int(),
  kind: z.enum(['edit', 'retry']), child: z.string(), cut: z.number().int(),
  content: z.array(z.json()), accepted: z.boolean().optional(),
});
const artifact = z.object({ id: z.string(), toolSeq: z.number().int(), path: z.string(), content: z.array(z.json()) });
const spec = defineDomain({ name: 'zhixing_chat', version: 1, layout: 'per-record', tables: {
  revisions: domainTable(z.object({ active: z.string(), entries: z.array(revision) })),
  artifacts: domainTable(z.array(artifact)),
} });

export async function openChatStorage(ctx) {
  const domain = await ctx.storageDomain.open(spec);
  return { revisions: domain.table('revisions'), artifacts: domain.table('artifacts'), close: () => domain.close() };
}
