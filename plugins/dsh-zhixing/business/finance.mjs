import { cents, clock, copy, day, divide, equal, fail, fmt, hash, money, month, monthEnd, stable, text, validate } from './common.mjs';
import { financeSummary } from './finance-summary.mjs';

const fields = ['kind', 'amount', 'occurred_on', 'bucket', 'category', 'note', 'commitment_key', 'related_transaction_id', 'conversation_id', 'source_id', 'entry_type', 'period_start', 'date_precision', 'date_start', 'date_end', 'coverage_start', 'coverage_end'];
const changeFields = fields.filter(k => !['conversation_id', 'source_id'].includes(k));
const blankBudget = m => ({ month: m, source_month: null, recurring: true, expected_income: null, savings_target: null, daily_budget: null,
  commitments: [], coverage_start: null, coverage_through: null, income_schedule: null, revision: 0 });
const conflict = message => fail(message, 'revision_conflict', 409);
const purposes = item => {
  const clean = s => s.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
  const label = item.label.toLowerCase(), result = new Set([`label:${clean(label)}`]);
  if (item.purpose) result.add(`purpose:${clean(item.purpose)}`);
  for (const [name, pattern] of Object.entries({ housing: /房租|租金|租住|租房|\brent\b|\brental\b/, commute: /通勤|地铁|\bcommut(?:e|ing)\b|\bsubway\b/, telecom: /话费|手机套餐|移动通信|通讯费|通信费|\bmobile plan\b|\bphone bill\b/ })) if (pattern.test(label)) result.add(`purpose:${name}`);
  result.add(`label:${clean(label.replace(/[（(][^）)]*(?:月度|年度|预留|分摊|每月|每年|季度)[^）)]*[）)]/g, ''))}`);
  return result;
};

