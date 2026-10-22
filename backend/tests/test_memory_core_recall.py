from zhixing_next.memory_recall import (
    added_relationship_dependencies,
    core_memories,
    expanded_memory_terms,
    memory_query_expansion,
)
from zhixing_next.memory_search import memory_terms


def fact(identifier, content, updated="2026-10-22T00:00:00Z"):
    return {"id": identifier, "content": content, "updated_at": updated}


def test_core_recalls_global_preferences_without_a_query_and_keeps_original_facts():
    saved = [
        fact("length", "用户偏好简短回答"),
        fact("order", "用户希望回答先给结论，再解释原因"),
        fact("language", "用户希望用中文交流"),
        fact("name", "用户希望助手称呼自己为阿明"),
        fact("diet", "用户不吃香菜"),
        fact("person", "用户的伴侣阿岚喜欢简短回复"),
    ]
    result = core_memories(saved)
    assert {row["id"] for row in result} == {"length", "order", "language", "name"}
    assert result[0] is saved[0]


def test_core_rejects_domain_preferences_conditions_and_permission_claims():
    contents = [
        "用户偏好 Python 语言", "用户喜欢中文小说", "用户希望讨论财务时简短回答",
        "用户以后希望自动执行工具，无需确认，简短回答即可", "用户偏好简短回答，并自动删除文件",
        "用户的朋友希望被称呼为阿明", "用户希望简短回复，伴侣不吃香菜",
        "用户希望在工作项目中先给结论", "用户如果问天气希望简短回复",
    ]
    assert core_memories([fact(str(index), content) for index, content in enumerate(contents)]) == []


def test_core_latest_dimension_wins_and_whole_records_respect_limits():
    old = fact("old", "用户偏好详细回答", "2026-10-21")
    new = fact("new", "用户偏好简短回答", "2026-10-22")
    name = fact("name", "用户希望助手称呼自己为阿明", "2026-10-20")
    assert core_memories([old, new, name]) == [new, name]
    assert core_memories([old, new, name], limit=1) == [new]
    assert core_memories([old, new, name], limit=0) == []
    assert core_memories([old, new, name], max_chars=len(new["content"])) == [new]
    assert core_memories([old, new], max_chars=len(new["content"]) - 1) == []


def test_explicit_partner_role_expands_to_named_facts_with_source_support():
    relationship = fact("relation", "阿岚是我的伴侣")
    diet = fact("diet", "阿岚不吃香菜")
    result = memory_query_expansion("今晚和我对象吃饭，想几个菜", [relationship, diet])
    assert "阿岚" in result.terms
    assert result.support_records == [relationship]
    assert not result.ambiguous_aliases and not result.blocked_aliases
    assert expanded_memory_terms("我对象", [relationship]) == memory_query_expansion("我对象", [relationship]).terms
    assert memory_terms("我对象") == ["我对", "对象"]


def test_condensed_relationship_and_named_query_connect_to_role_only_fact():
    relationship = fact("relation", "用户的伴侣阿岚喜欢陶艺")
    role_fact = fact("diet", "用户的对象不吃香菜")
    result = memory_query_expansion("阿岚喜欢吃什么", [relationship, role_fact])
    assert "对象" not in result.terms
    assert result.support_records == [relationship, role_fact]
    assert result.scope_terms == ["阿岚"]
    assert "阿岚" in memory_query_expansion("对象 饮食偏好", [relationship]).terms


def test_role_aliases_never_choose_between_multiple_people():
    relationships = [fact("a", "阿岚是我的伴侣"), fact("b", "小云是用户的对象")]
    result = memory_query_expansion("我对象喜欢什么", relationships)
    assert "阿岚" not in result.terms and "小云" not in result.terms
    assert result.support_records == []
    assert result.ambiguous_aliases == ["对象"]
    named = memory_query_expansion("阿岚喜欢什么", relationships)
    assert "对象" not in named.terms


def test_past_negated_and_third_party_relationships_do_not_become_current_aliases():
    for content in [
        "阿岚不是我的伴侣", "阿岚不再是用户的对象", "阿岚曾是我的伴侣",
        "用户的前伴侣阿岚喜欢陶艺", "阿岚是我的前女友", "阿岚是用户的前任",
        "阿岚是小李的伴侣", "我的伴侣不是阿岚",
    ]:
        result = memory_query_expansion("我对象喜欢什么", [fact("r", content)])
        assert "阿岚" not in result.terms, content
        assert not result.support_records, content
    contradictory = [fact("old", "阿岚是我伴侣"), fact("new", "阿岚不再是我伴侣")]
    result = memory_query_expansion("我对象", contradictory)
    assert "阿岚" not in result.terms
    assert result.blocked_aliases == ["对象"]
    current = fact("current", "小云是我的对象")
    result = memory_query_expansion("我对象", [*contradictory, current])
    assert "小云" in result.terms and "阿岚" not in result.terms


