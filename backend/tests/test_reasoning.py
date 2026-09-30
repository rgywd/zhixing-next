import json

import httpx
import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessageChunk, HumanMessage
from langgraph.checkpoint.sqlite import SqliteSaver
from openai import OpenAI

from zhixing_next.config import ModelConfig, Settings
from zhixing_next.models import ModelConfigurationError, create_model
from zhixing_next.reasoning import reasoning_options, reasoning_profile
from zhixing_next.thinking_chat import ThinkingChatOpenAI


@pytest.mark.parametrize(
    ("model", "protocol", "levels"),
    [
        ("Qwen/Qwen3.8-Flash", "chat_completions", ["auto", "none", "low", "medium", "high"]),
        ("QWEN3.8-MAX-0902", "chat_completions", ["auto", "none", "low", "medium", "xhigh"]),
        ("qwen3-235b-a22b-thinking-2507", "chat_completions", ["auto", "low", "medium", "high"]),
        ("qwen3.8-2.4t-a95b", "chat_completions", ["auto", "low", "medium", "high"]),
        ("qwen3-coder-plus", "chat_completions", []),
        ("qwen3-embedding-0.6b", "chat_completions", []),
        ("qwen-plus-2024-12-20", "chat_completions", []),
        ("qwen2.5-72b-instruct", "chat_completions", []),
        ("qwen3.5-omni", "chat_completions", []),
        ("qwen3.8-flash", "responses", []),
        ("deepseek/deepseek-v3.2", "chat_completions", ["auto", "none", "high"]),
        ("deepseek-v4-flash", "chat_completions", ["auto", "none", "low", "high", "max"]),
        ("deepseek-flash", "responses", ["auto", "none", "low", "high", "max"]),
        ("deepseek-reasoner", "chat_completions", []),
        ("OpenAI/GPT-5", "responses", ["auto", "minimal", "low", "medium", "high"]),
        ("gpt-5.1", "responses", ["auto", "none", "low", "medium", "high"]),
        ("gpt-5.2", "responses", ["auto", "none", "low", "medium", "high", "xhigh"]),
        ("gpt-5.2-codex", "responses", ["auto", "low", "medium", "high", "xhigh"]),
        ("gpt-5.6", "responses", ["auto", "none", "low", "medium", "high", "xhigh", "max"]),
        ("gpt-5-pro", "responses", ["auto", "high"]),
        ("gpt-6-astra", "responses", ["auto", "low", "medium", "high", "xhigh", "max"]),
        ("gpt-6-astra", "chat_completions", []),
        ("gpt-4o", "chat_completions", []),
        ("gpt-5-chat-latest", "chat_completions", []),
        ("o3", "chat_completions", ["auto", "low", "medium", "high"]),
        ("gemini-2.5-flash", "gemini", ["auto", "none", "low", "medium", "high"]),
        ("gemini-2.5-pro", "gemini", ["auto", "low", "medium", "high"]),
        ("google/gemini-3-pro-preview", "gemini", ["auto", "low", "high"]),
        ("gemini-3.1-pro-preview", "gemini", ["auto", "low", "medium", "high"]),
        ("gemini-3-flash-preview", "gemini", ["auto", "minimal", "low", "medium", "high"]),
        ("gemini-3.8-flash", "gemini", ["auto", "low", "medium", "high"]),
        ("gemini-2.5-flash-image", "gemini", []),
        ("z-ai/GLM_4.7", "chat_completions", ["auto", "none", "high"]),
        ("glm-5.3", "chat_completions", []),
        ("glm-4-flash", "chat_completions", []),
        ("moonshotai/Kimi-K2.5", "chat_completions", ["auto", "none", "high"]),
        ("kimi-k2-thinking", "chat_completions", []),
        ("moonshot-v1-8k", "chat_completions", []),
    ],
)
def test_model_id_rules_replace_legacy_generic_levels(model, protocol, levels):
    config = ModelConfig(
        model=model, protocol=protocol, reasoning_levels=["auto", "none", "low", "high", "xhigh"]
    )
    assert config.reasoning_levels == levels


def test_unknown_model_preserves_explicit_settings_and_ignores_brand_names():
    config = ModelConfig(
        model="custom",
        protocol="chat_completions",
        provider="Qwen GPT Gemini",
        display_name="GLM Kimi DeepSeek",
        reasoning_levels=["low", "high"],
    )
    assert reasoning_profile(config.model, config.protocol) is None
    assert config.reasoning_levels == ["low", "high"]
    assert reasoning_options(config, "high") == {"reasoning_effort": "high"}


