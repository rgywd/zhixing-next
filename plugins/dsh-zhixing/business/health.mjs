import { clock, copy, day, equal, fail, max, min, stable, text, today, validate } from './common.mjs';

const models = { rules: 'RuleInput', meals: 'MealInput', weights: 'WeightInput', steps: 'StepsInput', recommendations: 'RecommendationInput', feedback: 'FeedbackInput' };
const editable = new Set(['rules', 'meals', 'weights', 'steps']);
const profileLists = ['activity_limitations', 'food_allergies', 'food_exclusions', 'preferences', 'goals'];
const conflict = () => fail('This record changed; reload before saving', 'revision_conflict', 409);
const round = value => Number(value.toFixed(3));
function instant(value) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/);
  if (!match) fail('A date and time with its UTC offset is required');
  day(match[1]);
  let zone = match[5] === 'Z' ? '+00:00' : match[5];
  if (zone.length === 5) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}${zone}`;
}
function normalized(model, fields) {
  const data = validate(model, fields, { trim: true });
  if (model === 'ProfileInput') for (const key of profileLists) data[key] = [...new Set((data[key] ?? []).map(v => text(v, key, 500, false)))];
  if (model === 'RemindersInput') {
    data.slots ??= []; data.paused_dates = [...new Set((data.paused_dates ?? []).map(day))].sort();
    try { today(data.timezone); } catch { fail('An IANA timezone is required'); }
    if (new Set(data.slots.map(s => s.id)).size !== data.slots.length) fail('Reminder slot IDs must be unique');
    if (!!data.quiet_start !== !!data.quiet_end) fail('Quiet hours require both start and end');
  }
  if (model === 'RuleInput') {
    for (const k of ['effective_from', 'effective_until']) if (data[k]) day(data[k]);
    if (data.effective_from && data.effective_until && data.effective_until < data.effective_from) fail('The effective period is reversed');
    data.excluded_terms = [...new Set((data.excluded_terms ?? []).map(v => text(v, 'excluded term', 200, false)))];
    if (data.origin === 'assistant_proposal' && !data.confirmed && data.status === 'active') data.status = 'proposed';
  }
  if (model === 'MealInput') {
    data.occurred_at = instant(data.occurred_at);
    if (data.status === 'recorded' && !data.description) fail('Describe the food actually eaten');
    if (data.status === 'skipped' && data.estimated_energy) fail('A skipped meal cannot have estimated intake');
  }
  if (['WeightInput', 'StepsInput'].includes(model)) data.measured_at = instant(data.measured_at);
  if (model === 'RecommendationInput') {
    data.target_date = day(data.target_date);
    if (new Set(data.options.map(o => o.id)).size !== data.options.length) fail('Each candidate needs a unique option ID');
    for (const option of data.options) { option.ingredients ??= []; option.substitutions ??= []; }
  }
  for (const energy of [data.estimated_energy, ...(data.options ?? []).map(o => o.estimated_energy)]) {
    if (energy && energy.maximum < energy.minimum) fail('Estimate maximum must not be below minimum');
  }
  return data;
}

export function initialHealthState() {
  const profile = normalized('ProfileInput', {}), reminders = normalized('RemindersInput', {});
  delete profile.revision; delete reminders.revision;
  return { id: 1, revision: 0, profile_revision: 0, reminders_revision: 0, profile_json: stable(profile), reminders_json: stable(reminders) };
}

export class Health {
  constructor(tables) { this.t = tables; }
  get state() { return this.t.health_state[0]; }
  profile() { return { ...JSON.parse(this.state.profile_json), revision: this.state.profile_revision }; }
  reminders() { return { ...JSON.parse(this.state.reminders_json), revision: this.state.reminders_revision }; }
  today() { return today(this.reminders().timezone); }
  rows(kind) { if (!models[kind]) fail('Unknown health record type'); return this.t[`health_${kind}`]; }
  row(row) {
    if (!row) fail('Health record was not found', 'not_found', 404);
    return { ...JSON.parse(row.data_json), id: row.id, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at };
  }
  require(kind, id, deleted = false) { return this.row(this.rows(kind).find(r => r.id === id && (deleted || !r.deleted))); }
  entryDate(kind, data) { return kind === 'meals' ? data.occurred_at.slice(0, 10) : ['weights', 'steps'].includes(kind) ? data.measured_at.slice(0, 10) : kind === 'recommendations' ? data.target_date : clock.now().slice(0, 10); }
  mutate(key, request, operation) {
    const previous = key && this.t.health_mutations.find(r => r.operation_key === key);
    if (previous) {
      if (!equal(JSON.parse(previous.request_json), request)) fail('This request ID identifies a different change', 'idempotency_conflict', 409);
      return JSON.parse(previous.result_json);
    }
    const result = operation();
    if (key) this.t.health_mutations.push({ operation_key: key, request_json: stable(request), result_json: stable(result) });
    return result;
  }
  set(kind, data, key, patch = false) {
    if (!['profile', 'reminders'].includes(kind)) fail('Unknown health setting');
    return this.mutate(key, { kind, data, ...(patch ? { patch: true } : {}) }, () => {
      const current = this[kind](), payload = normalized(kind === 'profile' ? 'ProfileInput' : 'RemindersInput', patch ? { ...current, ...data } : data);
      const revision = payload.revision; delete payload.revision;
      if (patch && revision !== current.revision) conflict();
      if (equal(payload, JSON.parse(this.state[`${kind}_json`]))) return { ...payload, revision: current.revision };
      if (revision == null || revision !== current.revision) conflict();
      this.state[`${kind}_json`] = stable(payload); this.state[`${kind}_revision`]++;
      if (kind === 'profile') this.state.revision++;
      return { ...payload, revision: current.revision + 1 };
    });
  }
  rawList(kind, { start, end, limit = 100 } = {}) {
    if (start) day(start); if (end) day(end);
    if (!Number.isInteger(limit)) fail('Invalid pagination');
    return this.rows(kind).filter(r => !r.deleted && (!start || r.entry_date >= start) && (!end || r.entry_date <= end))
      .sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, min(max(limit, 1), 500)).map(r => this.row(r));
  }
  list(kind, query) {
    if (kind === 'feedback') fail('Unknown health record type');
    return { items: this.rawList(kind, query).map(r => this.decorate(kind, r)) };
  }
  activeRules(date) { return this.rawList('rules', { limit: 500 }).filter(r => r.status === 'active' && (!r.effective_from || r.effective_from <= date) && (!r.effective_until || r.effective_until >= date)); }
  checkRecommendation(payload) {
    if (payload.target_date < this.today() || payload.context_revision !== this.state.revision) fail('Health records or agreements changed; read current context and regenerate', 'stale_health_context', 409);
    const profile = this.profile(), rules = this.activeRules(payload.target_date);
    const terms = [...profile.food_allergies, ...profile.food_exclusions, ...rules.filter(r => r.kind === 'restriction').flatMap(r => r.excluded_terms)];
    if (terms.length && payload.options.some(o => !o.ingredients.length)) fail('Known food restrictions require candidate ingredient information', 'ingredients_required');
    for (const option of payload.options) {
      const searchable = stable(Object.fromEntries(['title', 'description', 'ingredients', 'portion', 'substitutions'].map(k => [k, option[k]]))).toLowerCase();
      if (terms.some(t => searchable.includes(t.toLowerCase()))) fail('A candidate conflicts with a known food restriction; put avoidance notices in the recommendation-level note', 'health_restriction_conflict');
      if (profile.activity_limitations.length && /跑步|跳绳|跳跃|深蹲|爬楼/.test(searchable)) fail('Meal advice must respect activity limitations', 'health_activity_conflict');
      if (/(?:惩罚|补偿).{0,8}(?:跑步|运动|断食)|(?:全天|连续多日|连续几天)(?:不吃|禁食|断食)|催吐|泻药减肥/.test(searchable)) fail('Recommendations must not prescribe punitive or extreme restriction', 'unsafe_health_recommendation');
    }
    return { profile_revision: this.state.profile_revision, rule_revisions: rules.map(r => ({ id: r.id, revision: r.revision })),
      rule_snapshots: rules.map(r => Object.fromEntries(['id', 'revision', 'content', 'kind', 'effective_from', 'effective_until', 'excluded_terms', 'origin'].map(k => [k, r[k]]))),
      record_revision: this.state.revision, food_restrictions: terms, activity_limitations: profile.activity_limitations,
      ingredient_notice: profile.food_allergies.length ? '成分仅依据已提供信息；过敏和交叉接触仍需向供应方确认' : '份量和营养估计以已提供信息为准' };
  }
  decorate(kind, item) {
    if (kind === 'weights') return { ...item, value_kg: round(item.value * (item.unit === 'lb' ? 0.45359237 : 1)) };
    if (kind === 'recommendations') return { ...item, status: item.context_revision === this.state.revision && item.target_date >= this.today() ? 'current' : 'stale',
      latest_feedback: this.rawList('feedback', { limit: 500 }).find(f => f.recommendation_id === item.id) ?? null };
    return item;
  }
  replayCreate(kind, key, payload) {
    const previous = this.t.health_writes.find(r => r.operation_key === key);
    if (!previous) return null;
    const request = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'conversation_id'));
    if (previous.entity_kind !== kind || !equal(JSON.parse(previous.request_json), request)) fail('This request ID already identifies different health data', 'idempotency_conflict', 409);
    const item = this.require(kind, previous.entity_id, true);
    if (kind !== 'feedback') item.deleted = !!this.rows(kind).find(r => r.id === item.id).deleted;
    return this.decorate(kind, item);
  }
  insert(kind, id, payload, key, request = payload) {
    if (this.rows(kind).some(r => r.id === id)) fail('This record ID is already in use', 'idempotency_conflict', 409);
    const now = clock.now();
    this.rows(kind).push({ id, revision: 1, data_json: stable(payload), entry_date: this.entryDate(kind, payload), deleted: 0, created_at: now, updated_at: now });
    this.t.health_writes.push({ operation_key: key, request_json: stable(Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'conversation_id'))), entity_kind: kind, entity_id: id });
    if (kind !== 'recommendations') this.state.revision++;
    return this.decorate(kind, this.require(kind, id));
  }
  create(kind, data, key) {
    if (!models[kind] || kind === 'feedback') fail('Unknown health record type');
    const payload = normalized(models[kind], data), id = payload.id || clock.id();
    delete payload.id; delete payload.revision; key ||= `create:${kind}:${id}`;
    const previous = this.replayCreate(kind, key, payload); if (previous) return previous;
    if (kind === 'meals' && payload.recommendation_id) this.require('recommendations', payload.recommendation_id);
    const request = copy(payload);
    if (kind === 'recommendations') payload.basis = this.checkRecommendation(payload);
    return this.insert(kind, id, payload, key, request);
  }
  update(kind, id, data, key, patch = false) {
    if (!editable.has(kind)) fail('This health record cannot be edited');
    return this.mutate(key, { kind, id, data, ...(patch ? { patch: true } : {}) }, () => {
      const current = this.require(kind, id), row = this.rows(kind).find(r => r.id === id), old = JSON.parse(row.data_json);
      const payload = normalized(models[kind], patch ? { ...old, revision: current.revision, ...data } : data);
      if (payload.id && payload.id !== id) fail('The record ID cannot change');
      const revision = payload.revision; delete payload.id; delete payload.revision;
      if (patch && revision !== current.revision) conflict();
      for (const k of ['source_id', 'conversation_id']) payload[k] ??= old[k];
      if (equal(old, payload)) return this.decorate(kind, current);
      if (revision == null || revision !== current.revision) conflict();
      if (kind === 'meals' && payload.recommendation_id) this.require('recommendations', payload.recommendation_id);
      Object.assign(row, { revision: row.revision + 1, data_json: stable(payload), entry_date: this.entryDate(kind, payload), updated_at: clock.now() });
      this.state.revision++;
      return this.decorate(kind, this.row(row));
    });
  }
  delete(kind, id, revision = null, key) {
    if (!editable.has(kind)) fail('This health record cannot be deleted');
    return this.mutate(key, { kind, id, revision }, () => {
      this.require(kind, id, true);
      const row = this.rows(kind).find(r => r.id === id);
      if (!row.deleted) {
        if (revision != null && revision !== row.revision) conflict();
        Object.assign(row, { deleted: 1, revision: row.revision + 1, updated_at: clock.now() }); this.state.revision++;
      }
      return { id, deleted: true };
    });
  }
  feedback(id, data, key) {
    const payload = normalized('FeedbackInput', data), identifier = payload.id || clock.id();
    delete payload.id; delete payload.revision; payload.recommendation_id = id; key ||= `feedback:${identifier}`;
    const previous = this.replayCreate('feedback', key, payload); if (previous) return previous;
    const recommendation = this.require('recommendations', id);
    if (payload.option_id && !recommendation.options.some(o => o.id === payload.option_id)) fail('Choose an option from this recommendation');
    if (payload.action === 'accepted') {
      if (!payload.option_id) fail('An accepted recommendation requires the selected option');
      if (this.decorate('recommendations', recommendation).status !== 'current') fail('Refresh this recommendation first', 'stale_health_context', 409);
    }
    return this.insert('feedback', identifier, payload, key);
  }
  summary(date = this.today()) {
    day(date);
    const profile = this.profile(), reminders = this.reminders(), allRules = this.rawList('rules', { limit: 500 });
    const meals = this.rawList('meals', { start: date, end: date }), recent = this.rawList('meals', { end: date, limit: 30 });
    const weights = this.list('weights', { end: date, limit: 30 }).items, steps = this.rawList('steps', { start: date, end: date, limit: 30 });
    const recommendations = this.list('recommendations', { limit: 30 }).items;
    const ordered = [...weights].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at) || a.id.localeCompare(b.id)), daily = new Map();
    for (const item of ordered) { const d = item.measured_at.slice(0, 10); daily.set(d, [...(daily.get(d) ?? []), item.value_kg]); }
    const medians = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([d, values]) => {
      values.sort((a, b) => a - b); const n = values.length;
      return [d, (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2];
    });
    return { date, revision: this.state.revision, profile, rules: this.activeRules(date), all_rules: allRules, meals, recent_meals: recent, weights, steps, recommendations, reminders,
      review: { recorded_meals: meals.filter(m => m.status === 'recorded').length, skipped_meals: meals.filter(m => m.status === 'skipped').length,
        coverage: '仅代表已记录内容，未记录表示未知', weight_trend: { count: weights.length, days: medians.length,
          change_kg: medians.length > 1 ? round(medians.at(-1)[1] - medians[0][1]) : null, first_date: medians[0]?.[0] ?? null, last_date: medians.at(-1)?.[0] ?? null,
          latest_kg: ordered.at(-1)?.value_kg ?? null, notice: '仅比较已记录测量；衣着、时间与测量条件可能不同' },
        recent_choices: recommendations.filter(r => r.latest_feedback).map(r => ({ ...r, actual_meals: recent.filter(m => m.recommendation_id === r.id) })),
        unknown_is_not_nonadherence: true, next_step_context: '根据当前约定、已记录饮食和选择困难调整下一餐；不因漏记、单日体重波动而要求补偿或惩罚' } };
  }
}
