"""AI meal timestamps preserve unknown times instead of inventing a meal clock.

The public health service still accepts its original explicit timestamp format.
These adapters use a bound user message, never worker time or a meal-type clock.
"""

import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

from .store import StoreError

UNKNOWN_MEAL_TIME_NOTE = "实际用餐时间未知；此处时钟仅用于记录，不代表实际用餐时刻。"
UNKNOWN_MEASUREMENT_TIME_NOTE = "实际测量时间未知；此处时钟仅用于记录，不代表实际测量时刻。"
BUSINESS_ZONE = ZoneInfo("Asia/Shanghai")
_PERIOD = r"凌晨|早上|上午|中午|下午|傍晚|晚上|昨晚|今晚"
_UNKNOWN_CLOCK = re.compile(
    r"(?:几点|时间|时刻)[^，,；;。！？!?\n]{0,24}(?:记不清|不记得|不清楚|不知道|未知|不确定)"
    r"|(?:记不清|不记得|不清楚|不知道|未知|不确定)[^，,；;。！？!?\n]{0,24}(?:几点|时间|时刻)"
)
_CLOCK_FRAGMENT = re.compile(r"^(?:具体|实际|准确|当时|那次|这次|我)?的?(?:几点|时间|时刻|记不清|不记得|不清楚|不知道|未知|不确定)")
_MEAL_NAMES = {
    "breakfast": r"早[餐饭]", "lunch": r"(?:午|中)[餐饭]",
    "dinner": r"晚[餐饭]", "snack": r"加餐|夜宵",
}


def _number(value):
    if value.isdigit():
        return int(value)
    digits = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if "十" in value:
        left, right = value.split("十", 1)
        return digits.get(left, 1) * 10 + digits.get(right, 0)
    return digits.get(value, -1)


def _clock_hour(hour, period):
    if period in {"下午", "傍晚", "晚上", "昨晚", "今晚"} and 0 < hour < 12:
        return hour + 12
    if period == "中午" and hour in {1, 2}:
        return hour + 12
    if period in {"凌晨", "晚上", "昨晚", "今晚"} and hour == 12:
        return 0
    return hour


def _explicit_unknown_clock(text, time_field, fields):
    """Do not borrow a different event's clock over an explicit unknown.

    This only checks bounded source clauses, using the service's own record
    kinds/meal labels. It does not infer which arbitrary event a clock belongs to.
    """
    meal_scope, measurement_scope = set(), False
    for clause in re.split(r"([，,；;。！？!?\n])", text):
        if not clause.strip():
            continue
        if clause in "，,；;。！？!?\n":
            if clause not in "，,":
                meal_scope, measurement_scope = set(), False
            continue
        # Commas may continue the named event ("午饭吃了X，几点吃的记不清").
        # A new named meal replaces it; another subject clears it. Only a short
        # clock fragment inherits scope, not an arbitrary following event.
        named = {kind for kind, pattern in _MEAL_NAMES.items() if re.search(pattern, clause)}
        meal_event = bool(re.search(r"用餐|进餐|吃|餐|饭|夜宵", clause))
        measurement_event = bool(re.search(r"测量|称重|体重|步数|测|称", clause))
        clock_fragment = bool(_CLOCK_FRAGMENT.match(clause.strip()))
        meal_scope = named or meal_scope if meal_event or clock_fragment else set()
        measurement_scope = measurement_event or measurement_scope if measurement_event or clock_fragment else False
        if not _UNKNOWN_CLOCK.search(clause):
            continue
        if time_field == "occurred_at":
            selected = fields.get("meal_type", "other")
            if selected in _MEAL_NAMES and meal_scope and selected not in meal_scope:
                continue
            if meal_event or meal_scope and clock_fragment:
                return True
        elif measurement_event or measurement_scope and clock_fragment:
            return True
    return False


