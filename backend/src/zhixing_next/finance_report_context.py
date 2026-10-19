"""Continue verified finance reports unless the actual user changes their scope."""

import calendar
import hashlib
import json
import re
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from .finance_service import _date
from .resources import resource_bytes
from .store import StoreError

_REPORT = r"(?:报告|报表|月报|回顾|汇总|统计)"
_MONTH = r"(?:(?:今年|去年)|\d{4}年)?\d{1,2}月(?:份)?|本月|这个月|上月|上个月"
_MONTH_REPORT = re.compile(
    rf"(?P<month>{_MONTH})\s*(?:的)?\s*(?:财务|收支|资产|预算|月度)?\s*{_REPORT}"
)
_REPORT_MONTH = re.compile(
    rf"{_REPORT}(?:范围)?[：:\s]*(?:只看|仅看|只统计|仅统计|改为|换成|按|用)?\s*(?P<month>{_MONTH})"
)
_RANGE = re.compile(
    r"(?<!\d)(?:(?P<y1>\d{4})[-/年])?(?P<m1>\d{1,2})[-/月](?P<d1>\d{1,2})(?:日|号)?\s*(?:到|至|~|～|—|–)\s*(?:(?P<y2>\d{4})[-/年])?(?P<m2>\d{1,2})[-/月](?P<d2>\d{1,2})(?:日|号)?(?!\d)"
)
_CASH = r"[￥¥]?\s*(?P<amount>\d+(?:\.\d{1,2})?)\s*(?P<unit>万|千)?"
_UPDATE = r"\s*(?:更新|修改|更正|调整|变|改)?\s*(?:到|为|成|是|有|约|大概|：|:|\s)*"
_OPENING = re.compile(r"(?:期初(?:总资产|资产|余额)?|起初(?:总资产|资产|余额))" + _UPDATE + _CASH)
_CLOSING = re.compile(
    r"(?P<label>期末(?:总资产|资产|总余额|余额)?|(?:现在|目前|当前|最新)(?:的)?(?:总资产|资产|总余额|余额)|总资产|总余额|资产合计|余额合计|余额(?=\s*(?:更新|修改|更正|调整|改)))"
    + _UPDATE
    + _CASH
)


def _source(store, identifier):
    with store._connection() as db:
        row = db.execute(
            "SELECT id,role,status,content,created_at FROM messages WHERE id=? AND COALESCE(json_extract(request_json,'$.origin'),'')!='agent_message'", (identifier,)
        ).fetchone()
    if row is not None and row["role"] == "user" and row["status"] in {"accepted", "applied"}:
        return dict(row)
    return None


def _business_day(source):
    moment = datetime.fromisoformat(source["created_at"].replace("Z", "+00:00"))
    zone = ZoneInfo("Asia/Shanghai")
    return (
        moment.replace(tzinfo=zone) if moment.tzinfo is None else moment.astimezone(zone)
    ).date()


def _requested_period(text, reference):
    def new_request(position):
        prefix = re.split(r"[，,。；;\n]", text[:position])[-1][-32:]
        return not re.search(
            r"不要|不用|不看|别按|不是|并非|上(?:一)?份|之前的|原来的|旧报告", prefix
        )

    ranges = []
    if re.search(_REPORT, text):
        for match in _RANGE.finditer(text):
            if not new_request(match.start()):
                continue
            year1, year2 = (
                int(match["y1"] or reference.year),
                int(match["y2"] or match["y1"] or reference.year),
            )
            try:
                start = date(year1, int(match["m1"]), int(match["d1"]))
                end = date(year2, int(match["m2"]), int(match["d2"]))
            except ValueError:
                continue
            if start <= end:
                ranges.append((start.isoformat(), end.isoformat()))
    if ranges:
        return ranges[0] if len(set(ranges)) == 1 else None
    months = []
    for pattern in (_MONTH_REPORT, _REPORT_MONTH):
        for match in pattern.finditer(text):
            if not new_request(match.start()):
                continue
            value = match["month"]
            if value in {"本月", "这个月", "上月", "上个月"}:
                year, month = reference.year, reference.month
                if value in {"上月", "上个月"}:
                    month -= 1
                    if month == 0:
                        year, month = year - 1, 12
            else:
                parsed = re.fullmatch(r"(?:(今年|去年)|(\d{4})年)?(\d{1,2})月(?:份)?", value)
                year = int(parsed[2]) if parsed[2] else reference.year - (parsed[1] == "去年")
                month = int(parsed[3])
            if 1 <= month <= 12:
                months.append(
                    (
                        f"{year:04d}-{month:02d}-01",
                        f"{year:04d}-{month:02d}-{calendar.monthrange(year, month)[1]:02d}",
                    )
                )
    return months[0] if len(set(months)) == 1 else None


def _asset_value(pattern, text):
    values = []
    for match in pattern.finditer(text):
        # A single named account must not replace an observation of total assets.
        prefix = text[max(0, match.start() - 12) : match.start()]
        if (
            re.search(r"银行卡|储蓄卡|信用卡|支付宝|微信|某个账户", prefix)
            and "总" not in match.group()
        ):
            continue
        if re.search(r"不是|没有|预计|假设|如果|计划", prefix):
            continue
        value = Decimal(match["amount"]) * {None: 1, "万": 10000, "千": 1000}[match["unit"]]
        values.append((f"{value:.2f}", match.group()))
    return values[0] if len({value[0] for value in values}) == 1 else None