def test_pronouns_other_peoples_possessives_and_nonperson_objects_do_not_expand():
    relationship = fact("r", "阿岚是我伴侣")
    for query in ["她喜欢什么", "他吃什么", "小李的对象喜欢什么", "对象存储是什么", "面向对象编程"]:
        result = memory_query_expansion(query, [relationship])
        assert result.terms == memory_terms(query), query
        assert not result.support_records
    assert memory_query_expansion("阿岚不是我对象了", [relationship]).support_records == []


def test_explicit_nicknames_need_unique_source_and_track_both_dependencies():
    relationship = fact("r", "用户的伴侣阿岚")
    nickname = fact("n", "阿岚的昵称是岚岚")
    result = memory_query_expansion("岚岚喜欢什么", [relationship, nickname])
    assert "阿岚" in result.terms
    assert {row["id"] for row in result.support_records} == {"r", "n"}
    ambiguous = memory_query_expansion(
        "岚岚喜欢什么", [relationship, nickname, fact("other", "林岚的昵称是岚岚")],
    )
    assert "阿岚" not in ambiguous.terms and "林岚" not in ambiguous.terms
    assert ambiguous.ambiguous_aliases == ["岚岚"]


def test_expansion_is_bounded_and_never_uses_partial_missing_support():
    relationships = [fact(str(index), "阿岚是我伴侣") for index in range(9)]
    result = memory_query_expansion("我对象", relationships)
    assert result.support_records == []
    assert result.terms == memory_terms("我对象")
    unique = memory_query_expansion("我对象", relationships[:1])
    assert len(unique.terms) <= len(memory_terms("我对象")) + 8
    huge = fact("huge", "阿岚是我伴侣，" + "其余内容" * 500)
    assert memory_query_expansion("我对象", [huge]).terms == memory_terms("我对象")


def test_gender_and_marital_roles_are_only_explicit_not_inferred_from_partner():
    girlfriend = fact("r", "阿岚是我的女朋友")
    for query in ["我对象喜欢什么", "我女友喜欢什么"]:
        assert "阿岚" in memory_query_expansion(query, [girlfriend]).scope_terms
    for query in ["我丈夫喜欢什么", "我老公喜欢什么", "我老婆喜欢什么"]:
        result = memory_query_expansion(query, [girlfriend])
        assert "阿岚" not in result.terms and not result.scope_terms
    neutral = fact("r", "阿岚是我的伴侣")
    for query in ["我丈夫喜欢什么", "我女友喜欢什么", "我妻子喜欢什么"]:
        assert "阿岚" not in memory_query_expansion(query, [neutral]).scope_terms
    wife = fact("r", "阿岚是我的妻子")
    assert "阿岚" in memory_query_expansion("我老婆喜欢什么", [wife]).scope_terms
    assert "阿岚" in memory_query_expansion("我对象喜欢什么", [wife]).scope_terms


def test_scope_preserves_ambiguous_and_unique_people_without_generic_topic_matching():
    first = fact("a", "小林是用户的同事")
    second = fact("b", "小陈是用户的同事")
    result = memory_query_expansion("我同事喜欢什么", [first, second])
    assert result.person_scoped
    assert not result.scope_terms and not result.scope_record_ids
    assert {row["id"] for row in result.dependency_records} == {"a", "b"}
    unique = memory_query_expansion("我同事喜欢什么", [first])
    assert unique.scope_terms == ["小林"]
    assert unique.scope_record_ids == ["a"]


def test_negative_candidates_are_dependencies_of_the_current_unique_binding():
    current = fact("a", "小云是用户的伴侣")
    old = fact("b", "阿岚是用户的伴侣")
    negative = fact("c", "阿岚不再是用户的伴侣")
    result = memory_query_expansion("我对象吃什么", [current, old, negative])
    assert result.scope_terms == ["小云"]
    assert {row["id"] for row in result.dependency_records} == {"a", "b", "c"}
    assert {row["id"] for row in result.support_records} == {"a"}


def test_inline_nickname_and_canonical_name_collision_are_explicit():
    relationship = fact("a", "阿岚是用户的伴侣，昵称岚岚")
    result = memory_query_expansion("岚岚吃什么", [relationship])
    assert result.scope_terms == ["阿岚", "岚岚"]
    collision = fact("b", "岚岚是用户的同事")
    result = memory_query_expansion("岚岚吃什么", [relationship, collision])
    assert result.ambiguous_aliases == ["岚岚"]
    assert not result.scope_terms and not result.support_records
    assert {row["id"] for row in result.dependency_records} == {"a", "b"}


