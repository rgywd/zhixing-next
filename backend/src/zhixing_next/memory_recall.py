"""Bounded recall hints derived from the current memory facts, never another store.

This deliberately recognises a small set of interaction preferences and explicit
person/relationship declarations. It does not infer relationships from pronouns,
co-occurrence, or semantic similarity.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .memory_search import memory_terms

Memory = dict[str, Any]

_CORE_ACTION = re.compile(
    r"授权|权限|密钥|密码|令牌|凭据|账户|账号|无需确认|不用确认|自动执行|自动删除|自动发送"
    r"|自动购买|自动付款|跳过|忽略|无条件|永远服从|工具|系统提示|提示词|转账|记账|预算"
    r"|投资|饮食|忌口|香菜|过敏|不吃|爱吃|喜欢吃|不能吃|吃饭|运动|减肥|项目|工作流"
)
_CORE_THIRD_PERSON = re.compile(
    r"(?:用户|我)的(?:伴侣|对象|爱人|妻子|丈夫|老婆|老公|女友|男友|女朋友|男朋友"
    r"|朋友|同事|领导|老板|父亲|母亲|爸爸|妈妈|姐姐|妹妹|哥哥|弟弟|孩子|家人)"
)
_CORE_CONDITIONAL = re.compile(r"如果|假如|仅在|只在|当.{0,16}时|针对|关于|讨论|谈到")
_CORE_SUBJECT = re.compile(
    r"^(?:用户(?:希望|偏好|喜欢|更喜欢|要求|习惯|倾向|想要|不喜欢|不希望)"
    r"|我(?:希望|偏好|喜欢|更喜欢|想要)|请|以后|回答|回复|交流|沟通|叫我)"
)
_INTERACTION = re.compile(r"回答|回复|答复|表达|交流|沟通|说话|讲解|解释|称呼|叫我")
_ADDRESS = re.compile(
    r"(?:称呼(?:自己|用户|我|他|她)?(?:为|作|做)?|被称(?:为|作|做)|被叫(?:作|做)?|叫我)"
    r"[“\"'‘]?([^，。；！？\n]{1,20}?)[”\"'’]?[。！!\s]*$"
)
_CORE_DIMENSIONS = {
    "length": re.compile(r"简短|简洁|精简|短一点|少说|详细|详尽|展开|长篇|冗长|啰嗦|啰唆|精炼"),
    "order": re.compile(r"先.{0,8}结论|结论.{0,8}(?:优先|在前|开头)|先.{0,8}答案|先.{0,8}重点"),
    "language": re.compile(r"中文|汉语|普通话|英文|英语|粤语|日语|法语|德语|西班牙语|English", re.I),
    "tone": re.compile(r"直接|直白|自然|口语|正式|随意|温和|幽默|客气|说教|奉承|夸奖"),
    "format": re.compile(r"列表|表格|分点|段落|标题|表情|emoji|Markdown", re.I),
}


def _core_dimensions(content: str) -> set[str]:
    if (
        not content or len(content) > 240 or not _CORE_SUBJECT.search(content)
        or _CORE_ACTION.search(content) or _CORE_THIRD_PERSON.search(content)
        or _CORE_CONDITIONAL.search(content)
    ):
        return set()
    dimensions = set()
    if _ADDRESS.search(content):
        dimensions.add("address")
    if _INTERACTION.search(content):
        dimensions.update(key for key, pattern in _CORE_DIMENSIONS.items() if pattern.search(content))
    return dimensions


def core_memories(
    memories: list[Memory], limit: int = 4, max_chars: int = 800,
) -> list[Memory]:
    """Return whole, recent global interaction facts within a small total budget.

    A newer fact wins over an older fact in the same preference dimension. All
    returned objects are the original facts, so normal correction/deletion and
    memory-exposure tracking remain the source of truth.
    """
    result: list[Memory] = []
    dimensions_seen: set[str] = set()
    remaining = max(0, min(max_chars, 1500))
    for memory in sorted(memories, key=lambda item: str(item.get("updated_at", "")), reverse=True):
        content = str(memory.get("content", "")).strip()
        dimensions = _core_dimensions(content)
        if not dimensions or dimensions & dimensions_seen:
            continue
        # Mark even an oversized newer fact; its older contradictory version must
        # not silently take its place just because it would fit the budget.
        dimensions_seen.update(dimensions)
        if len(content) > remaining:
            continue
        result.append(memory)
        remaining -= len(content)
        if len(result) >= max(0, min(limit, 8)):
            break
    return result if limit > 0 else []


_ROLE_GROUPS = {
    "partner": ("伴侣", "对象", "另一半", "爱人"),
    "girlfriend": ("女朋友", "女友"),
    "boyfriend": ("男朋友", "男友"),
    "wife": ("妻子", "老婆"),
    "husband": ("丈夫", "老公"),
    "mother": ("母亲", "妈妈", "老妈"),
    "father": ("父亲", "爸爸", "老爸"),
    "older_sister": ("姐姐",),
    "younger_sister": ("妹妹",),
    "older_brother": ("哥哥",),
    "younger_brother": ("弟弟",),
    "friend": ("朋友",),
    "colleague": ("同事",),
    "boss": ("领导", "老板", "上司"),
}
_PARTNER_TYPES = {"partner", "girlfriend", "boyfriend", "wife", "husband"}
_ROLES = {alias: group for group, aliases in _ROLE_GROUPS.items() for alias in aliases}
_ROLE_PATTERN = "|".join(sorted(_ROLES, key=len, reverse=True))
_EX_ROLE_PATTERN = r"前任|前女友|前男友|前妻|前夫"
_NAME_PATTERN = r"[\u4e00-\u9fff]{2,16}|[A-Za-z][A-Za-z0-9_.-]{1,30}"
_NAME_LAZY = r"[\u4e00-\u9fff]{2,16}?|[A-Za-z][A-Za-z0-9_.-]{1,30}?"
_CLAUSE_START = r"(?:^|[，,。；;：:\n（(“\" ])"
_NAME_STOPS = re.compile(
    r"喜欢|不喜欢|爱吃|不吃|不怎么吃|不能吃|讨厌|偏好|爱好|最近|目前|现在|今年|身高|体重|生日"
    r"|来自|住在|工作|职业|已经|并且|也是|是我|是用户|的昵称|的别名|昵称|又叫|也叫|和我|与我"
)
_NAME_BAD = re.compile(r"用户|自己|我们|他们|她们|什么|名字|昵称|不是|不再|没有|可能|不确定")
_NAME_GENERIC = re.compile(
    r"^(?:不|很|都|会|能|在|曾|有|关系|存储|使用|支持|偏好|习惯|爱好|生日|身体|健康|年龄|性格|饮食|忌口)"
    r"|存储|编程|模型|实例|变量|字段|类型|数据库|接口"
)
_COMPACT_NAME = re.compile(
    r"^(?:[阿小老大][\u4e00-\u9fff]{1,2}|([\u4e00-\u9fff])\1"
    r"|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章"
    r"云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐"
    r"于时傅卞齐康伍余元卜顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴宋茅庞熊纪舒屈"
    r"项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡凌霍万卢莫房解应"
    r"宗丁宣邓单杭洪包左石崔吉龚程邢裴陆荣翁荀羊甄封储靳段富巫乌焦巴牧隗山谷车侯宓蓬全"
    r"班仰秋仲伊宫宁仇栾甘厉戎祖武符刘景詹束龙叶白怀蒲邰从鄂索咸赖卓屠池乔阳胥苍闻党翟"
    r"谭贡劳逄姬申扶冉雍桑桂濮牛寿通边扈燕冀浦尚农温别庄晏柴瞿阎连习艾容向古易慎廖庾终"
    r"暨居衡步都耿满弘匡国文寇广禄阙东欧利师巩聂晁勾敖融冷辛阚简饶曾沙关查鞠丰游权逯盖"
    r"益桓公][\u4e00-\u9fff]{1,2}|[A-Za-z][A-Za-z0-9_.-]{1,30})$"
)
_TEMPORAL = r"(?:前|以前的|过去的|曾经的)?"
_PERSON_AFTER_ROLE = re.compile(
    rf"(?:用户|我)(?:的)?(?P<past>{_TEMPORAL})(?P<role>{_ROLE_PATTERN}|{_EX_ROLE_PATTERN})"
    rf"(?:的名字)?(?P<link>不再是|并不是|不是|并非|名叫|叫做|名字叫|叫|是|为|[:：])?"
    rf"\s*[“\"'‘（(]?(?P<name>{_NAME_PATTERN})"
)
_PERSON_BEFORE_ROLE = re.compile(
    rf"{_CLAUSE_START}(?P<name>{_NAME_LAZY})[”\"'’）)]?\s*"
    rf"(?P<link>不再是|并不是|不是|并非|曾经是|以前是|曾是|是|为)"
    rf"(?:用户|我)(?:的)?(?P<past>{_TEMPORAL})(?P<role>{_ROLE_PATTERN}|{_EX_ROLE_PATTERN})"
)
_ALIAS = re.compile(
    rf"{_CLAUSE_START}(?P<name>{_NAME_LAZY})(?:的(?:昵称|别名|小名)(?:是|为|叫)?|也叫|又叫|又名)"
    rf"\s*[“\"'‘]?(?P<alias>{_NAME_PATTERN})"
)
_INLINE_ALIAS = re.compile(
    rf"[，,；;]\s*(?:昵称|小名|别名)(?:是|为|叫)?\s*[“\"'‘]?(?P<alias>{_NAME_PATTERN})"
)
_NEGATIVE_LINKS = {"不再是", "并不是", "不是", "并非", "曾经是", "以前是", "曾是"}
_QUERY_NEGATIVE = re.compile(
    rf"不再是|并不是|不是|并非|曾经|以前|过去|前(?:{_ROLE_PATTERN})|{_EX_ROLE_PATTERN}"
)
_QUERY_ROLE = re.compile(_ROLE_PATTERN)
_PERSON_PRONOUN = re.compile(r"她|(?<![其吉维利排])他(?!山|乡|国|日)")
_ROLE_FACT = re.compile(
    rf"^\s*(?:用户|我)(?:的)?(?P<role>{_ROLE_PATTERN})(?:的)?"
    r"(?P<predicate>喜欢|不喜欢|偏好|不吃|不能吃|不怎么吃|讨厌|爱好|生日|身高|体重"
    r"|住在|来自|从事|职业|工作在|需要|不能|不喝|爱吃|对.{1,12}过敏)"
)


@dataclass
class MemoryQueryExpansion:
    terms: list[str]
    support_records: list[Memory] = field(default_factory=list)
    dependency_records: list[Memory] = field(default_factory=list)
    person_scoped: bool = False
    scope_terms: list[str] = field(default_factory=list)
    scope_record_ids: list[str] = field(default_factory=list)
    ambiguous_aliases: list[str] = field(default_factory=list)
    blocked_aliases: list[str] = field(default_factory=list)


@dataclass
class _Binding:
    name: str
    role: str
    memory: Memory
    negative: bool = False


def _name(value: str) -> str:
    value = value.strip(" \t\n“”\"'‘’（）()")
    if stop := _NAME_STOPS.search(value):
        value = value[:stop.start()]
    if len(value) < 2 or _NAME_BAD.search(value) or _NAME_GENERIC.search(value):
        return ""
    return value


def _bindings(memories: list[Memory]) -> tuple[list[_Binding], list[tuple[str, str, Memory]]]:
    bindings: list[_Binding] = []
    aliases: list[tuple[str, str, Memory]] = []
    for memory in memories:
        content = str(memory.get("content", ""))
        local = []
        for pattern in (_PERSON_AFTER_ROLE, _PERSON_BEFORE_ROLE):
            for match in pattern.finditer(content):
                name, role = _name(match["name"]), match["role"]
                if not name:
                    continue
                if pattern is _PERSON_AFTER_ROLE:
                    prefix = content[match.start():match.start("name")]
                    explicit_name = match["link"] in {"名叫", "叫做", "名字叫", "叫", ":", "："}
                    quoted = any(mark in prefix for mark in ("“", "\"", "‘", "'", "（", "("))
                    # A role followed by a predicate/occupation is not a name.
                    # The compact no-link form is accepted only for a small
                    # conventional name shape; organisers use explicit naming.
                    if not (explicit_name or quoted or _COMPACT_NAME.fullmatch(name)):
                        continue
                local.append(_Binding(
                    name=name, role=_ROLES.get(role, "partner"), memory=memory,
                    negative=bool(match["past"]) or role not in _ROLES or match["link"] in _NEGATIVE_LINKS,
                ))
        bindings.extend(local)
        for match in _ALIAS.finditer(content):
            name, alias = _name(match["name"]), _name(match["alias"])
            if name and alias and name != alias:
                aliases.append((name, alias, memory))
        names = {binding.name for binding in local if not binding.negative}
        if len(names) == 1:
            name = next(iter(names))
            for match in _INLINE_ALIAS.finditer(content):
                if alias := _name(match["alias"]):
                    aliases.append((name, alias, memory))
            inline = re.compile(rf"{re.escape(name)}(?:也叫|又叫|又名)\s*[“\"'‘]?(?P<alias>{_NAME_PATTERN})")
            for match in inline.finditer(content):
                if alias := _name(match["alias"]):
                    aliases.append((name, alias, memory))
    return bindings, aliases


def _mentioned_name(query: str, name: str) -> bool:
    if name.isascii():
        return bool(re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", query, re.I))
    return name in query


def _query_roles(query: str) -> list[tuple[str, str]]:
    result = []
    for match in _QUERY_ROLE.finditer(query):
        before, after = query[:match.start()], query[match.end():]
        explicit = re.search(r"(?:我|用户|咱)(?:的)?$", before)
        # Another person's possessive ('林岚的对象') never means the user.
        unqualified = not before.strip() or not before[-1:].isalnum()
        if not (explicit or unqualified):
            continue
        if re.match(r"存储|模型|类型|字段|实例|编程", after):
            continue
        result.append((match[0], _ROLES[match[0]]))
    return result


def _role_types(role: str) -> set[str]:
    # A wife is a partner. A partner is not necessarily a wife; a girlfriend is
    # not evidence of a husband or a marriage.
    return _PARTNER_TYPES if role == "partner" else {role}


def _unique_records(records) -> list[Memory]:
    return list({str(memory["id"]): memory for memory in records}.values())


def memory_query_expansion(query: str, memories: list[Memory]) -> MemoryQueryExpansion:
    """Expand only explicit, unique current person bindings and track evidence.

    At most two people, eight additional names, eight shown supporting facts and
    1600 support characters are used. ``dependency_records`` are metadata-only
    exposure dependencies, including ambiguity and negative relationship facts.
    General role labels are never added as OR terms: they could match another
    person's similarly named relationship. Strict user-role-only facts can be
    supplied with their explicit binding as support instead.
    """
    base_terms = memory_terms(query)
    # A pronoun can be resolved by the live conversation, not by scanning every
    # person's preferences. The model may search an established explicit name.
    result = MemoryQueryExpansion(terms=list(base_terms), person_scoped=bool(_PERSON_PRONOUN.search(query)))
    if not query.strip():
        return result
    bindings, aliases = _bindings(memories)
    negatives = {(binding.name, binding.role) for binding in bindings if binding.negative}
    active = [binding for binding in bindings if not binding.negative and not any(
        binding.name == name and binding.role in _role_types(role) for name, role in negatives
    )]
    by_name: dict[str, list[_Binding]] = {}
    for binding in active:
        by_name.setdefault(binding.name, []).append(binding)
    alias_names: dict[str, set[str]] = {}
    for name, alias, _ in aliases:
        alias_names.setdefault(alias, set()).add(name)
    # An alias that is another explicitly declared person's own name is also
    # ambiguous. Do not merge those people just because the strings coincide.
    for alias in alias_names:
        if alias in by_name:
            alias_names[alias].add(alias)
    requested: list[tuple[str, str]] = []
    dependency: list[Memory] = []
    related_names: set[str] = set()
    queried_roles = _query_roles(query)
    for label, role in queried_roles:
        result.person_scoped = True
        candidates = [binding for binding in bindings if binding.role in _role_types(role)]
        dependency.extend(binding.memory for binding in candidates)
        related_names.update(binding.name for binding in candidates)
        names = {binding.name for binding in active if binding.role in _role_types(role)}
        if _QUERY_NEGATIVE.search(query):
            result.blocked_aliases.append(label)
        elif len(names) == 1:
            requested.append((next(iter(names)), label))
        elif len(names) > 1:
            result.ambiguous_aliases.append(label)
        elif any(binding.negative for binding in candidates):
            result.blocked_aliases.append(label)
    for name in by_name:
        if _mentioned_name(query, name):
            result.person_scoped = True
            related_names.add(name)
            if len(alias_names.get(name, {name})) == 1:
                requested.append((name, name))
    for alias, names in alias_names.items():
        if not _mentioned_name(query, alias):
            continue
        result.person_scoped = True
        related_names.update(names)
        dependency.extend(memory for name, value, memory in aliases if value == alias)
        if len(names) == 1:
            requested.append((next(iter(names)), alias))
        else:
            result.ambiguous_aliases.append(alias)
    for name in related_names:
        name_bindings = [binding for binding in bindings if binding.name == name]
        dependency.extend(binding.memory for binding in name_bindings)
        roles = {binding.role for binding in name_bindings}
        # Named lookup also depends on the uniqueness of any role-only support.
        dependency.extend(binding.memory for binding in bindings if any(
            binding.role in _role_types(role) for role in roles
        ))
        dependency.extend(memory for canonical, _, memory in aliases if canonical == name)
    result.dependency_records = _unique_records(dependency)
    if _QUERY_NEGATIVE.search(query):
        requested = []
    expanded_people: set[str] = set()
    for name, label in requested:
        if name in expanded_people or len(expanded_people) >= 2:
            continue
        person_bindings = by_name.get(name, [])
        support = [binding.memory for binding in person_bindings]
        extra = [name]
        for canonical, alias, memory in aliases:
            if canonical == name and len(alias_names.get(alias, set())) == 1:
                extra.append(alias)
                support.append(memory)
        supported_roles = {
            role for role in _ROLE_GROUPS
            if any(binding.role in _role_types(role) for binding in person_bindings)
            and {binding.name for binding in active if binding.role in _role_types(role)} == {name}
        }
        for memory in memories:
            match = _ROLE_FACT.search(str(memory.get("content", "")))
            if match and _ROLES[match["role"]] in supported_roles:
                support.append(memory)
        new_support = [item for item in _unique_records(support) if item["id"] not in {
            row["id"] for row in result.support_records
        }]
        if (
            len(result.support_records) + len(new_support) > 8
            or sum(len(str(row["content"])) for row in [*result.support_records, *new_support]) > 1600
        ):
            continue
        extra = list(dict.fromkeys(term.casefold() for term in extra if term.casefold() not in result.terms))
        if not support and label != name:
            continue
        result.terms.extend(extra[:max(0, 8 - (len(result.terms) - len(base_terms)))])
        result.support_records.extend(new_support)
        result.scope_terms.extend([name.casefold(), *(alias.casefold() for canonical, alias, _ in aliases
                                                   if canonical == name and len(alias_names.get(alias, set())) == 1)])
        result.scope_record_ids.extend(str(item["id"]) for item in new_support)
        result.dependency_records = _unique_records([*result.dependency_records, *new_support])
        expanded_people.add(name)
    # A saved role-only fact needs no invented name. Return it for a matching
    # explicit user-role query only when the role is neither ambiguous nor past.
    if not _QUERY_NEGATIVE.search(query):
        for label, role in queried_roles:
            if label in result.ambiguous_aliases or label in result.blocked_aliases:
                continue
            role_facts = [memory for memory in memories if (
                (match := _ROLE_FACT.search(str(memory.get("content", ""))))
                and _ROLES[match["role"]] in _role_types(role)
            )]
            result.scope_record_ids.extend(str(memory["id"]) for memory in role_facts)
    result.scope_terms = list(dict.fromkeys(result.scope_terms))[:8]
    result.scope_record_ids = list(dict.fromkeys(result.scope_record_ids))
    result.ambiguous_aliases = list(dict.fromkeys(result.ambiguous_aliases))
    result.blocked_aliases = list(dict.fromkeys(result.blocked_aliases))
    return result


def expanded_memory_terms(query: str, memories: list[Memory]) -> list[str]:
    """Convenience for callers that only need the search terms."""
    return memory_query_expansion(query, memories).terms
