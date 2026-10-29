import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

// Only navigation for native DSH forks; message logs and files belong to DSH.
const revision = z.object({
  request: z.string(), signature: z.string(), source: z.string(), seq: z.number().int(),
  kind: z.enum(['edit', 'retry']), child: z.string(), cut: z.number().int(),
  userIndex: z.number().int().nonnegative().optional(), group: z.string().optional(),
  content: z.array(z.json()), accepted: z.boolean().optional(),
});
const spec = defineDomain({ name: 'zhixing_chat', version: 2, compatibleVersions: [1], layout: 'per-record', tables: {
  revisions: domainTable(z.object({ active: z.string(), entries: z.array(revision) })),
} });

export async function openChatStorage(ctx) {
  const domain = await ctx.storageDomain.open(spec);
  return { revisions: domain.table('revisions'), close: () => domain.close() };
}
