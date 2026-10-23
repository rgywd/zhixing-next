"""The collaboration migration preserves user data and custom instructions."""

import hashlib

import pytest
from test_runtime import make_settings

from zhixing_next.finance_service import FinanceService
from zhixing_next.health_tools import HEALTH_INSTRUCTIONS
from zhixing_next.store import Store

# Exact built-in from v13 commit 9bc88c1762ac1fdd1f5b7ee098c07aba18e78ee2.
# Keep this independent of the current runtime text so migrations cover old installs.
LEGACY_V13_INSTRUCTIONS = """你是知行的饮食与体重助手，先用query_health_context了解当前资料、约定、近期记录、选择困难和餐费摘要。替用户整理并直接完成清楚的记录，不让用户管理内部ID或版本。资料、提醒和纠正只传要改的字段；程序保留未提及信息并同事务读取revision，显式旧版本仍拒绝冲突。每个操作用不同稳定entry_key，重试沿用，实际消息来源由系统绑定，只有成功回执才能说已保存。
饮食记录实际吃下或明确跳过的内容，建议和采纳都不是已吃。漏记是未知，不是未吃或不达标；照片不证明精确克数、营养或餐费。体重与数字目标来自用户，不预设固定热量、减重速度或步数；膝盖等活动限制始终保留。AI提出的新规范用assistant_proposal/proposed，用户采纳才激活。规则日期省略则持续有效，暂停用status=paused。
推荐基于读取的当前context_revision，程序会重查已知禁忌和版本；有变化时重新读取并调整，不要求用户补状态。候选写可照着选择的实际食物、份量与替换，提醒放顶层note，避免把“不要吃某物”放候选列表触发冲突。已知过敏/禁忌不能出现在候选和替换中；存在过敏时提醒核对配料与交叉接触，不承诺安全。商家、价格和库存无来源不编造，日常预算也不能全部视为餐费。没有厨房且加热条件未知时优先即食或商家做好即可吃的组合。
不知道份量、配料和完整摄入时不诊断蛋白质/能量不足或摄入过量，按用户约定给均衡建议。不要推荐极端限制、禁食、药物、惩罚性运动或诊疗；不适、持续饥饿或难执行时先调整，必要时建议专业帮助。服务已计算的体重变化和财务数字直接引用，不自行改算。
采纳、替换、放弃用record_recommendation_feedback保存选择与困难，实际饮食另记并关联原recommendation_id。已采纳是历史选择，资料变化不要求重新采纳；回顾结合反馈和实际记录给一项下一步。纠正原记录，不新建冒充纠正，不删真实饮食美化达标。提醒保存仅代表本机排期偏好，手机同步和实际通知另有回执；今天不提醒只追加当地日期到paused_dates。记录和修改回执简短自然，模型不可用时仍可直接记录。"""


@pytest.mark.parametrize(
    "instructions",
    [
        HEALTH_INSTRUCTIONS,
        LEGACY_V13_INSTRUCTIONS,
        LEGACY_V13_INSTRUCTIONS + "\n自定义追加要求：先简短回答。",
        "只用简短句子，先回答我问的事。",
        HEALTH_INSTRUCTIONS + "\n我的自定义约定：简短回复。",
    ],
)
def test_v13_to_v14_preserves_ledger_and_only_removes_exact_builtin_default(tmp_path, instructions):
    settings = make_settings(tmp_path)
    store = Store(settings)
    transaction = FinanceService(store).create_transaction(
        idempotency_key="original-payment",
        kind="expense",
        amount="24.60",
        occurred_on="2026-10-16",
        category="餐饮",
    )
    with store._connection(write=True) as db:
        db.execute("UPDATE agents SET instructions=? WHERE id='health'", (instructions,))
        for table in (
            "conversation_waits",
            "conversation_deliveries",
            "agent_child_events",
            "agent_child_inputs",
            "agent_children",
        ):
            db.execute(f"DROP TABLE {table}")
        db.execute("ALTER TABLE runs DROP COLUMN origin")
        db.execute("PRAGMA user_version=13")
    upgraded = Store(settings)
    expected = (
        "" if instructions in {HEALTH_INSTRUCTIONS, LEGACY_V13_INSTRUCTIONS} else instructions
    )
    assert upgraded.get_agent("health")["instructions"] == expected
    assert FinanceService(upgraded).list_transactions(month="2026-10")["items"][0] == transaction
    with upgraded._connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 15
        assert "origin" in {row[1] for row in db.execute("PRAGMA table_info(runs)")}
        assert all(
            db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            for name in (
                "agent_children",
                "agent_child_inputs",
                "conversation_deliveries",
                "conversation_waits",
            )
        )
    assert Store(settings).get_agent("health")["instructions"] == expected


def test_legacy_v13_fixture_matches_committed_default_hash():
    assert (
        hashlib.sha256(LEGACY_V13_INSTRUCTIONS.encode()).hexdigest()
        == "0005c36d57596235f8dbed50fdbf9fd53c1a2d6557cd3ab4e475af5ba30dc3fe"
    )
