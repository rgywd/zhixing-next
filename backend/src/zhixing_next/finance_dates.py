"""Bounded evidence checks for AI date attribution, never a general language parser.

Manual HTTP records remain explicit user input. An AI must point to a user-stated
actual event date before narrowing history to a day/month. Unsupported wording
stays a range, without asking the user to fill a date field.
"""

import json
import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from .store import StoreError

_DATE_FIELDS = {"occurred_on", "date_precision", "date_start", "date_end"}
_EVENT = re.compile(
    r"买|购|工资|salary|缴存|消费|付|交|花|吃|午饭|晚饭|早饭|早餐|午餐|晚餐|咖啡|到账|收到|收入|退|提取|提现|提款|取出|赎回|转入|转出|借|还款|支付|paid|bought|spent|received|refund|withdraw|transfer",
    re.I,
)
_NON_EVENT = re.compile(
    r"估值|市值|报价|售价|现价|预算|还欠|余额|资产|手里|攒|截至|截止|到现在|目前|现在.*(?:还有|有)|每(?:个)?月|每.{0,8}(?:个月|季度|年)|统一|按.{0,10}(?:计算|安排)|预计|计划|打算|准备|将会|尚未|没有|没(?:有)?在|不是|未付|未买|覆盖|cover|balance|assets|schedule|planned|expected",
    re.I,
)
_SUBJECTS = (
    ("手机", "phone", "smartphone"),
    ("电脑", "macmini", "mac mini", "computer", "laptop"),
    ("房租", "租金", "租住", "rent", "rental"),
    ("公积金", "provident fund"),
)


def _fail(message, suggested_fields=None):
    raise StoreError(
        "unverified_finance_date",
        message
        + " Keep the user's known historical period as date_precision=range; do not invent a day or ask them to fill a form."
        + (
            " Retry with suggested_fields=" + json.dumps(suggested_fields, ensure_ascii=False)
            if suggested_fields else ""
        ),
        422,
    )


