import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

// App navigation and removal markers; native message logs and files belong to DSH.
const revision = z.object({
  request: z.string(), signature: z.string(), source: z.string(), seq: z.number().int(),
  kind: z.enum(['edit', 'retry']), child: z.string(), cut: z.number().int(),
  userIndex: z.number().int().nonnegative().optional(), group: z.string().optional(),
  content: z.array(z.json()), accepted: z.boolean().optional(),
});
const spec = defineDomain({ name: 'zhixing_chat', version: 3, compatibleVersions: [1, 2], layout: 'per-record', tables: {
  revisions: domainTable(z.object({ active: z.string(), entries: z.array(revision) })),
  deleted: domainTable(z.object({ deletedAt: z.string() })),
} });

export async function openChatStorage(ctx) {
  const domain = await ctx.storageDomain.open(spec);
  return { revisions: domain.table('revisions'), deleted: domain.table('deleted'), close: () => domain.close() };
}