def _source_has_clock(text, proposed, *, time_field, fields):
    """Bounded literal clock matching, not a natural-language time planner."""
    if _explicit_unknown_clock(text, time_field, fields):
        return False
    for match in re.finditer(rf"(?:(?P<period>{_PERIOD})\s*)?(?<!\d)(?P<hour>[01]?\d|2[0-3]):(?P<minute>[0-5]\d)(?::(?P<second>[0-5]\d))?(?!\d)", text):
        hour = _clock_hour(int(match["hour"]), match["period"])
        if (hour, int(match["minute"]), int(match["second"] or 0)) == (proposed.hour, proposed.minute, proposed.second):
            return True
    for match in re.finditer(rf"({_PERIOD})?\s*([零一二两三四五六七八九十\d]{{1,3}})[点時时](?:([零一二两三四五六七八九十\d]{{1,3}})分?|([半]))?(?:钟)?", text):
        hour, minute = _number(match[2]), 30 if match[4] else _number(match[3]) if match[3] else 0
        hour = _clock_hour(hour, match[1])
        if (hour, minute, 0) == (proposed.hour, proposed.minute, proposed.second):
            return True
    return False


def _normalise_time_fields(store, source_id, fields, *, time_field, unknown_note, patch, previous):
    result = dict(fields)
    old_note = (previous or {}).get("note") or ""
    if patch and time_field not in result:
        # Replacing a user note cannot turn recording metadata into an actual
        # event time. Only a confirmed clock correction can remove this marker.
        if "note" in result and unknown_note in old_note:
            note = result["note"] or ""
            result["note"] = note if unknown_note in note else f"{note}\n{unknown_note}".strip()
        return result
    with store._connection() as db:
        source = db.execute("""
            SELECT m.created_at,m.content FROM messages m
            WHERE m.id=? AND m.role='user' AND m.status!='rejected'
              AND COALESCE(json_extract(m.request_json,'$.origin'),'')!='agent_message'
              AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=m.run_id AND r.origin='agent_message')
              AND NOT EXISTS(SELECT 1 FROM conversation_deliveries d WHERE d.target_run_id=m.run_id)
        """, (source_id,)).fetchone()
    if source is None:
        raise StoreError("record_source_missing", "The original user message is required to record an unknown event time.", 422)
    try:
        recorded = datetime.fromisoformat(source["created_at"].replace("Z", "+00:00"))
        recorded = recorded.replace(tzinfo=BUSINESS_ZONE) if recorded.tzinfo is None else recorded.astimezone(BUSINESS_ZONE)
        value = result.get(time_field)
        day_only = isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
        proposed = datetime.fromisoformat(value.replace("Z", "+00:00")) if value and not day_only else None
        if proposed is not None and proposed.tzinfo is None:
            raise ValueError
        if proposed is not None:
            proposed = proposed.astimezone(BUSINESS_ZONE)
        day = date.fromisoformat(value) if day_only else proposed.date() if proposed else recorded.date()
        old = datetime.fromisoformat(previous[time_field]) if previous else None
    except (TypeError, ValueError, KeyError) as exc:
        raise StoreError("invalid_record_time", "Omit an unknown event time, use YYYY-MM-DD for a known date, or supply a user-stated timestamp with UTC offset.", 422) from exc
    note = result.get("note", old_note) or ""
    if proposed is not None and _source_has_clock(source["content"], proposed, time_field=time_field,
                                                fields={**(previous or {}), **result}):
        timestamp, unknown = proposed, False
    elif old is not None:
        # A date correction must not overwrite an already known actual clock.
        timestamp = datetime.combine(day, old.timetz())
        unknown = unknown_note in old_note
    else:
        timestamp, unknown = datetime.combine(day, recorded.timetz()), True
    result[time_field] = timestamp.isoformat(timespec="seconds")
    if unknown:
        result["note"] = note if unknown_note in note else f"{note}\n{unknown_note}".strip()
    elif unknown_note in note:
        result["note"] = note.replace(unknown_note, "").strip()
    return result


def normalise_meal_fields(store, source_id, fields, *, patch=False, previous=None):
    """Resolve omitted/date-only clocks and preserve their unknown-time marker."""
    return _normalise_time_fields(store, source_id, fields, time_field="occurred_at",
                                  unknown_note=UNKNOWN_MEAL_TIME_NOTE, patch=patch, previous=previous)


def normalise_measurement_fields(store, source_id, fields, *, patch=False, previous=None):
    return _normalise_time_fields(store, source_id, fields, time_field="measured_at",
                                  unknown_note=UNKNOWN_MEASUREMENT_TIME_NOTE, patch=patch, previous=previous)