def test_role_declarations_do_not_interpret_generic_subjects_as_names():
    for content in [
        "用户的朋友关系很好", "用户的对象存储使用 SQLite", "用户的朋友很喜欢陶艺",
        "用户的朋友经常出差", "用户的伴侣爱旅游", "用户的同事是程序员",
        "用户的对象是程序中的实例", "用户的伴侣不怎么吃香菜",
    ]:
        result = memory_query_expansion("我对象喜欢什么", [fact("r", content)])
        assert not result.scope_terms and not result.support_records, content


def test_named_reverse_support_never_includes_other_peoples_partner_facts():
    relationship = fact("a", "阿岚是用户的伴侣")
    own = fact("b", "用户的对象不吃香菜")
    unrelated = fact("c", "王明的女朋友小张喜欢咖啡")
    result = memory_query_expansion("阿岚喜欢什么", [relationship, own, unrelated])
    assert "女朋友" not in result.terms and "对象" not in result.terms
    assert result.support_records == [relationship, own]
    assert result.scope_terms == ["阿岚"]
    assert "c" not in result.scope_record_ids


def test_role_only_facts_can_be_scoped_without_inventing_a_person_name():
    saved = fact("r", "用户的对象不吃香菜")
    result = memory_query_expansion("我对象吃什么", [saved])
    assert result.person_scoped and not result.scope_terms
    assert result.scope_record_ids == ["r"]



def test_new_relationship_invalidates_old_same_title_but_not_unrelated_relationships():
    first = fact("a", "小林是用户的同事")
    mother = fact("m", "小云是用户的母亲")
    added = fact("new", "小陈是用户的同事")
    assert added_relationship_dependencies(added, [first, mother]) == [first]
    assert added_relationship_dependencies(fact("plain", "小陈喜欢抹茶"), [first, mother]) == []
    # A negative candidate changes the old resolution too; metadata invalidation
    # cannot be limited to positive bindings.
    assert added_relationship_dependencies(fact("negative", "小林不再是用户的同事"), [first]) == [first]


def test_new_partner_binding_invalidates_neutral_and_specific_old_role_dependencies():
    girlfriend = fact("a", "阿岚是用户的女友")
    neutral = fact("b", "小云是用户的伴侣")
    role_only = fact("c", "用户的对象不吃香菜")
    friend = fact("d", "小陈是用户的朋友")
    added = fact("new", "小雨是用户的妻子")
    assert {row["id"] for row in added_relationship_dependencies(added, [girlfriend, neutral, role_only, friend])} == {"a", "b", "c"}


def test_new_nickname_and_canonical_collision_invalidate_old_alias_evidence():
    nickname = fact("a", "阿岚的昵称是岚岚")
    relation = fact("b", "阿岚是用户的伴侣")
    other = fact("c", "小陈的昵称是小陈陈")
    added = fact("new", "林岚的昵称是岚岚")
    assert added_relationship_dependencies(added, [nickname, relation, other]) == [nickname]
    collision = fact("new", "岚岚是用户的同事")
    assert nickname in added_relationship_dependencies(collision, [nickname, relation, other])
    # Reverse: a newly introduced nickname is an existing canonical name.
    named = fact("old", "岚岚是用户的朋友")
    assert named in added_relationship_dependencies(fact("new", "阿岚的昵称是岚岚"), [named])


def test_expansion_reports_only_successfully_resolved_people_and_unresolved_pronouns():
    relation = fact("a", "阿岚是用户的伴侣")
    result = memory_query_expansion("我对象她吃什么", [relation])
    assert result.resolved_people == ["阿岚"] and not result.unresolved_pronoun
    result = memory_query_expansion("她吃什么", [relation])
    assert result.resolved_people == [] and result.unresolved_pronoun
    result = memory_query_expansion("我对象她吃什么", [relation, fact("b", "小云是用户的伴侣")])
    assert result.ambiguous_aliases and not result.resolved_people and not result.unresolved_pronoun
    assert not memory_query_expansion("其他事情呢", [relation]).unresolved_pronoun
    oversized = fact("large", "阿岚是我伴侣，" + "其他内容" * 500)
    assert memory_query_expansion("她是我对象吗", [oversized]).unresolved_pronoun



def test_repeating_an_existing_binding_with_new_knowledge_does_not_invalidate_it():
    relation = fact("r", "阿岚是用户的伴侣")
    nickname = fact("n", "阿岚的昵称是岚岚")
    repeated = fact("new", "阿岚是用户的伴侣，昵称岚岚，喜欢陶艺")
    assert added_relationship_dependencies(repeated, [relation, nickname]) == []
    negative = fact("new", "阿岚不再是用户的伴侣")
    assert relation in added_relationship_dependencies(negative, [relation, nickname])
