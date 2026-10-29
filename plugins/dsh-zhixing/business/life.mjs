import { createHash } from 'node:crypto';
import { clock, equal, fail, stable, text } from './common.mjs';
import { Finance } from './finance.mjs';
import { Health } from './health.mjs';

const mealFields = new Set(['occurred_at', 'meal_type', 'description', 'portion', 'status', 'recommendation_id', 'note', 'estimated_energy']);
const actualMeal = data => {
  if (!data || Array.isArray(data) || Object.keys(data).some(k => !mealFields.has(k))) fail('Specify only actual meal fields');
  return data;
};
export class Life {
  constructor(tables) { this.t = tables; this.finance = new Finance(tables); this.health = new Health(tables); }
  source(source, entry) {
    text(source, 'source message ID', 200, false); entry = text(entry, 'entry key', 200, false);
    return createHash('sha256').update(`${source}:${entry}`).digest('hex');
  }
  mutate(key, eventId, request, operation) {
    const previous = this.t.life_receipts.find(r => r.operation_key === key);
    if (previous) {
      if (!equal(JSON.parse(previous.request_json), request)) fail('This request ID identifies different meal/payment data', 'idempotency_conflict', 409);
      return JSON.parse(previous.result_json);
    }
    const result = operation();
    this.t.life_receipts.push({ operation_key: key, event_id: eventId, request_json: stable(request), result_json: stable(result) });
    return result;
  }
  record({ source_id, entry_key, conversation_id, meal, amount = null, occurred_on = null, note = '' }) {
    const source = this.source(source_id, entry_key), key = `life:record:${source}`, id = `life:${source}`;
    actualMeal(meal); text(conversation_id, 'conversation ID', 200, false);
    if (amount != null && !occurred_on) fail('An explicit payment needs its business date');
    return this.mutate(key, id, { meal, amount, occurred_on, note }, () => {
      if (this.t.life_events.some(r => r.id === id)) fail('This meal event already exists; correct it in place', 'idempotency_conflict', 409);
      const finance = amount == null ? null : this.finance.create({ idempotency_key: `${key}:finance`, kind: 'expense', amount, occurred_on, bucket: 'daily', category: '餐饮', note, conversation_id, source_id });
      const actual = this.health.create('meals', { ...meal, id: `life-meal:${source}`, source_id, conversation_id }, `${key}:meal`);
      this.t.life_events.push({ id, source_id, entry_key, conversation_id, finance_id: finance?.id ?? null, meal_id: actual.id, created_at: clock.now() });
      return { event_id: id, saved: true, atomic: true, finance, meal: actual, payment_recorded: !!finance };
    });
  }
  correct(id, { source_id, entry_key, meal_changes = {}, finance_changes = {} }) {
    const key = `life:correct:${this.source(source_id, entry_key)}`;
    actualMeal(meal_changes);
    if (Object.keys(finance_changes).some(k => !['amount', 'occurred_on', 'note', 'category'].includes(k))) fail('Unsupported linked payment correction');
    if (!Object.keys(meal_changes).length && !Object.keys(finance_changes).length) fail('Provide a meal or payment correction');
    return this.mutate(key, id, { event_id: id, meal_changes, finance_changes }, () => {
      const event = this.t.life_events.find(r => r.id === id);
      if (!event) fail('Linked meal event not found', 'not_found', 404);
      let actual = this.health.require('meals', event.meal_id), finance = event.finance_id ? this.finance.require(event.finance_id) : null;
      if (Object.keys(finance_changes).length && !finance) fail('This event has no payment; record an explicit payment separately');
      if (Object.keys(meal_changes).length) actual = this.health.update('meals', event.meal_id, { ...meal_changes, revision: actual.revision }, `${key}:meal`, true);
      if (Object.keys(finance_changes).length) finance = this.finance.update(event.finance_id, { ...finance_changes, expected_revision: finance.revision, idempotency_key: `${key}:finance` });
      return { event_id: id, saved: true, atomic: true, finance, meal: actual, payment_recorded: !!finance };
    });
  }
  list(source, limit = 30) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid limit');
    return { items: this.t.life_events.filter(r => !source || r.source_id === source).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, limit).map(r => ({ ...r,
      meal_deleted: !!(this.t.health_meals.find(m => m.id === r.meal_id)?.deleted ?? true),
      finance_deleted: r.finance_id ? !!(this.t.finance_transactions.find(f => f.id === r.finance_id)?.deleted ?? true) : null })) };
  }
}