@pytest.mark.parametrize(
    ("model", "protocol", "effort", "expected"),
    [
        ("qwen3.8-flash", "chat_completions", "none", {"extra_body": {"enable_thinking": False}}),
        (
            "qwen3.8-flash",
            "chat_completions",
            "low",
            {"extra_body": {"enable_thinking": True, "thinking_budget": 1024}},
        ),
        (
            "qwen3.8-max",
            "chat_completions",
            "xhigh",
            {"extra_body": {"enable_thinking": True, "reasoning_effort": "xhigh"}},
        ),
        (
            "deepseek-v3.2",
            "chat_completions",
            "none",
            {"extra_body": {"thinking": {"type": "disabled"}}},
        ),
        (
            "deepseek-v4-flash",
            "chat_completions",
            "max",
            {"extra_body": {"thinking": {"type": "enabled"}}, "reasoning_effort": "max"},
        ),
        ("deepseek-flash", "responses", "none", {"reasoning": {"effort": "none"}}),
        ("glm-4.7", "chat_completions", "high", {"extra_body": {"thinking": {"type": "enabled"}}}),
        (
            "kimi-k2.5",
            "chat_completions",
            "none",
            {"extra_body": {"thinking": {"type": "disabled"}}},
        ),
        ("gpt-5.2", "responses", "xhigh", {"reasoning_effort": "xhigh"}),
        ("gemini-2.5-flash", "gemini", "none", {"thinking_budget": 0}),
        ("gemini-2.5-pro", "gemini", "high", {"thinking_budget": 24576}),
        ("gemini-3-flash-preview", "gemini", "minimal", {"thinking_level": "minimal"}),
        ("gemini-2.5-flash", "chat_completions", "none", {"reasoning_effort": "none"}),
    ],
)
def test_request_parameters_follow_provider_protocol(model, protocol, effort, expected):
    config = ModelConfig(model=model, protocol=protocol)
    assert reasoning_options(config, effort) == expected
    assert reasoning_options(config, None) == {}


@pytest.mark.parametrize("model", ["glm-4.7", "kimi-k2.5", "deepseek-v3.2"])
def test_model_studio_third_party_switch_uses_endpoint_dialect(model):
    config = ModelConfig(
        model=model,
        protocol="chat_completions",
        base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    )
    assert reasoning_options(config, "none") == {"extra_body": {"enable_thinking": False}}


def test_selected_default_and_auto_reach_real_sdk_payload(tmp_path):
    configs = {
        "qwen": ModelConfig(
            model="qwen3.8-flash",
            protocol="chat_completions",
            api_key="test-only",
            reasoning_effort="medium",
        ),
        "gemini": ModelConfig(
            model="gemini-2.5-flash",
            protocol="gemini",
            api_key="test-only",
            reasoning_effort="none",
        ),
        "gpt": ModelConfig(
            model="gpt-5.2", protocol="responses", api_key="test-only", temperature=0.8
        ),
    }
    settings = Settings(
        data_dir=tmp_path / "data",
        workspace_root=tmp_path / "work",
        models=configs,
        roles={"chat": "qwen"},
    )
    model = create_model(settings, "chat")
    assert model._get_request_payload([HumanMessage("hi")])["extra_body"] == {
        "enable_thinking": True,
        "thinking_budget": 8192,
    }
    assert model.streaming is True
    assert "extra_body" not in create_model(settings, "chat", "qwen", "auto")._get_request_payload(
        [HumanMessage("hi")]
    )
    assert create_model(settings, "chat", "gemini").thinking_budget == 0
    assert "temperature" not in create_model(settings, "chat", "gpt", "high")._get_request_payload(
        [HumanMessage("hi")]
    )
    assert (
        create_model(settings, "chat", "gpt", "none")._get_request_payload([HumanMessage("hi")])[
            "temperature"
        ]
        == 0.8
    )
    with pytest.raises(ModelConfigurationError, match="thinking depth"):
        create_model(settings, "chat", "qwen", "xhigh")


def test_stream_thinking_receipts_merge_and_return_unmodified():
    model = ThinkingChatOpenAI(model="deepseek-v3.2", api_key="test-only", use_responses_api=False)
    chunks = [
        model._convert_chunk_to_generation_chunk(
            {"choices": [{"delta": {"role": "assistant", "reasoning_content": text}}]},
            AIMessageChunk,
            None,
        ).message
        for text in ["first ", "then "]
    ]
    merged = chunks[0] + chunks[1]
    assert merged.additional_kwargs["reasoning_content"] == "first then "
    assert (
        model._get_request_payload([HumanMessage("hi"), merged])["messages"][1]["reasoning_content"]
        == "first then "
    )


def test_tool_roundtrip_and_sqlite_checkpoint_keep_thinking_receipt(tmp_path):
    calls = []

    def serve(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            message = {
                "role": "assistant",
                "content": "",
                "reasoning_content": "original provider receipt",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "double", "arguments": '{"number": 2}'},
                    }
                ],
            }
        else:
            assert payload["messages"][-2]["reasoning_content"] == "original provider receipt"
            assert payload["messages"][-1]["role"] == "tool"
            message = {"role": "assistant", "content": "4", "reasoning_content": "checked result"}
        return httpx.Response(
            200,
            json={
                "id": "chat-test",
                "object": "chat.completion",
                "model": "glm-4.7",
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": "tool_calls" if len(calls) == 1 else "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    def double(number: int) -> int:
        """Double a number."""
        return number * 2

    with httpx.Client(transport=httpx.MockTransport(serve)) as http_client:
        client = OpenAI(
            api_key="test-only", base_url="https://example.invalid/v1", http_client=http_client
        )
        model = ThinkingChatOpenAI(
            model="glm-4.7",
            api_key="test-only",
            client=client.chat.completions,
            use_responses_api=False,
        )
        path = str(tmp_path / "checkpoints.sqlite")
        with SqliteSaver.from_conn_string(path) as checkpointer:
            agent = create_agent(model, tools=[double], checkpointer=checkpointer)
            result = agent.invoke(
                {"messages": [HumanMessage("double 2")]},
                {"configurable": {"thread_id": "thinking"}},
            )
            assert result["messages"][-1].content == "4"
        with SqliteSaver.from_conn_string(path) as restored:
            state = restored.get({"configurable": {"thread_id": "thinking"}})
            assert (
                state["channel_values"]["messages"][-3].additional_kwargs["reasoning_content"]
                == "original provider receipt"
            )
    assert len(calls) == 2
