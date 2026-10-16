"""Bounded AI guard against relabelling explicit existing-asset moves as income.

This checks contradictions in real user text, not arbitrary attachments or all
financial semantics. Manual HTTP input continues through the service unchanged.
"""

import re
from decimal import Decimal, InvalidOperation

from .store import StoreError

_ASSET = re.compile(
    r"公积金|存款|储蓄|本金|账户余额|已有(?:资产|余额)|原有(?:资产|余额)|自有账户|自己账户|provident\s*fund|savings|deposit|principal|existing\s*balance|own\s*account",
    re.I,
)
_MOVE = re.compile(
    r"提取|提现|提款|取出|取回|赎回|转出|转入|withdraw(?:al)?|redeem|redemption|transfer", re.I
)
_NON_FACT = re.compile(
    r"没有|并未|尚未|未曾|不曾|从未|无新增|没(?:新(?:增)?(?:缴存|缴纳)|到账|收到|发工资)|未提取|未提现|未到账|不是|并非|不算|不属于|未新增|未缴存|计划|预计|假设|假如|如果|将会|准备|可能|每(?:个)?月|每.{0,6}(?:个月|季度|年)|hypothetical|planned|expected|not\s+(?:withdraw|income|contribut)",
    re.I,
)
_INCOME = re.compile(
    r"工资|薪资|薪水|薪酬|奖金|发薪|缴存|缴纳|利息|收益|分红|盈利|salary|wages?|bonus|interest|yield|dividend|new\s*contributions?",
    re.I,
)
_BOUNDARY = re.compile(
    r"公积金|存款|储蓄|本金|账户余额|余额|资产|手机|电脑|房租|租金|工资|薪资|薪水|奖金|缴存|缴纳|利息|收益|分红|提取|提现|提款|取出|赎回|转出|转入|salary|wages?|bonus|principal|withdraw|contribut|interest|yield|dividend",
    re.I,
)
_NUMBER = re.compile(r"(?<![\d.])(\d+(?:\.\d{1,2})?)\s*(万|千)?")
_COUNT = r"(?:\d{1,3}|[一二两三四五六七八九十]{1,3})"
_MULTIPLIER = re.compile(r"(?:各自|分别|均|都)\s*(?:乘(?:以)?|[×x*])\s*(" + _COUNT + r")", re.I)
_CLAUSE = re.compile(r"[^，,。；;、\n]+")
_CORRECTION = re.compile(
    r"这(?:一)?(?:笔|条)|该(?:笔|条)|那(?:笔|条)|上(?:笔|条)|之前(?:记错|误记)|原(?:来)?记录|更正|纠正|改为|应为|实际(?:是|为)|其实(?:是|为)",
    re.I,
)


def _count(value):
    from .finance_dates import _number

    result = _number(value)
    return result if 1 <= result <= 120 else None


def _money_values(text):
    values = []
    for match in _NUMBER.finditer(text):
        before, after = text[: match.start()], text[match.end() :]
        # Dates, counts, multiplication factors and percentages are not cash.
        if re.match(r"(?:年|月|日|号|次|笔|个|倍|%)", after) or re.search(
            r"(?:乘(?:以)?|[×x*]|[-/.])\s*$", before
        ):
            continue
        if re.match(r"[-/]\d", after):
            continue
        value = Decimal(match[1]) * {None: 1, "万": 10000, "千": 1000}[match[2]]
        if value > 0:
            values.append(value)
    return values


def _clauses(text):
    # Keep the full original clause for negation checks. A positive correction
    # after “而是” has its own scope; clipping a negative quote cannot authorize it.
    for match in _CLAUSE.finditer(text):
        for piece in re.split(
            r"而是|(?:并且|并|另外|另|同时)(?=.{0,8}(?:提取|提现|提款|赎回))", match.group()
        ):
            if piece.strip():
                yield piece.strip(), match.start(), match.end()


def _has_asset_move(text):
    return bool(_ASSET.search(text)) and any(
        _MOVE.search(clause) and not _NON_FACT.search(clause) for clause, _, _ in _clauses(text)
    )


