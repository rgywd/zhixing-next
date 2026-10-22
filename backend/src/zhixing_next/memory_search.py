"""Small lexical queries shared by recall and the persistent memory store."""

import re

_LATIN = re.compile(r"[a-z0-9]+")
_HAN = re.compile(r"[\u4e00-\u9fff]+")
_STOP = {"用户", "我的", "我们", "这个", "那个", "现在", "什么", "怎么", "一下", "已经"}


def memory_terms(value: str) -> list[str]:
    value = value.casefold()
    terms = _LATIN.findall(value)
    for word in _HAN.findall(value):
        terms.extend(word[index:index + 2] for index in range(len(word) - 1))
    terms = list(dict.fromkeys(term for term in terms if len(term) >= 2 and term not in _STOP))[:64]
    value = value.strip()
    return terms or ([value] if len(value) == 1 and value.isalnum() else [])