def _number(value):
    if value.isdigit():
        return int(value)
    numerals = {
        "零": 0,
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    if "十" in value:
        left, right = value.split("十", 1)
        return (numerals.get(left, 1) * 10) + numerals.get(right, 0)
    return numerals.get(value, -1)


def _dates(clause, reference):
    found = set()
    for year, month, day in re.findall(
        r"(?<!\d)(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|号)?(?!\d)", clause
    ):
        try:
            found.add(date(int(year), int(month), int(day)))
        except ValueError:
            continue
    for match in re.finditer(
        r"(?<!\d)(?P<month>\d{1,2}|[一二三四五六七八九十]{1,3})月(?P<day>\d{1,2}|[一二三四五六七八九十两]{1,3})(?:日|号)?",
        clause,
    ):
        if re.search(r"\d{4}(?:年|[-/])$", clause[: match.start()]):
            continue
        try:
            candidate = date(
                reference.year - (1 if "去年" in clause else 0),
                _number(match["month"]),
                _number(match["day"]),
            )
            if candidate > reference and "今年" not in clause and "去年" not in clause:
                candidate = candidate.replace(year=candidate.year - 1)
            found.add(candidate)
        except ValueError:
            continue
    # Compact payment references such as M.D交的 or M-D付了. A decimal amount
    # followed by 元/块 is deliberately not a calendar date.
    for match in re.finditer(r"(?<![\d./-])(\d{1,2})[./-](\d{1,2})(?![\d./-])", clause):
        suffix = clause[match.end() :].lstrip()
        if not re.match(
            r"(?:日|号|交|付|买|购|花|消费|到账|收到|收款|转|退|提|取|paid|bought|spent)",
            suffix,
            re.I,
        ):
            continue
        try:
            candidate = date(reference.year, int(match[1]), int(match[2]))
            if candidate > reference:
                candidate = candidate.replace(year=candidate.year - 1)
            found.add(candidate)
        except ValueError:
            continue
    for expression, offset in (
        (r"大前天", -3),
        (r"(?<!大)前天", -2),
        (r"昨天|昨日|昨晚|昨早", -1),
        (r"今天|今日|今早|今晚|刚刚|刚才", 0),
    ):
        if re.search(expression, clause):
            found.add(reference + timedelta(days=offset))
    return found


def _business_date(created_at):
    try:
        value = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
        return value.astimezone(ZoneInfo("Asia/Shanghai")).date()
    except (ValueError, AttributeError):
        _fail("The original user message has no usable business timestamp.")


def _event_clause(clause, fields):
    """A bounded date check also accepts ordinary purchases outside its verb list.

    A declared amount in an actual dated statement can bind a taxi/subscription/
    other expense without requiring users to choose a particular transaction verb.
    Balance, coverage, schedule and negation checks still apply to the full clause.
    """
    if _EVENT.search(clause):
        return True
    return _same_amount(clause, fields.get("amount"))


def _same_amount(clause, value):
    return _amount_count(clause, value) > 0


def _amount_count(clause, value):
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return 0
    return sum(
        Decimal(match[1]) == amount
        and not re.match(r"\s*(?:年|月|日|号|笔|次|个|%)", clause[match.end():])
        for match in re.finditer(r"(?<![\d.])(\d+(?:\.\d{1,2})?)(?![\d.])", clause)
    )


def _range_suggestion(current, text, reference):
    if current and current.get("date_precision") == "range":
        return {**{key: current[key] for key in ("date_precision", "date_start", "date_end")},
                "occurred_on": None}
    # Observation anchors can bound a retrospective period, but never establish
    # an individual payment date. Only an explicitly stated span gets a fallback.
    dates = _dates(text, reference)
    if re.search(r"到现在|至今|到今天|截至今天|截止今天", text):
        dates.add(reference)
    if len(dates) > 1 and re.search(r"到|至|期间|以来", text):
        return {"date_precision": "range", "date_start": min(dates).isoformat(),
                "date_end": max(dates).isoformat(), "occurred_on": None}
    return None


def normalize_history_range(store, *, source_id, fields, evidence_source_id=None):
    """Keep the real retrospective span when a model invents a narrower range.

    This is only an AI input normalization. A source-bound actual event can
    still establish a smaller period; counts, coverage and recurring rules
    cannot. No source, no explicit overall span or an invalid range leaves the
    input alone for the normal validators. Never turn uncertainty into a day.
    """
    if fields.get("date_precision") != "range":
        return fields
    try:
        begin, end = (date.fromisoformat(fields[key]) for key in ("date_start", "date_end"))
    except (KeyError, TypeError, ValueError):
        return fields
    if begin >= end or not (evidence_source_id or source_id):
        return fields
    with store._connection() as db:
        row = db.execute(
            "SELECT role,status,content,created_at FROM messages WHERE id=? AND COALESCE(json_extract(request_json,'$.origin'),'')!='agent_message'",
            (evidence_source_id or source_id,),
        ).fetchone()
    if row is None or row["role"] != "user" or row["status"] not in {"accepted", "applied"}:
        return fields
    try:
        reference = _business_date(row["created_at"])
    except StoreError:
        return fields
    overall = _range_suggestion(None, row["content"], reference)
    if overall is None:
        return fields
    first, last = (date.fromisoformat(overall[key]) for key in ("date_start", "date_end"))
    if not (first <= begin <= end <= last) or (begin, end) == (first, last):
        return fields

    subject = re.sub(r"\s", "", str(fields.get("category") or "")).casefold()
    target_subjects = {
        index for index, aliases in enumerate(_SUBJECTS)
        if any(re.sub(r"\s", "", alias).casefold() in subject for alias in aliases)
    }
    candidates = []
    for match in re.finditer(r"[^，,。；;、\n]+", row["content"]):
        # "9月1日至今提取…" is an actual event span. Removing only its
        # retrospective endpoint does not remove observations/plans/negation.
        clause = re.sub(r"到现在|至今|到今天|截至今天|截止今天", "", match.group())
        if _NON_EVENT.search(clause) or not _event_clause(clause, fields):
            continue
        clause_subjects = {
            index for index, aliases in enumerate(_SUBJECTS)
            if any(alias.casefold() in clause.casefold() for alias in aliases)
        }
        if target_subjects and clause_subjects and not target_subjects & clause_subjects:
            continue
        bound = ((len(subject) > 1 and subject in re.sub(r"\s", "", clause).casefold())
                 or bool(target_subjects & clause_subjects))
        candidates.append((match.group(), clause, bound))
    bound = [item for item in candidates if item[2]]
    if not bound:
        # A single amount occurrence is another bounded event identity. Equal
        # amounts elsewhere cannot lend a date to this event, even via a quote.
        amount_matches = [item for item in candidates if _same_amount(item[1], fields.get("amount"))]
        if len(amount_matches) == 1 and _amount_count(amount_matches[0][1], fields.get("amount")) == 1:
            bound = amount_matches

    def contains_event_period(item):
        original, clause, _ = item
        if _amount_count(clause, fields.get("amount")) > 1:
            return False
        dates = _dates(clause, reference)
        if dates:
            if re.search(r"到现在|至今|到今天|截至今天|截止今天", original):
                dates.add(reference)
            return begin <= min(dates) and max(dates) <= end
        # Month evidence has to describe an actual event. A covered rent month
        # with only an amount is not an occurrence month. Payment counts such
        # as "两个月工资" do not match this calendar-month syntax.
        if not _EVENT.search(clause):
            return False
        months = []
        for year_text, month_text in re.findall(r"(?:(\d{4})年)?(?<!\d)(\d{1,2}|[一二三四五六七八九十]{1,3})月", clause):
            month = _number(month_text)
            if not 1 <= month <= 12:
                continue
            year = int(year_text) if year_text else reference.year - (1 if "去年" in clause else 0)
            if not year_text and "今年" not in clause and "去年" not in clause and month > reference.month:
                year -= 1
            months.append((date(year, month, 1), min(reference, date(year, month, monthrange(year, month)[1]))))
        if months and re.search(r"到现在|至今|到今天|截至今天|截止今天", original):
            months.append((reference, reference))
        return bool(months) and begin <= min(item[0] for item in months) and max(item[1] for item in months) <= end

    if bound and all(contains_event_period(item) for item in bound):
        return fields
    return {**fields, **overall}


def verify_date_evidence(
    store,
    *,
    conversation_id,
    source_id,
    fields,
    current=None,
    evidence=None,
    evidence_source_id=None,
):
    """Return a receipt for precise AI attribution; unchanged dates need no new quote."""
    if current is not None and not (_DATE_FIELDS & fields.keys()):
        return None
    precision = fields.get("date_precision", "day")
    if current is not None and "date_precision" not in fields:
        precision = "day" if "occurred_on" in fields else current["date_precision"]
    effective = {**(current or {}), **fields}
    if "occurred_on" in fields and not (
        {"date_start", "date_end", "date_precision"} & fields.keys()
    ):
        effective.update(date_start=None, date_end=None, date_precision="day")
    precision = effective.get("date_precision", "day")
    if precision == "day" and fields.get("occurred_on"):
        effective.update(date_start=fields.get("date_start"), date_end=fields.get("date_end"))
    if (
        precision == "month"
        and ("date_start" in fields or "occurred_on" in fields)
        and "date_end" not in fields
    ):
        effective["date_end"] = None
    end = effective.get("date_end") or effective.get("occurred_on")
    begin = effective.get("date_start") or end
    single_day = precision == "day" or (precision == "range" and begin == end)
    if not single_day and precision != "month":
        return None
    message_id = evidence_source_id or source_id
    with store._connection() as db:
        row = db.execute(
            "SELECT id,role,status,content,created_at,conversation_id FROM messages WHERE id=? AND COALESCE(json_extract(request_json,'$.origin'),'')!='agent_message'",
            (message_id,),
        ).fetchone()
    if row is None or row["role"] != "user" or row["status"] not in {"accepted", "applied"}:
        _fail(
            "Date attribution needs the real accepted user message, not an assistant report or an invented source ID."
        )
    reference = _business_date(row["created_at"])
    suggestion = _range_suggestion(current, row["content"], reference)

    def fail(message):
        _fail(message, suggestion)

    # Source IDs are bound by the runtime. Quotes are optional hints, not a
    # second form the model/user must fill. A paraphrased hint can safely fall
    # back to the same complete original message and its timestamp.
    quote = evidence.strip() if isinstance(evidence, str) else ""
    if not quote or quote not in row["content"]:
        quote = row["content"]
    # Known subjects are a conservative wrong-message guard. They do not claim
    # full semantic verification of arbitrary categories or languages.
    subject = re.sub(
        r"\s", "", str(fields.get("category") or (current or {}).get("category", ""))
    ).casefold()
    source_text = re.sub(r"\s", "", row["content"]).casefold()
    for aliases in _SUBJECTS:
        if any(re.sub(r"\s", "", alias).casefold() in subject for alias in aliases) and not any(
            re.sub(r"\s", "", alias).casefold() in source_text for alias in aliases
        ):
            fail("This quoted user message concerns a different transaction subject.")
    # Validate both the quoted words and their original complete clause, so a
    # quote cannot crop away a preceding "not", "planned" or balance context.
    spans = []
    offset = 0
    while (index := row["content"].find(quote, offset)) != -1:
        spans.append((index, index + len(quote)))
        offset = index + 1
    target_subjects = {
        index
        for index, aliases in enumerate(_SUBJECTS)
        if any(re.sub(r"\s", "", alias).casefold() in subject for alias in aliases)
    }
    contexts = list(re.finditer(r"[^，,。；;、\n]+", row["content"]))
    if any(
        not _NON_EVENT.search(match.group()) and _amount_count(match.group(), effective.get("amount")) > 1
        for match in contexts
    ):
        # The source contains more than one equal-amount candidate inside one
        # unsplit phrase. Neither a cropped quote nor category text identifies
        # which occurrence a date modifies. Do not guess a conjunction grammar.
        fail("Several equal-amount occurrences have no separable event/date binding. Keep the known period rather than borrowing another occurrence's date.")
    amount_contexts = [
        match for match in contexts
        if not _NON_EVENT.search(match.group()) and _same_amount(match.group(), effective.get("amount"))
    ]
    bound_contexts = None
    if len(amount_contexts) > 1:
        # Equal amounts cannot identify which event a date belongs to. Bind
        # using the original subject text, independently of any cropped quote.
        # If that subject also has an undated event, narrowing either occurrence
        # needs more information; an amount match must never borrow its date.
        bound_contexts = {
            match.start() for match in amount_contexts
            if (len(subject) > 1 and subject in re.sub(r"\s", "", match.group()).casefold())
            or any(
                any(alias.casefold() in match.group().casefold() for alias in _SUBJECTS[index])
                for index in target_subjects
            )
        }
        if not bound_contexts or any(
            match.start() in bound_contexts
            and not _dates(match.group(), reference)
            and not (precision == "month" and re.search(r"(?:\d{1,2}|[一二三四五六七八九十]{1,3})月", match.group()))
            for match in amount_contexts
        ):
            fail("Several equal-amount events have no unambiguous subject/date binding. Keep their known period; a date on another event cannot narrow undated history.")
    clauses = []
    previous_subjects = set()
    for match in contexts:
        context = match.group()
        context_subjects = {
            index
            for index, aliases in enumerate(_SUBJECTS)
            if any(alias.casefold() in context.casefold() for alias in aliases)
        }
        prior_subjects = previous_subjects
        previous_subjects = context_subjects
        if _NON_EVENT.search(context):
            continue
        if bound_contexts is not None and match.start() not in bound_contexts:
            continue
        if target_subjects and context_subjects and not target_subjects & context_subjects:
            continue
        if target_subjects and not context_subjects:
            # A date in an unrelated lunch clause must not date the phone
            # mentioned later. Only an explicit same-cost reference may inherit
            # the immediately preceding subject ("房租…，这次四月九交的").
            if not (target_subjects & prior_subjects and re.search(r"这次|那次|当时|那天|当天|这笔|那笔", context)):
                continue
        for start, stop in spans:
            if start < match.end() and stop > match.start():
                part = row["content"][max(start, match.start()) : min(stop, match.end())]
                if _event_clause(part, effective) and not _NON_EVENT.search(part):
                    clauses.append(part)
    supported = set()
    for clause in clauses:
        supported.update(_dates(clause, reference))
    if single_day:
        try:
            target = (next(iter(supported)) if not (end or begin) and len(supported) == 1
                      else date.fromisoformat(end or begin or ""))
        except ValueError:
            fail("An exact day needs a consistent YYYY-MM-DD date.")
        if target not in supported:
            fail(
                "The quote does not state this actual occurrence date. An asset observation/cutoff, covered rent months or recurring payday cannot date an individual purchase."
            )
        effective = target.isoformat()
    else:
        value = begin or end
        # Month-only evidence must still describe an actual event, not a cost
        # coverage period. Full-day dates also establish their containing month.
        months = {value.strftime("%Y-%m") for value in supported}
        for clause in clauses:
            if not _event_clause(clause, effective) or _NON_EVENT.search(clause):
                continue
            for match in re.finditer(
                r"(?:(\d{4})年)?(?<!\d)(\d{1,2}|[一二三四五六七八九十]{1,3})月", clause
            ):
                month = _number(match[2])
                year = (
                    int(match[1]) if match[1] else reference.year - (1 if "去年" in clause else 0)
                )
                if (
                    not match[1]
                    and "今年" not in clause
                    and "去年" not in clause
                    and month > reference.month
                ):
                    year -= 1
                if 1 <= month <= 12:
                    months.add(f"{year:04d}-{month:02d}")
        if value is None and len(months) == 1:
            value = next(iter(months))
        if not isinstance(value, str) or len(value) < 7:
            fail("A month needs an explicitly known actual occurrence month.")
        if value[:7] not in months:
            fail(
                "The quote does not establish this actual payment month; a count of payments or recurring salary rule cannot establish past months."
            )
        effective = value[:7]
    return {
        "source_message_id": row["id"],
        "quote": quote[:240],
        "quote_truncated": len(quote) > 240,
        "value": effective,
        "basis": "user_stated_event_date",
        "message_business_date": reference.isoformat(),
    }


def verify_budget_due_days(
    service, *, month, changes, source_id, evidence=None, evidence_source_id=None
):
    """AI may set a precise recurring day only from a user-stated recurring rule."""
    incoming = changes.get("commitments_upsert", changes.get("commitments", [])) or []
    current = {item["key"]: item for item in service.get_budget(month)["commitments"]}
    changed = [
        item
        for item in incoming
        if item.get("due_day") is not None
        and item.get("due_day") != current.get(item["key"], {}).get("due_day")
    ]
    if not changed:
        return []

    def fail(message):
        raise StoreError(
            "unverified_budget_due_day",
            message
            + " Omit due_day (or leave it null) and retain the known payment month/cycle. Do not guess the 1st or ask the user to fill a payment date.",
            422,
        )

    message_id = evidence_source_id or source_id
    with service.store._connection() as db:
        row = db.execute(
            "SELECT id,role,status,content FROM messages WHERE id=? AND COALESCE(json_extract(request_json,'$.origin'),'')!='agent_message'", (message_id,)
        ).fetchone()
    if (
        row is None
        or row["role"] != "user"
        or row["status"] not in {"accepted", "applied"}
    ):
        fail("The recurring-rule quote must occur verbatim in a real accepted user message.")
    quote = evidence.strip() if isinstance(evidence, str) else ""
    if not quote or quote not in row["content"]:
        quote = row["content"]
    recurring = re.compile(
        r"每(?:个)?月|每[^，,。；;]{0,6}(?:个月|季度|年|次)|统一|固定|一律|都按", re.I
    )
    uncertain = re.compile(
        r"余额|资产|覆盖|不是|不按|不再|不确定|未确定|未知|不知道|没说|没有|待定|可能|大概", re.I
    )
    day_pattern = re.compile(r"(?<![\d])([\d]{1,2}|[一二三四五六七八九十两]{1,3})\s*(?:日|号)")
    income_rule = re.compile(r"工资|薪资|发薪|到账|salary|payday", re.I)
    from .finance_service import _commitment_purposes

    known = {"purpose:housing", "purpose:commute", "purpose:telecom"}
    contexts = re.findall(r"[^，,。；;、\n]+", row["content"])
    global_rule = re.compile(r"(?:所有|全部|各项|各笔)(?:固定|计划)?(?:费用|开销|支出|账单|付款|款项)")
    exceptions = re.compile(r"除|不含|不包括|例外|另行|单独|特殊|但|不过|不适用")
    sentences = re.split(r"[。；;\n]", row["content"])

    def normalize(value):
        value = re.sub(r"[（(][^）)]*[）)]", "", value)
        return re.sub(r"[^\w]", "", value).lower()

    def generic_rule(value):
        # An omitted subject may refer back to the immediately preceding cost.
        # A different explicit subject (electricity, insurance, membership, ...)
        # must survive this small payment-language grammar and cannot borrow it.
        value = re.sub(
            r"付款日|支付日|缴费日|支付|付款|缴费|缴纳|交款|统一|一律|固定|都按|都在|每个月|季度|这笔|这项|一次|每次|按|每|个|月|年|日|号|次|付|交|缴|扣款|扣|还款|款|的|在|于|是|来|计算",
            "", value,
        )
        return not re.sub(r"[\s\d一二三四五六七八九十两，,。；;、]+", "", value)

    proofs = []
    for item in changed:
        previous = current.get(item["key"], {})
        # Existing keys keep their saved identity. A model-supplied rename in
        # this same patch cannot authorize borrowing another cost's due day.
        identity = previous if previous.get("label") else item
        purposes = _commitment_purposes(identity) & known
        labels = [normalize(identity["label"])]

        def names_this_cost(value):
            return bool(
                purposes & (_commitment_purposes({"label": value}) & known)
                or any(len(label) >= 2 and label in normalize(value) for label in labels)
            )

        def only_this_cost_rule(value):
            if not names_this_cost(value):
                return False
            subjectless = normalize(value)
            for label in labels:
                subjectless = subjectless.replace(label, "")
            for purpose, pattern in {
                "purpose:housing": r"房租|租金|租住|租房|rent(?:al)?",
                "purpose:commute": r"通勤|地铁|commut(?:e|ing)|subway",
                "purpose:telecom": r"话费|手机套餐|移动通信|通讯费|通信费|mobileplan|phonebill",
            }.items():
                if purpose in purposes:
                    subjectless = re.sub(pattern, "", subjectless)
            return generic_rule(subjectless)

        found = False
        for index, context in enumerate(contexts):
            if uncertain.search(context):
                continue
            contextual = _commitment_purposes({"label": context}) & known
            if purposes and contextual and not purposes & contextual:
                continue
            for part in re.split(r"[，,。；;、\n]", quote):
                if (
                    not part
                    or part not in context
                    or not recurring.search(part)
                    or uncertain.search(part)
                    or income_rule.search(part)
                ):
                    continue
                if global_rule.search(part) and any(
                    part in sentence and exceptions.search(sentence) for sentence in sentences
                ):
                    continue
                # A quote must identify this cost, explicitly apply to all
                # costs, or be a subjectless rule directly following this cost.
                # Empty known-purpose extraction is not evidence of identity.
                global_scope = bool(global_rule.search(part)) and (
                    "固定" not in part or item.get("kind") == "fixed"
                )
                traced = generic_rule(part) and (
                    only_this_cost_rule(context)
                    or (generic_rule(context) and index > 0 and only_this_cost_rule(contexts[index - 1]))
                )
                if not (names_this_cost(part) or global_scope or traced):
                    continue
                # A broad quotation with different payment days cannot bind a
                # particular day to a cost. The model may quote its short rule.
                if len({_number(value[1]) for value in day_pattern.finditer(part)}) > 1:
                    continue
                for day in day_pattern.finditer(part):
                    # A known actual month/day (e.g. M月D日) is not itself a
                    # recurring rule, even when another rule shares the clause.
                    prefix = part[: day.start()]
                    if re.search(r"(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*$", prefix):
                        continue
                    if _number(day[1]) == item["due_day"]:
                        found = True
                        break
                if found:
                    break
            if found:
                break
        if not found:
            fail(
                "The quote does not establish this commitment's recurring due_day. A balance date, covered months or one actual payment date cannot establish a recurring rule."
            )
        proofs.append(
            {
                "key": item["key"],
                "due_day": item["due_day"],
                "source_message_id": row["id"],
                "quote": quote[:240],
                "quote_truncated": len(quote) > 240,
                "basis": "user_stated_recurring_payment_day",
            }
        )
    return proofs
