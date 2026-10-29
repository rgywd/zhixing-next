import { readFile } from 'node:fs/promises';
import { equal, fail, hash } from './common.mjs';
import { tableNames } from './service.mjs';

// Only an operator-selected startup file can import records. No public import endpoint.
export async function importBusiness(global, path) {
  const source = JSON.parse(await readFile(path, 'utf8'));
  if (source.format !== 'zhixing-business-export-v1' || !source.tables || source.sha256 !== hash(source.tables)) fail('Business export fingerprint mismatch');
  if (!equal(Object.keys(source.tables).sort(), [...tableNames].sort())) fail('Business export has missing or unexpected tables');
  for (const [table, rows] of Object.entries(source.tables)) {
    if (!Array.isArray(rows) || rows.length !== source.counts[table]) fail(`Record count mismatch: ${table}`);
    const keys = rows.map(r => table === 'finance_budgets' ? `${r.month}:${r.recurring}` : r.id ?? r.key ?? r.operation_key);
    if (keys.some(k => k == null) || new Set(keys).size !== keys.length) fail(`Invalid record identities: ${table}`);
    for (const row of rows) for (const [key, value] of Object.entries(row)) if (key.endsWith('_json')) JSON.parse(value);
  }
  if (source.tables.health_state.length !== 1 || source.tables.health_state[0].id !== 1) fail('Invalid health state');
  const lookup = table => new Set(source.tables[table].map(r => r.id));
  const finances = lookup('finance_transactions'), meals = lookup('health_meals'), events = lookup('life_events');
  for (const row of source.tables.finance_transactions) if (row.related_transaction_id && !finances.has(row.related_transaction_id)) fail('A refund is missing its original expense');
  for (const row of source.tables.life_events) if (!meals.has(row.meal_id) || (row.finance_id && !finances.has(row.finance_id))) fail('A linked meal or payment is missing');
  for (const row of source.tables.life_receipts) if (!events.has(row.event_id)) fail('A meal receipt is missing its event');
  for (const row of source.tables.health_writes) if (!tableNames.includes(`health_${row.entity_kind}`) || !lookup(`health_${row.entity_kind}`).has(row.entity_id)) fail('A health receipt is missing its record');
  const current = global.get();
  if (current.imported?.sha256 === source.sha256) return current.imported;
  if (current.imported || tableNames.some(k => k === 'health_state' ? current.tables[k][0].revision !== 0 || current.tables[k][0].reminders_revision !== 0 : current.tables[k].length > 0)) fail('Refusing to overwrite an existing business domain');
  const receipt = { sha256: source.sha256, counts: source.counts, source_schema: source.source_schema };
  await global.set({ tables: source.tables, imported: receipt });
  if (hash(global.get().tables) !== source.sha256) fail('Imported records failed read-back verification');
  return receipt;
}