def latest_verified_report(settings, store, conversation_id):
    with store._connection() as db:
        rows = db.execute(
            "SELECT e.data FROM events e JOIN runs r ON r.id=e.run_id WHERE r.conversation_id=? AND e.type='artifact' ORDER BY e.seq DESC LIMIT 200",
            (conversation_id,),
        ).fetchall()
    for row in rows:
        try:
            receipt = json.loads(row["data"])
            finance, verification = receipt.get("finance", {}), receipt.get("verification", {})
            if finance.get("program_generated") is not True or not verification.get(
                "finance_report_key"
            ):
                continue
            saved = store.get_resource(receipt["resource"]["id"], conversation_id)
            digest = hashlib.sha256(resource_bytes(settings, saved)).hexdigest()
            if digest != verification.get("sha256") or digest != receipt["resource"].get("sha256"):
                continue
            period = finance["facts"]["period"]
            if _date(period["start_date"]) > _date(period["end_date"]):
                continue
            return {
                "resource_id": saved["id"],
                "period": period,
                "assets": finance["facts"].get("assets"),
                "input_message_id": verification.get("finance_input_id"),
            }
        except (StoreError, OSError, ValueError, KeyError, TypeError):
            continue
    return None


def resolve_finance_report_context(
    settings, store, *, conversation_id, source_id, requested, period_evidence=None
):
    source = _source(store, source_id)
    prior = latest_verified_report(settings, store, conversation_id)
    if (requested.get("opening_assets") is None) != (requested.get("closing_assets") is None):
        if prior is None or not prior["assets"]:
            raise StoreError(
                "invalid_finance_report",
                "Asset observations must be provided together, or omit both and publish the known ledger/budget facts. Do not ask the user to fill missing fields.",
                422,
            )
    # Runtime binds a verified source. Standalone calls without one can still
    # use their supplied period; they cannot authorize a context change.
    text = source["content"] if source else ""
    reference = _business_day(source) if source else None
    explicit = _requested_period(text, reference) if reference else None
    # Legacy quote hints never grant or remove scope. The real bound user input
    # already establishes an explicit period; otherwise keep the verified prior
    # report. A paraphrase, cropped negation or fabricated hint cannot change it.
    args = dict(requested)
    basis = "provided_period"
    if prior is not None and explicit is None:
        args.update(prior["period"])
        assets = prior["assets"]
        args.update(
            opening_assets=assets["opening"] if assets else None,
            closing_assets=assets["closing"] if assets else None,
            approximate=assets["approximate"] if assets else True,
        )
        basis = "previous_verified_report"
    elif explicit is not None:
        args.update(start_date=explicit[0], end_date=explicit[1])
        basis = "current_user_period"
        if prior is not None and explicit != (
            prior["period"]["start_date"],
            prior["period"]["end_date"],
        ):
            # A prior balance pair belongs to its observation dates, not every
            # new month the user might ask to see.
            args.update(opening_assets=None, closing_assets=None)
    if source is not None and prior is not None and source_id != prior["input_message_id"]:
        opening, closing = _asset_value(_OPENING, text), _asset_value(_CLOSING, text)
        if opening:
            args["opening_assets"] = opening[0]
        if closing:
            args["closing_assets"] = closing[0]
            if (
                prior is not None
                and explicit is None
                and (
                    re.search(r"现在|目前|当前|最新", closing[1])
                    or (
                        not closing[1].startswith("期末")
                        and re.search(r"更新|修改|更正|调整|改", closing[1])
                    )
                )
            ):
                args["end_date"] = reference.isoformat()
        if opening or closing:
            basis += "+current_asset_observation"
            if re.search(
                r"约|大概|左右", (opening[1] if opening else "") + (closing[1] if closing else "")
            ):
                args["approximate"] = True
    if (args.get("start_date") is None) != (args.get("end_date") is None):
        raise StoreError(
            "invalid_finance_report",
            "请同时提供报表起止日期，或两者都省略使用现有报告/已知账本范围；无需让用户补表。",
            422,
        )
    if args.get("start_date") is None:
        with store._connection() as db:
            bounds = db.execute(
                "SELECT MIN(CASE WHEN entry_type='aggregate' THEN period_start ELSE date_start END),MAX(date_end) FROM finance_transactions WHERE deleted=0"
            ).fetchone()
        if bounds[0] and bounds[1]:
            args.update(start_date=bounds[0], end_date=bounds[1])
            basis = "known_ledger_period"
        elif reference:
            args.update(
                start_date=reference.replace(day=1).isoformat(), end_date=reference.isoformat()
            )
            basis = "source_month_to_date"
        else:
            raise StoreError(
                "invalid_finance_report",
                "尚无可用的报表或账本日期；可使用原用户已明确的起止范围。",
                422,
            )
    if (args.get("opening_assets") is None) != (args.get("closing_assets") is None):
        if (requested.get("opening_assets") is None) != (requested.get("closing_assets") is None):
            raise StoreError(
                "invalid_finance_report",
                "Asset observations must be provided together, or omit both and publish the known ledger/budget facts. Do not ask the user to fill missing fields.",
                422,
            )
        # One fresh observation must not force a fabricated comparison pair.
        args.update(opening_assets=None, closing_assets=None)
    return args, {
        "basis": basis,
        "input_message_id": source_id,
        "inherited_resource_id": prior["resource_id"] if prior and explicit is None else None,
        "period": {key: args[key] for key in ("start_date", "end_date")},
        "assets": {key: args[key] for key in ("opening_assets", "closing_assets", "approximate")},
    }