export class Finance {
  constructor(tables) { this.t = tables; }
  record(row) { return { ...row, deleted: !!row.deleted }; }
  require(id, deleted = false) {
    const row = this.t.finance_transactions.find(r => r.id === id && (deleted || !r.deleted));
    if (!row) fail('Finance transaction not found', 'not_found', 404);
    return this.record(row);
  }
  mutate(key, request, operation) {
    key = text(key, 'idempotency key', 300, false);
    const fingerprint = hash(request), previous = this.t.finance_mutations.find(r => r.key === key);
    if (previous) {
      if (previous.request_hash !== fingerprint) fail('This request ID was already used for different fields', 'idempotency_conflict', 409);
      return JSON.parse(previous.result_json);
    }
    const result = operation();
    this.t.finance_mutations.push({ key, request_hash: fingerprint, result_json: stable(result), created_at: clock.now() });
    return result;
  }
  budget(value, override = true) {
    const m = month(value), base = blankBudget(m);
    const rows = this.t.finance_budgets.filter(r => r.recurring ? r.month <= m : override && r.month === m)
      .sort((a, b) => b.recurring - a.recurring || a.month.localeCompare(b.month));
    for (const row of rows) {
      const data = JSON.parse(row.data_json);
      if (!data.__patch__) Object.assign(base, data);
      else {
        Object.assign(base, Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('__'))));
        const items = new Map(base.commitments.map(i => [i.key, i]));
        for (const item of data.__commitments_upsert ?? []) items.set(item.key, item);
        for (const key of data.__commitment_keys_remove ?? []) items.delete(key);
        base.commitments = [...items.values()];
      }
      if (row.month !== m) { base.commitments = base.commitments.filter(i => i.kind === 'fixed'); base.coverage_start = base.coverage_through = null; }
      Object.assign(base, { month: m, source_month: row.month, recurring: !!row.recurring, revision: row.revision, updated_at: row.updated_at });
    }
    return base;
  }
  asPatch(data, inherited) {
    if (data.__patch__) return copy(data);
    const result = { __patch__: true };
    for (const [k, value] of Object.entries(data)) if (k !== 'commitments' && !equal(value, inherited[k])) result[k] = value;
    result.__commitments_upsert = data.commitments.filter(item => !equal(item, inherited.commitments.find(i => i.key === item.key)));
    result.__commitment_keys_remove = inherited.commitments.filter(item => !data.commitments.some(i => i.key === item.key)).map(i => i.key).sort();
    return result;
  }
  commitments(items = []) {
    const normalized = items.map(raw => {
      const item = Object.fromEntries(Object.entries(raw).filter(([, value]) => value != null));
      Object.assign(item, { key: text(item.key, 'commitment key', 100, false), label: text(item.label, 'commitment label', 100, false), amount: money(item.amount), every_months: item.every_months ?? 1 });
      for (const key of ['anchor_month', 'paid_through']) if (item[key]) item[key] = month(item[key]);
      if (item.every_months > 1 && !item.anchor_month) fail('A multi-month payment needs its first known due month');
      if (item.monthly_cost != null) {
        item.monthly_cost = money(item.monthly_cost);
        if (cents(item.monthly_cost) !== divide(cents(item.amount), item.every_months, true)) fail('Monthly cost must equal the actual payment divided by its cycle');
      }
      if (item.purpose != null) item.purpose = text(item.purpose, 'commitment purpose', 100, false);
      item.separate_from_keys = (item.separate_from_keys ?? []).map(k => text(k, 'separate commitment key', 100, false));
      return item;
    });
    if (new Set(normalized.map(i => i.key)).size !== normalized.length) fail('Commitment keys must be unique');
    return normalized;
  }
  incomeSchedule(value) {
    if (value == null) return null;
    const result = { day: null, weekdays: [0, 1, 2, 3, 4], working_dates: [], non_working_dates: [], ...value };
    if (!result.weekdays.length || result.weekdays.some(v => !Number.isInteger(v) || v < 0 || v > 6)) fail('Weekdays must run from Monday=0 to Sunday=6');
    for (const k of ['working_dates', 'non_working_dates']) result[k] = result[k].map(day);
    if (result.working_dates.some(d => result.non_working_dates.includes(d))) fail('A date cannot be both working and non-working');
    result.calendar_basis = result.working_dates.length || result.non_working_dates.length ? 'user_overrides' : 'weekdays_only';
    if (result.rule === 'day_of_month' && result.day == null) fail('day_of_month requires day');
    return result;
  }
  checkBudgetRevision(current, body) {
    if (body.expected_revision != null && (current.revision !== body.expected_revision || current.source_month !== (body.expected_source_month ?? null))) conflict('This budget changed; reload before saving');
  }
  checkCoverage(m, data) {
    const a = data.coverage_start, b = data.coverage_through;
    if ((a == null) !== (b == null) || (a != null && (day(a).slice(0, 7) !== m || day(b).slice(0, 7) !== m || a > b))) fail('Coverage dates must be ordered within the selected month, or both cleared');
  }
  storeBudget(m, recurring, data) {
    const old = this.t.finance_budgets.find(r => r.month === m && !!r.recurring === recurring);
    const row = { month: m, recurring: Number(recurring), data_json: stable(data), revision: (old?.revision ?? 0) + 1, updated_at: clock.now() };
    if (old) Object.assign(old, row); else this.t.finance_budgets.push(row);
  }
  setBudget(body) {
    const b = validate('BudgetInput', body), m = month(b.month), recurring = b.recurring;
    const data = { expected_income: money(b.expected_income, true), savings_target: money(b.savings_target, true), daily_budget: money(b.daily_budget, true),
      commitments: this.commitments(b.commitments), coverage_start: b.coverage_start, coverage_through: b.coverage_through,
      income_schedule: this.incomeSchedule(Object.hasOwn(body, 'income_schedule') ? b.income_schedule : this.budget(m).income_schedule) };
    this.checkCoverage(m, data);
    return this.mutate(b.idempotency_key, { op: 'budget', month: m, recurring, expected_revision: b.expected_revision, expected_source_month: b.expected_source_month, ...data }, () => {
      this.checkBudgetRevision(this.budget(m), b);
      this.storeBudget(m, recurring, recurring ? data : this.asPatch(data, this.budget(m, false)));
      if (recurring) this.t.finance_budgets = this.t.finance_budgets.filter(r => r.month !== m || r.recurring);
      return this.budget(m);
    });
  }
  patchBudget(body) {
    const b = validate('BudgetPatch', body), m = month(b.month), c = Object.fromEntries(Object.keys(body.changes).map(k => [k, copy(b.changes[k])])), clear = c.clear_fields ?? [];
    delete c.clear_fields;
    if (Object.values(c).some(v => v === null) || clear.some(k => Object.hasOwn(c, k))) fail('Omit unchanged fields; use clear_fields to clear a field');
    if (Object.hasOwn(c, 'commitments')) {
      if (Object.hasOwn(body.changes, 'commitments_upsert')) fail('Use one commitment upsert list');
      c.commitments_upsert = c.commitments; delete c.commitments;
    }
    const upserts = this.commitments(c.commitments_upsert), removed = c.commitment_keys_remove ?? [];
    delete c.commitments_upsert; delete c.commitment_keys_remove;
    if (removed.some(k => upserts.some(i => i.key === k))) fail('A commitment cannot be changed and removed together');
    for (const k of ['expected_income', 'savings_target', 'daily_budget']) if (Object.hasOwn(c, k)) c[k] = money(c[k]);
    if (Object.hasOwn(c, 'income_schedule')) c.income_schedule = this.incomeSchedule(c.income_schedule);
    for (const k of ['coverage_start', 'coverage_through']) if (Object.hasOwn(c, k)) c[k] = day(c[k]);
    for (const k of clear) c[k] = null;
    return this.mutate(b.idempotency_key, { op: 'patch_budget', month: m, recurring: b.recurring, changes: c, upserts, removed,
      expected_revision: b.expected_revision, expected_source_month: b.expected_source_month }, () => {
      const current = this.budget(m); this.checkBudgetRevision(current, b);
      const candidates = new Map(current.commitments.filter(i => !removed.includes(i.key)).map(i => [i.key, i]));
      for (const i of upserts) candidates.set(i.key, i);
      const items = [...candidates.values()], changed = new Set([...upserts.map(i => i.key), ...removed]);
      for (let n = 0; n < items.length; n++) for (const other of items.slice(n + 1)) {
        const item = items[n];
        if (![item.key, other.key].some(k => changed.has(k)) || item.kind !== other.kind || item.separate_from_keys?.includes(other.key) || other.separate_from_keys?.includes(item.key)) continue;
        if ([...purposes(item)].some(p => purposes(other).has(p))) fail('A same-purpose commitment exists; reuse its key or explicitly replace it', 'duplicate_commitment', 409);
      }
      const previous = this.t.finance_budgets.find(r => r.month === m && !!r.recurring === b.recurring);
      const data = { ...(previous ? JSON.parse(previous.data_json) : { __patch__: true }), ...c };
      const key = data.__patch__ ? '__commitments_upsert' : 'commitments', saved = new Map((data[key] ?? []).map(i => [i.key, i]));
      for (const i of upserts) saved.set(i.key, i);
      for (const k of removed) saved.delete(k);
      data[key] = [...saved.values()];
      if (data.__patch__) data.__commitment_keys_remove = [...new Set([...(data.__commitment_keys_remove ?? []), ...removed])].filter(k => !upserts.some(i => i.key === k)).sort();
      if (b.recurring) {
        const override = this.t.finance_budgets.find(r => r.month === m && !r.recurring);
        if (override) {
          const delta = this.asPatch(JSON.parse(override.data_json), this.budget(m, false));
          for (const k of Object.keys(c)) delete delta[k];
          delta.__commitments_upsert = (delta.__commitments_upsert ?? []).filter(i => !changed.has(i.key));
          delta.__commitment_keys_remove = (delta.__commitment_keys_remove ?? []).filter(k => !changed.has(k));
          this.storeBudget(m, false, delta);
        }
      }
      this.storeBudget(m, b.recurring, data);
      const result = this.budget(m); this.checkCoverage(m, result);
      if (upserts.some(i => !equal(i, result.commitments.find(j => j.key === i.key))) || removed.some(k => result.commitments.some(i => i.key === k)) || Object.entries(c).some(([k, v]) => !equal(result[k], v))) fail('Budget write verification failed', 'write_verification_failed', 409);
      const verified = this.summary(m);
      return { ...result, verification: { saved_fields: Object.keys(c).sort(), effective_commitments: result.commitments, monthly_cost: verified.commitments.monthly_cost,
        cash_due: verified.commitments.cash_due, remaining_due: verified.reservations.total, items: verified.commitments.items, checked_against_saved_records: true } };
    });
  }
  deleteBudget(m, recurring, key) {
    m = month(m);
    return this.mutate(key, { op: 'delete_budget', month: m, recurring }, () => { this.t.finance_budgets = this.t.finance_budgets.filter(r => r.month !== m || !!r.recurring !== recurring); return this.budget(m); });
  }
  validateTransaction(input, id = null) {
    const data = { bucket: 'daily', category: '其他', note: '', entry_type: 'detail', date_precision: 'day', ...input };
    if (!['expense', 'income', 'transfer', 'refund'].includes(data.kind) || !['daily', 'fixed', 'one_time'].includes(data.bucket)) fail('Invalid transaction kind or bucket');
    data.amount = money(data.amount); if (!cents(data.amount)) fail('Transaction amount must be positive');
    if (data.occurred_on && data.date_end && data.occurred_on !== data.date_end) fail('occurred_on conflicts with date_end');
    let end = data.date_end || data.occurred_on, begin = data.date_start;
    if (data.date_precision === 'month') {
      const value = begin || end;
      if (typeof value !== 'string' || ![7, 10].includes(value.length)) fail('Month precision needs an explicit month');
      if (value.length === 10) day(value);
      const m = month(value.slice(0, 7));
      if ([begin, end].some(v => v && v.slice(0, 7) !== m)) fail('Use a full date range when the actual month is unknown');
      begin = `${m}-01`; end = monthEnd(m);
    } else if (data.date_precision === 'day') { end = day(end); begin ||= end; if (begin !== end) fail('An exact day cannot contain a date range'); }
    else if (data.date_precision === 'range') { begin = day(begin); end = day(end); if (begin > end) fail('Date range is reversed'); }
    else fail('Invalid date precision');
    Object.assign(data, { date_start: day(begin), date_end: day(end), occurred_on: end });
    if ((data.coverage_start == null) !== (data.coverage_end == null)) fail('Payment coverage requires both months');
    for (const k of ['coverage_start', 'coverage_end']) data[k] = data[k] == null ? null : month(data[k]);
    if (data.coverage_start && (data.kind !== 'expense' || data.coverage_start > data.coverage_end)) fail('Payment coverage must be an ordered expense range');
    data.category = text(data.category, 'category', 100, false); data.note = text(data.note, 'note');
    const asset = /(?:公积金|存款|账户余额|已有余额|原有资产|储蓄|自己账户|自有账户).{0,24}(?:提取|提现|提款|取出|转出|转入)|(?:提取|提现|提款|取出).{0,12}(?:公积金|存款|账户余额|储蓄)|(?:赎回|取回|收回).{0,8}本金|(?:provident fund|savings|deposit|existing balance|own account).{0,24}(?:withdrawal|withdraw|transfer)|(?:withdraw|withdrawal).{0,12}(?:provident fund|savings|deposit|existing balance)|(?:redeem|redemption).{0,12}principal/i;
    if (data.kind === 'income' && asset.test(`${data.category} ${data.note}`)) fail('已有资产提取或转移应记为 transfer，不能重复记为新增收入。', 'existing_asset_is_transfer');
    for (const k of ['commitment_key', 'conversation_id', 'source_id']) data[k] = data[k] == null ? null : text(data[k], k, 200, false);
    data.related_transaction_id ??= null;
    const active = this.t.finance_transactions.filter(r => !r.deleted);
    if (data.kind === 'refund') {
      if (!data.related_transaction_id || data.related_transaction_id === id) fail('A refund must reference its original expense');
      const original = this.require(data.related_transaction_id);
      if (original.kind !== 'expense' || original.entry_type !== 'detail') fail('Refunds require a detailed expense');
      const refunded = active.filter(r => r.related_transaction_id === original.id && r.id !== id).reduce((n, r) => n + cents(r.amount), 0n);
      if (refunded + cents(data.amount) > cents(original.amount)) fail('Refunds cannot exceed the original expense');
      if (data.date_end < original.date_start) fail('Refund date cannot precede the expense');
      data.bucket = original.bucket; data.commitment_key = original.commitment_key;
    } else if (data.related_transaction_id) fail('Only refunds reference an original expense');
    if (data.commitment_key && !['expense', 'refund'].includes(data.kind)) fail('Only expenses or refunds match a spending commitment');
    if (data.commitment_key && data.kind === 'expense') {
      const commitment = this.budget(end.slice(0, 7)).commitments.find(i => i.key === data.commitment_key);
      if (commitment && commitment.kind !== data.bucket) fail('Payment bucket must match its commitment');
    }
    data.period_start ??= null;
    if (data.entry_type === 'aggregate') {
      if (!['expense', 'income'].includes(data.kind) || data.commitment_key) fail('Cumulative totals require income or unlinked expenses');
      const start = day(data.period_start);
      if (start.slice(0, 7) !== end.slice(0, 7) || start > end) fail('Cumulative totals must stay within one month');
      if (active.some(r => r.entry_type === 'aggregate' && r.kind === data.kind && r.bucket === data.bucket && r.id !== id && r.period_start <= end && r.occurred_on >= start)) fail('Cumulative totals cannot overlap');
    } else if (data.entry_type !== 'detail' || data.period_start !== null) fail('Invalid entry type or period start');
    const refunds = active.filter(r => r.related_transaction_id === id && id);
    if (id && data.kind === 'expense' && (refunds.reduce((n, r) => n + cents(r.amount), 0n) > cents(data.amount) || refunds.some(r => r.date_end < data.date_start))) fail('Expense amount or date conflicts with its refunds');
    return Object.fromEntries(fields.map(k => [k, data[k]]));
  }
  create(body, nested = false) {
    const b = validate('TransactionInput', body), { idempotency_key: key, ...values } = b;
    const operation = () => {
      const data = this.validateTransaction(values), now = clock.now();
      const row = { id: clock.id(), ...data, revision: 1, deleted: 0, created_at: now, updated_at: now };
      this.t.finance_transactions.push(row); return this.record(row);
    };
    return nested ? operation() : this.mutate(key, { op: 'create', ...values }, operation);
  }
  update(id, body, nested = false) {
    const b = validate('TransactionUpdate', body, { partial: true }), { idempotency_key: key, expected_revision: revision = null, ...changes } = b;
    const operation = () => {
      const current = this.require(id);
      if (revision != null && revision !== current.revision) conflict('This record changed; reload before correcting');
      if (current.kind === 'expense' && ((changes.kind ?? 'expense') !== 'expense' || (changes.entry_type ?? current.entry_type) !== 'detail') && this.t.finance_transactions.some(r => !r.deleted && r.related_transaction_id === id)) fail('Correct linked refunds before changing the expense kind');
      const merged = { ...current, ...changes }, has = k => Object.hasOwn(changes, k);
      if (has('occurred_on') && !['date_start', 'date_end', 'date_precision'].some(has)) Object.assign(merged, { date_start: null, date_end: null, date_precision: 'day' });
      else if (['date_start', 'date_end', 'date_precision'].some(has)) {
        if (merged.date_precision === 'day' && changes.occurred_on) { merged.date_start = changes.date_start; merged.date_end = changes.date_end; }
        else if (merged.date_precision === 'month' && (has('date_start') || has('occurred_on')) && !has('date_end')) merged.date_end = null;
        merged.occurred_on = changes.occurred_on || merged.date_end;
      }
      const data = this.validateTransaction(merged, id), row = this.t.finance_transactions.find(r => r.id === id);
      Object.assign(row, Object.fromEntries(changeFields.map(k => [k, data[k]])), { revision: row.revision + 1, updated_at: clock.now() });
      if (row.kind === 'expense') for (const refund of this.t.finance_transactions.filter(r => !r.deleted && r.related_transaction_id === id)) Object.assign(refund, { bucket: row.bucket, commitment_key: row.commitment_key, revision: refund.revision + 1, updated_at: clock.now() });
      return this.record(row);
    };
    return nested ? operation() : this.mutate(key, { op: 'update', id, expected_revision: revision, ...changes }, operation);
  }
  delete(id, key, nested = false) {
    const operation = () => {
      this.require(id, true);
      if (this.t.finance_transactions.some(r => !r.deleted && r.related_transaction_id === id)) fail('Correct linked refunds before deleting the expense');
      const row = this.t.finance_transactions.find(r => r.id === id);
      if (!row.deleted) Object.assign(row, { deleted: 1, revision: row.revision + 1, updated_at: clock.now() });
      return { deleted: true, id };
    };
    return nested ? operation() : this.mutate(key, { op: 'delete', id }, operation);
  }
  batch(body) {
    const b = validate('TransactionBatch', body), operations = b.operations.map((op, i) => Object.fromEntries(Object.keys(body.operations[i]).map(k => [k,
      k === 'fields' ? Object.fromEntries(Object.keys(body.operations[i].fields).map(f => [f, op.fields[f]])) : op[k]])));
    const ids = operations.filter(i => i.operation !== 'create').map(i => i.transaction_id);
    if (ids.some(i => !i) || new Set(ids).size !== ids.length) fail('Identify each existing transaction once');
    if (!b.conserve_total) text(b.reason, 'reason', 1000, false);
    return this.mutate(b.idempotency_key, { op: 'batch', operations, conserve_total: b.conserve_total, reason: b.reason, conversation_id: null, source_id: null }, () => {
      const totals = rows => rows.reduce((sum, r) => { sum[r.kind === 'refund' ? 'expense' : r.kind] += cents(r.amount) * (r.kind === 'refund' ? -1n : 1n); return sum; }, { expense: 0n, income: 0n, transfer: 0n });
      const before = totals(ids.map(id => this.require(id))), afterRows = [], items = [];
      for (const item of operations) {
        const fields = item.fields ?? {}; let record;
        if (item.operation === 'create') {
          if (item.transaction_id || item.expected_revision) fail('Create cannot reference an existing transaction');
          record = this.create({ ...fields, idempotency_key: 'batch' }, true);
        } else if (item.operation === 'update') {
          if (!Object.keys(fields).length) fail('Update needs changed fields');
          record = this.update(item.transaction_id, { ...fields, expected_revision: item.expected_revision, idempotency_key: 'batch' }, true);
        } else {
          if (Object.keys(fields).length) fail('Delete cannot contain changed fields');
          if (item.expected_revision != null && this.require(item.transaction_id).revision !== item.expected_revision) conflict('Record changed before deletion');
          record = this.delete(item.transaction_id, 'batch', true);
        }
        items.push({ operation: item.operation, record }); if (item.operation !== 'delete') afterRows.push(record);
      }
      const after = totals(afterRows), conserved = Object.keys(before).every(k => before[k] === after[k]);
      if (ids.length && b.conserve_total && !conserved) fail('Split/replacement totals differ; nothing saved', 'batch_total_mismatch', 409);
      return { items, before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, fmt(v)])), after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, fmt(v)])), conserved, verified: true };
    });
  }
  list(m, limit = 50, offset = 0) {
    m = month(m);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) fail('Invalid pagination');
    const items = this.t.finance_transactions.filter(r => !r.deleted && r.date_start <= monthEnd(m) && r.date_end >= `${m}-01`).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return { items: items.slice(offset, offset + limit).map(r => this.record(r)), total: items.length };
  }
  summary(m, asOf) { return financeSummary(this, m, asOf); }
}
