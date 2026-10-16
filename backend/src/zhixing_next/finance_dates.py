"""Bounded evidence checks for AI date attribution, never a general language parser.

Manual HTTP records remain explicit user input. An AI must point to a user-stated
actual event date before narrowing history to a day/month. Unsupported wording
stays a range, without asking the user to fill a date field.
"""

import re
from datetime import date, datetime, timedelta
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


def _fail(message):
    raise StoreError(
        "unverified_finance_date",
        message
        + " Keep the user's known historical period as date_precision=range; do not invent a day or ask them to fill a form.",
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
    if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 240:
        _fail(
            "Exact day/month attribution needs date_evidence: a short verbatim quote describing when this actual transaction happened."
        )
    quote = evidence.strip()
    message_id = evidence_source_id or source_id
    with store._connection() as db:
        row = db.execute(
            "SELECT id,role,content,created_at,conversation_id FROM messages WHERE id=?",
            (message_id,),
        ).fetchone()
    if row is None or row["role"] != "user" or quote not in row["content"]:
        _fail(
            "date_evidence must occur verbatim in the original user message; an assistant report, invented quote or schedule is not evidence."
        )
    reference = _business_date(row["created_at"])
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
            _fail("This quoted user message concerns a different transaction subject.")
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
    source_subjects = {
        index
        for index, aliases in enumerate(_SUBJECTS)
        if any(re.sub(r"\s", "", alias).casefold() in source_text for alias in aliases)
    }
    clauses = []
    for match in re.finditer(r"[^，,。；;\n]+", row["content"]):
        context = match.group()
        if _NON_EVENT.search(context):
            continue
        context_subjects = {
            index
            for index, aliases in enumerate(_SUBJECTS)
            if any(alias.casefold() in context.casefold() for alias in aliases)
        }
        if target_subjects and context_subjects and not target_subjects & context_subjects:
            continue
        if target_subjects and not context_subjects and len(source_subjects) > 1:
            continue
        for start, stop in spans:
            if start < match.end() and stop > match.start():
                part = row["content"][max(start, match.start()) : min(stop, match.end())]
                if _EVENT.search(part) and not _NON_EVENT.search(part):
                    clauses.append(part)
    supported = set()
    for clause in clauses:
        supported.update(_dates(clause, reference))
    if single_day:
        try:
            target = date.fromisoformat(end or begin or "")
        except ValueError:
            _fail("An exact day needs a consistent YYYY-MM-DD date.")
        if target not in supported:
            _fail(
                "The quote does not state this actual occurrence date. An asset observation/cutoff, covered rent months or recurring payday cannot date an individual purchase."
            )
        effective = target.isoformat()
    else:
        value = begin or end
        if not isinstance(value, str) or len(value) < 7:
            _fail("A month needs an explicitly known actual occurrence month.")
        # Month-only evidence must still describe an actual event, not a cost
        # coverage period. Full-day dates also establish their containing month.
        months = {value.strftime("%Y-%m") for value in supported}
        for clause in clauses:
            if not _EVENT.search(clause) or _NON_EVENT.search(clause):
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
        if value[:7] not in months:
            _fail(
                "The quote does not establish this actual payment month; a count of payments or recurring salary rule cannot establish past months."
            )
        effective = value[:7]
    return {
        "source_message_id": row["id"],
        "quote": quote,
        "value": effective,
        "basis": "user_stated_event_date",
        "message_business_date": reference.isoformat(),
    }
