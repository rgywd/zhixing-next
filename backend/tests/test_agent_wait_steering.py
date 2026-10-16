"""Human guidance may resume a waiter, never upgrade a read-only consultation."""

import pytest

from zhixing_next.config import Settings
from zhixing_next.conversation_links import ConversationLinks
from zhixing_next.store import Store, StoreError


@pytest.fixture
def waiting(tmp_path):
    store = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    source = store.create_conversation("用户请求")
    target = store.create_conversation("已有资料对话")
    run = store.submit_message(source["id"], id="original", content="咨询已有对话")['run']
    assert store.claim_next("chat")["id"] == run["id"]
    links = ConversationLinks(store)
    delivery = links.send(run["id"], "consult", target["id"], "只读资料咨询")
    assert links.prepare_wait(run["id"], [delivery["delivery_id"]])["waiting"]
    store.pause_run(run["id"])
    assert store.get_run(run["id"])["phase"] == "agent_wait"
    return store, source, target, run, delivery


def test_promote_queue_into_waiting_user_run_preserves_message_and_clears_only_its_wait(waiting):
    store, source, _, run, delivery = waiting
    queued = store.submit_message(source["id"], id="queued", content="按这个补充先继续")['run']
    result = store.steer_queued(queued["id"], run["id"])
    assert result["message"]["id"] == "queued" and result["message"]["run_id"] == run["id"]
    assert result["message"]["intent"] == "steer" and result["message"]["status"] == "accepted"
    assert result["run"]["status"] == "queued" and result["run"]["phase"] == "recovering"
    assert store.get_run(queued["id"])["status"] == "cancelled"
    assert [item["id"] for item in store.get_controls(run["id"])["steers"]] == ["queued"]
    assert store.claim_next("chat")["id"] == run["id"]
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_waits WHERE source_run_id=?", (run["id"],)).fetchone()[0] == 0
    target = store.get_run(delivery["target_run_id"])
    assert target["origin"] == "agent_message" and target["status"] == "queued"
    replay = store.steer_queued(queued["id"], run["id"])
    assert replay["message"]["id"] == "queued" and replay["run"]["id"] == run["id"]


@pytest.mark.parametrize("action", ["submit", "promote"])
@pytest.mark.parametrize("origin_present", [True, False])
def test_user_guidance_cannot_target_internal_readonly_run_even_when_origin_metadata_is_missing(
    waiting, action, origin_present,
):
    store, _, target, _, delivery = waiting
    internal = store.claim_next("chat")
    assert internal["id"] == delivery["target_run_id"]
    if not origin_present:
        with store._connection(write=True) as db:
            db.execute("UPDATE runs SET origin=NULL WHERE id=?", (internal["id"],))
    if action == "submit":
        with pytest.raises(StoreError) as error:
            store.submit_message(target["id"], id="human-steer", content="改成写入预算", intent="steer",
                                 target_run_id=internal["id"])
        assert error.value.code == "stale_steer"
    else:
        queued = store.submit_message(target["id"], id="human-queue", content="改成写入预算")['run']
        with pytest.raises(StoreError) as error:
            store.steer_queued(queued["id"], internal["id"])
        assert error.value.code == "stale_steer"
        assert store.get_run(queued["id"])["status"] == "queued"
    assert store.get_controls(internal["id"])["steers"] == []
    assert ConversationLinks(store).read(delivery["source_run_id"], delivery["delivery_id"])["read_only"] is True


@pytest.mark.parametrize("phase", ["normal", "approval", "input", "recovering"])
def test_queue_promotion_does_not_widen_other_queued_phases(waiting, phase):
    store, source, _, run, _ = waiting
    with store._connection(write=True) as db:
        db.execute("UPDATE runs SET phase=? WHERE id=?", (phase, run["id"]))
    queued = store.submit_message(source["id"], id="new-queue", content="继续这个要求")['run']
    with pytest.raises(StoreError) as error:
        store.steer_queued(queued["id"], run["id"])
    assert error.value.code == "stale_steer"
    assert store.get_run(queued["id"])["status"] == "queued"