def _positive_income(text, *, quote=None, unchanged_amount=None):
    proofs = []
    quote_spans = []
    if quote is not None:
        offset = 0
        while (position := text.find(quote, offset)) >= 0:
            quote_spans.append((position, position + len(quote)))
            offset = position + 1
    for clause, start, end in _clauses(text):
        if _NON_FACT.search(clause):
            continue
        if quote is not None:
            if not any(left < end and right > start for left, right in quote_spans):
                continue
            # A supplied quote must include the actual positive claim and amount.
            candidate = quote if quote in clause else clause if clause in quote else ""
        else:
            candidate = clause
        for event in _INCOME.finditer(candidate):
            remainder = candidate[event.end() :]
            if re.search(r"缴存|缴纳|contribut", event.group(), re.I):
                remainder = re.sub(
                    r"^\s*(?:了|的|to\s+)?\s*(?:住房公积金|公积金|provident\s*fund)\s*",
                    "",
                    remainder,
                    flags=re.I,
                )
            boundary = _BOUNDARY.search(remainder)
            segment = remainder[: boundary.start()] if boundary else remainder
            values = _money_values(segment)
            if not values:
                prefix = candidate[: event.start()]
                money = re.search(r"(\d+(?:\.\d{1,2})?\s*(?:万|千)?\s*(?:元|块)?)\s*$", prefix)
                if money:
                    values = _money_values(money[1])
            if not values and unchanged_amount is not None and _CORRECTION.search(text):
                # An explicit correction of this existing record can retain its
                # known amount; the user need not repeat it. Never use this for
                # creates or to authorize a changed amount.
                values = [unchanged_amount]
            amounts = set(values)
            # Explicit “各自乘N” refers to these nearby declared amounts, not
            # opening/closing assets or an unrelated purchase elsewhere.
            multipliers = {
                _count(match[1]) for match in _MULTIPLIER.finditer(text[end : end + 180])
            } - {None}
            direct = re.search(r"(?:乘(?:以)?|[×x*])\s*(" + _COUNT + r")", segment, re.I)
            if direct and _count(direct[1]):
                multipliers.add(_count(direct[1]))
            # “两笔工资，每笔X” / “工资X发了两次” is another explicit count.
            nearby = text[max(0, start - 70) : end]
            if re.search(r"每(?:笔|次)|各(?:笔|次)", candidate):
                for match in re.finditer(
                    r"(" + _COUNT + r")\s*(?:笔|次|个月)\s*(?:工资|薪资)?", nearby
                ):
                    if _count(match[1]):
                        multipliers.add(_count(match[1]))
            amounts.update(value * multiplier for value in values for multiplier in multipliers)
            if amounts:
                proofs.append(
                    {
                        "clause": clause,
                        "amounts": amounts,
                        "fund": bool(re.search(r"缴存|缴纳|contribut", event.group(), re.I))
                        or (
                            not re.search(
                                r"工资|薪资|薪水|薪酬|奖金|发薪|salary|wages?|bonus",
                                event.group(),
                                re.I,
                            )
                            and bool(
                                re.search(
                                    r"(?:公积金|provident\s*fund)[^，,。；;]{0,16}$",
                                    candidate[: event.start()],
                                    re.I,
                                )
                            )
                        ),
                    }
                )
    return proofs


def verify_income_facts(
    store, *, source_id, fields, current=None, evidence=None, evidence_source_id=None
):
    """Only explicit user-text asset moves activate this finite contradiction guard."""
    effective = {**(current or {}), **fields}
    if effective.get("kind") != "income":
        return None

    def fail():
        raise StoreError(
            "existing_asset_is_transfer",
            "未保存这笔新增收入：真实用户文字描述了已有资产提取或转移，未找到与本笔金额对应的新增收入事实。请保留已有提取的kind=transfer记录，先查询get_finance_summary或reconcile_finance_assets核对并继续完成。不要通过删除备注、修改分类反复尝试新增缴存，也不要索要用户未提及的缴存确认。真正的新缴存、工资或收益应依据原用户正向条款与金额分别记录；历史原话可用fact_source_message_id及fact_evidence引用。此保护核验已知文字矛盾，不把附件内容自动猜成新增收入。",
            422,
        )

    identifiers = [source_id, (current or {}).get("source_id"), evidence_source_id]
    rows = {}
    with store._connection() as db:
        for identifier in dict.fromkeys(item for item in identifiers if item):
            row = db.execute(
                "SELECT id,role,status,content FROM messages WHERE id=?", (identifier,)
            ).fetchone()
            if (
                row is not None
                and row["role"] == "user"
                and row["status"] in {"accepted", "applied"}
            ):
                rows[identifier] = dict(row)
    if not any(_has_asset_move(row["content"]) for row in rows.values()):
        return None
    if evidence_source_id is not None or evidence is not None:
        row = rows.get(evidence_source_id or source_id)
        if row is None or (
            evidence is not None
            and (not evidence.strip() or evidence.strip() not in row["content"])
        ):
            fail()
        candidates = [row]
        quote = evidence.strip() if evidence is not None else None
    else:
        candidates = list(rows.values())
        quote = None
    try:
        amount = Decimal(effective.get("amount", ""))
    except (InvalidOperation, ValueError, TypeError):
        # The service owns validation of malformed money; this guard cannot
        # authorize it, but should not obscure its existing input diagnostics.
        return None
    description = str(effective.get("category", "")) + " " + str(effective.get("note", ""))
    requires_fund = bool(re.search(r"公积金|provident|contribut", description, re.I))
    unchanged_amount = None
    if current is not None:
        try:
            if amount == Decimal(current["amount"]):
                unchanged_amount = amount
        except (InvalidOperation, ValueError, TypeError):
            pass
    for row in candidates:
        for proof in _positive_income(
            row["content"], quote=quote, unchanged_amount=unchanged_amount
        ):
            if amount in proof["amounts"] and (not requires_fund or proof["fund"]):
                return {
                    "source_message_id": row["id"],
                    "quote": proof["clause"],
                    "amount": f"{amount:.2f}",
                    "basis": "user_stated_new_income",
                }
    fail()
