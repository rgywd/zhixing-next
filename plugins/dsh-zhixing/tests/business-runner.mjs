// Reference comparison driver, never loaded by the runtime plugin.
import { createInterface } from 'node:readline';
import { createBusinessService, emptyState } from '../business/service.mjs';
import { clock, copy } from '../business/common.mjs';
let state = emptyState(), counter = 0;
clock.now = () => '2026-10-29T04:00:00+00:00';
clock.id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const service = createBusinessService({ get: () => state, set: async value => { state = copy(value); } });
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const { path, method, body, seed } = JSON.parse(line);
    if (seed) { state = seed; console.log(JSON.stringify({ ok: true })); continue; }
    console.log(JSON.stringify({ result: await service.request(path, method, body) }));
  } catch (error) { console.log(JSON.stringify({ status: error.status ?? 500, error: error.message })); }
}
