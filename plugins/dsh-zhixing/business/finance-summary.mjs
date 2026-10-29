import { cents, day, daysBetween, divide, fmt, max, min, month, monthEnd, monthNumber, numberMonth, today } from './common.mjs';

// Monetary arithmetic uses integer cents, including ratios until the final display rounding.
export function financeSummary(service, value, asOf) {
  const m = month(value), date = asOf ? day(asOf) : today(), start = `${m}-01`, last = monthEnd(m), through = min(date, last);
  const budget = service.budget(m), all = service.t.finance_transactions.filter(r => !r.deleted);
  const rows = all.filter(r => r.date_start >= start && r.date_end <= last).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.id.localeCompare(b.id)).map(r => service.record(r));
  const unallocated = all.filter(r => r.date_start <= last && r.date_end >= start && r.date_start.slice(0, 7) !== r.date_end.slice(0, 7)).sort((a, b) => a.date_start.localeCompare(b.date_start) || a.id.localeCompare(b.id)).map(r => service.record(r));
  const originals = new Map(all.filter(r => r.kind === 'expense').map(r => [r.id, r]));
  const original = r => r.kind === 'refund' ? originals.get(r.related_transaction_id) ?? r : r;
  const sums = Object.fromEntries(['income', 'expense', 'daily', 'fixed', 'one_time', 'refund', 'transfer'].map(k => [k, 0n]));
  const aggregates = rows.filter(r => r.entry_type === 'aggregate'), details = rows.filter(r => r.entry_type === 'detail');
  const gaps = [], assumptions = [], recordedDays = new Set();
  const included = (a, r) => a.period_start <= r.date_start && r.date_end <= a.occurred_on;
  const sameFlow = (a, r) => r.kind === a.kind || (a.kind === 'expense' && r.kind === 'refund');
  const signed = r => cents(r.amount) * (r.kind === 'refund' ? -1n : 1n);
  for (const r of details) {
    const amount = cents(r.amount), bucket = original(r).bucket;
    if (r.date_precision === 'day') recordedDays.add(r.occurred_on);
    if (r.kind === 'transfer') { sums.transfer += amount; continue; }
    if (!aggregates.some(a => sameFlow(a, r) && a.bucket === bucket && included(a, r))) {
      if (r.kind === 'income') sums.income += amount;
      else { sums.expense += signed(r); sums[bucket] += signed(r); }
    }
    if (r.kind === 'refund') sums.refund += amount;
  }
  for (const a of aggregates) {
    const net = details.filter(r => sameFlow(a, r) && r.bucket === a.bucket && included(a, r)).reduce((n, r) => n + signed(r), 0n);
    let amount = cents(a.amount);
    if (net > amount) { amount = net; gaps.push('details_exceed_cumulative_total'); }
    sums[a.kind] += amount; if (a.kind === 'expense') sums[a.bucket] += amount;
    assumptions.push('cumulative_total_includes_details_in_its_range');
  }
  if (details.some(r => r.date_precision !== 'day' && aggregates.some(a => sameFlow(a, r) && r.bucket === a.bucket && r.date_start <= a.occurred_on && r.date_end >= a.period_start && !included(a, r)))) {
    gaps.push('uncertain_record_overlaps_cumulative_total'); assumptions.push('totals_include_potential_overlap_not_exact');
  }
  const reserves = { fixed: 0n, one_time: 0n }, items = [];
  let monthlyCost = 0n;
  for (const item of budget.commitments) {
    const every = item.every_months ?? 1, current = monthNumber(m), anchor = monthNumber(item.anchor_month ?? m);
    const payment = cents(item.amount), cost = item.monthly_cost != null ? cents(item.monthly_cost) : divide(payment, every, true);
    monthlyCost += cost;
    const due = current >= anchor && (current - anchor) % every === 0 ? payment : 0n;
    let paidThrough = item.paid_through ?? null, allocated = 0n, coverage = null;
    for (const r of all.filter(r => r.commitment_key && ['expense', 'refund'].includes(r.kind))) {
      const source = original(r); if (source.commitment_key !== item.key) continue;
      const matches = source.coverage_start && source.coverage_end ? source.coverage_start <= m && m <= source.coverage_end : source.date_start.slice(0, 7) === m && source.date_end.slice(0, 7) === m;
      if (matches) allocated += signed(r);
      if (matches && source.coverage_end && (!coverage || source.coverage_end > coverage)) coverage = source.coverage_end;
    }
    if (coverage && allocated >= payment && (!paidThrough || coverage > paidThrough)) paidThrough = coverage;
    const remaining = paidThrough && m <= paidThrough ? 0n : max(0n, due - allocated);
    reserves[item.kind] += remaining;
    let next = max(current, anchor);
    if (paidThrough) next = max(next, monthNumber(paidThrough) + 1);
    else if (due && remaining === 0n) next++;
    next += ((anchor - next) % every + every) % every;
    const nextMonth = numberMonth(next), nextDate = item.due_day == null ? null : `${nextMonth}-${String(min(item.due_day, Number(monthEnd(nextMonth).slice(-2)))).padStart(2, '0')}`;
    items.push({ key: item.key, label: item.label, monthly_cost: fmt(cost), cash_due: fmt(due), remaining_due: fmt(remaining),
      next_due_on: nextDate, next_due_month: nextMonth, next_due_precision: nextDate ? 'day' : 'month', paid_through: paidThrough });
  }
  reserves.total = reserves.fixed + reserves.one_time;
  if (unallocated.length) gaps.push('cross_month_dates_unallocated');
  if (rows.some(r => r.date_precision !== 'day' && r.entry_type !== 'aggregate')) gaps.push('transaction_day_unknown');
  const expected = budget.expected_income == null ? null : cents(budget.expected_income), target = budget.savings_target == null ? null : cents(budget.savings_target), dailyBudget = budget.daily_budget == null ? null : cents(budget.daily_budget);
  const income = expected == null ? sums.income : max(expected, sums.income);
  if (expected != null && income > sums.income) assumptions.push('expected_income_includes_received_income');
  const available = expected != null && target != null ? income - target - sums.expense - reserves.total : null;
  let dailyRemaining = dailyBudget == null ? null : dailyBudget - sums.daily;
  if (available != null) dailyRemaining = dailyRemaining == null ? available : min(available, dailyRemaining);
  if (reserves.total > 0n && rows.some(r => r.kind === 'expense' && ['fixed', 'one_time'].includes(r.bucket) && !r.commitment_key)) gaps.push('unmatched_spending_may_overlap_reservations');
  const elapsed = max(0, daysBetween(start, through) + 1), complete = !!(budget.coverage_start === start && budget.coverage_through && budget.coverage_through >= through && elapsed);
  if (!complete) gaps.push('record_coverage_not_confirmed');
  if (expected == null) gaps.push('expected_income_unknown');
  if (target == null) gaps.push('savings_target_unset');
  const remainingDays = through >= start ? max(0, daysBetween(max(start, through), last)) : Number(last.slice(-2));
  let projectionNumerator = null, projectionDenominator = 1, average = null, basis = null;
  if (complete && elapsed && date >= start && !gaps.some(g => ['transaction_day_unknown', 'cross_month_dates_unallocated'].includes(g))) {
    let toDate = details.filter(r => ['expense', 'refund'].includes(r.kind) && r.bucket === 'daily' && r.occurred_on <= through).reduce((n, r) => n + signed(r), 0n);
    for (const a of aggregates.filter(r => r.kind === 'expense' && r.bucket === 'daily' && r.occurred_on <= through)) {
      const net = details.filter(r => ['expense', 'refund'].includes(r.kind) && r.bucket === 'daily' && included(a, r)).reduce((n, r) => n + signed(r), 0n);
      toDate += max(cents(a.amount), net) - net;
    }
    average = divide(max(0n, toDate), elapsed);
    projectionNumerator = max(0n, toDate) * BigInt(remainingDays); projectionDenominator = elapsed; basis = 'confirmed_coverage_run_rate';
  } else if (dailyBudget != null) {
    projectionNumerator = max(0n, dailyBudget - sums.daily); basis = 'configured_daily_budget';
    assumptions.push('projection_uses_budget_not_observed_spending_rate');
  }
  if (!remainingDays) { projectionNumerator = 0n; projectionDenominator = 1; basis = 'month_ended'; }
  const expenseNumerator = projectionNumerator == null ? null : (sums.expense + reserves.total) * BigInt(projectionDenominator) + projectionNumerator;
  const savingsNumerator = expected == null || expenseNumerator == null ? null : income * BigInt(projectionDenominator) - expenseNumerator;
  let incomeOn = null;
  const schedule = budget.income_schedule;
  if (schedule?.rule === 'last_business_day') {
    for (let d = Number(last.slice(-2)); d > 0; d--) {
      const candidate = `${m}-${String(d).padStart(2, '0')}`, weekday = (new Date(`${candidate}T00:00:00Z`).getUTCDay() + 6) % 7;
      if (schedule.working_dates.includes(candidate) || (!schedule.non_working_dates.includes(candidate) && schedule.weekdays.includes(weekday))) { incomeOn = candidate; break; }
    }
    if (!incomeOn) gaps.push('income_schedule_has_no_working_date');
  } else if (schedule) incomeOn = `${m}-${String(min(schedule.day, Number(last.slice(-2)))).padStart(2, '0')}`;
  const formatRatio = n => n == null ? null : fmt(divide(n, projectionDenominator));
  return {
    month: m, budget, expected_income_on: incomeOn,
    totals: { ...Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, fmt(v)])), net: fmt(sums.income - sums.expense) },
    reservations: Object.fromEntries(Object.entries(reserves).map(([k, v]) => [k, fmt(v)])),
    commitments: { monthly_cost: fmt(monthlyCost), cash_due: fmt(items.reduce((n, i) => n + cents(i.cash_due), 0n)), items }, income_schedule: schedule,
    unallocated: { items: unallocated, count: unallocated.length, reason: 'Exact month unknown; excluded from monthly totals, never assigned to the range end month' },
    remaining: { daily_budget: fmt(dailyRemaining), total_spend_budget: fmt(available), savings_target_headroom: savingsNumerator == null || target == null ? null : formatRatio(savingsNumerator - target * BigInt(projectionDenominator)) },
    projection: { income: expected == null ? null : fmt(income), received_income: fmt(sums.income), expected_income_remaining: expected == null ? null : fmt(max(0n, expected - sums.income)),
      expense: formatRatio(expenseNumerator), savings: formatRatio(savingsNumerator), daily_basis: basis, assumptions: [...new Set(assumptions)].sort(), reliable: complete && !gaps.length },
    coverage: { recorded_days: recordedDays.size, from: budget.coverage_start, through: budget.coverage_through, complete, gaps: [...new Set(gaps)].sort() },
    daily_average: { amount: fmt(average), days: complete ? elapsed : null, from: complete ? budget.coverage_start : null, through: complete ? through : null, basis: complete ? 'confirmed_calendar_coverage' : 'unknown_coverage' },
    record_count: rows.length,
  };
}
