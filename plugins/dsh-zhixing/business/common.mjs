import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
const contracts = JSON.parse(readFileSync(new URL('./contracts.json', import.meta.url), 'utf8'));

export const fail = (message, code = 'invalid_business_record', status = 422) => {
  throw Object.assign(new Error(message), { code, status });
};
export const copy = value => structuredClone(value);
export const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const hash = value => createHash('sha256').update(stable(value)).digest('hex');
export const equal = (a, b) => stable(a) === stable(b);
export const clock = { now: () => new Date().toISOString(), id: () => randomUUID() };
export function text(value, name = 'text', max = 1000, empty = true) {
  if (typeof value !== 'string' || [...value.trim()].length > max || (!empty && !value.trim())) fail(`Invalid ${name}`);
  return value.trim();
}
export function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') fail('Use a calendar date in YYYY-MM-DD format');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('Invalid calendar date');
  return value;
}
export function today(timezone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(clock.now())).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function month(value = today().slice(0, 7)) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) fail('Use a month in YYYY-MM format');
  day(`${value}-01`); return value;
}
export function monthEnd(value) {
  const d = new Date(`${month(value)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000;
export const monthNumber = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
export const numberMonth = value => `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
export const min = (a, b) => a < b ? a : b;
export const max = (a, b) => a > b ? a : b;
export const cents = value => {
  const match = String(value).trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/);
  if (!match || !(match[2] || match[3]) || String(value).length > 100) fail('Amount must be decimal text');
  const precision = (match[3] ?? '').length - Number(match[4] ?? 0);
  if (precision > 2 || precision < -14) fail('Amount must have at most two decimal places');
  const n = BigInt((match[2] || '0') + (match[3] ?? '')) * 10n ** BigInt(2 - precision);
  if (n >= 100000000000000n || (match[1] === '-' && n !== 0n)) fail('Amount must be nonnegative and below 1000000000000');
  return n;
};
export function fmt(n) {
  if (n === null || n === undefined) return null;
  const sign = n < 0n ? '-' : ''; const a = n < 0n ? -n : n;
  return `${sign}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
export const money = (value, nullable = false) => value == null && nullable ? null : fmt(cents(value));
export function divide(n, denominator, halfUp = false) {
  const d = BigInt(denominator), sign = n < 0n ? -1n : 1n, a = n * sign;
  const q = a / d, r = a % d;
  return sign * (q + (r * 2n > d || (r * 2n === d && (halfUp || q % 2n === 1n)) ? 1n : 0n));
}
const validators = new Map();
export function validate(name, value, { partial = false, trim = false } = {}) {
  let schema = validators.get(name);
  if (!schema) { schema = z.fromJSONSchema(contracts[name]); validators.set(name, schema); }
  const input = trim ? JSON.parse(JSON.stringify(value), (_k, v) => typeof v === 'string' ? v.trim() : v) : value;
  const parsed = (partial ? schema.partial() : schema).safeParse(input);
  if (!parsed.success) fail(`Invalid ${name}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  // A partial correction must not inject defaults into fields the caller omitted.
  return partial ? Object.fromEntries(Object.keys(value).map(key => [key, parsed.data[key]])) : parsed.data;
}
export { contracts };
