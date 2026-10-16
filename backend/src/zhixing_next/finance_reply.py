"""Keep requested advice separate from deterministic write confirmations."""

import re


def requests_analysis(source):
    """Only an explicit request in this input, not quoted history or attachments."""
    source = re.sub(r"```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|\"[^\"]*\"|'[^']*'", "", source)
    source = re.sub(r"(?m)^\s*>.*$", "", source)
    for clause in re.split(r"[。！？；，,;\n]", source):
        if re.search(r"(?:不要|不用|无需|不必|别|不需要).{0,8}(?:解释|分析|比较|建议|推荐|规划)|\b(?:do not|don't|no need to)\b", clause, re.I):
            continue
        if re.search(
            r"(?:^|并且|并|再|顺便|同时|然后|请|帮我|麻烦)\s*(?:根据.{0,20}|结合.{0,20})?"
            r"(?:分析|解释|比较|对比|评估|推荐|规划|讲讲|说说)"
            r"|(?:并且|并|再|顺便|同时|然后|请|帮我|麻烦)\s*建议|^建议(?:一下|下|个|一些|点)"
            r"|(?:给我|给|提供|有什么|有哪些).{0,24}(?:建议|推荐|方案)"
            r"|为什么|为何|如何|怎么安排|怎么分配|怎么控制|还能花多少"
            r"|(?:这样|这么|分配|安排).{0,12}(?:合理|合适|可行)(?:吗|么|\?|$)"
            r"|\b(?:explain|compare|analy[sz]e|recommend|suggest|advice|why|how)\b",
            clause, re.I,
        ):
            return True
    return False


def requested_analysis(text):
    """Remove known unwanted follow-ups, not a general verifier of model prose."""
    kept = []
    fence = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r"\s*(```|~~~)", line)
        if marker:
            fence = None if fence == marker[1] else marker[1]
            kept.append(line)
            continue
        if fence:
            kept.append(line)
            continue
        for match in re.finditer(r"[^。！？!?；;\n]*(?:[。！？!?；;]|\n|$)", line):
            sentence = match[0]
            negative = re.search(r"(?:不(?:用|必|需要|要)|无需|无须).{0,10}(?:补|提供|填写|确认)", sentence)
            asks_for_history = re.search(r"(?:请|需要|还需|麻烦|先|你要|你把).{0,14}(?:补(?:充|齐|全|录)?|重报|填写|提供|告诉我|确认|发给我|逐项对账)", sentence)
            missing_history = re.search(r"流水|押金(?:金额)?|购买(?:日期|月份)|大件(?:日期|月份)|逐项对账|填表", sentence)
            invented_gap = re.search(r"(?:差额|缺口).{0,12}(?:大概率|最可能|应该|就是|来自|属于|算作).{0,12}(?:消费|开销|支出)", sentence)
            if re.search(r"(?:不能|不可|不应|并非|不是|无法|尚未确定)", sentence):
                invented_gap = None
            if (asks_for_history and missing_history and not negative) or invented_gap:
                if sentence.endswith("\n"):
                    kept.append("\n")
                continue
            kept.append(sentence)
    return "".join(kept).strip("\n")
