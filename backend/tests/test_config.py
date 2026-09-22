from pathlib import Path

import pytest

from zhixing_next.config import ModelConfig, Settings, load_settings


def test_local_config_resolves_paths_and_keeps_keys_out_of_serialization(tmp_path, monkeypatch):
    config = tmp_path / "config.toml"
    config.write_text('data_dir="state"\n[[grants]]\npath="docs"\nwritable=false\n')
    monkeypatch.setenv("ZHIXING_CONFIG", str(config))
    monkeypatch.setenv("ZHIXING_API_TOKEN", "local-test-access-token-that-is-not-a-secret")
    monkeypatch.delenv("ZHIXING_DATA_DIR", raising=False)
    settings = load_settings()
    assert settings.data_dir == tmp_path / "state"
    assert settings.workspace_root == tmp_path / "state/workspaces"
    assert settings.grants[0].path == tmp_path / "docs"
    assert settings.config_file == config
    assert "api_token" not in settings.model_dump()
    assert "local-test-access" not in repr(settings)


@pytest.mark.parametrize("url", ["http://example.org/v1", "https://user:password@example.org", "https://example.org?key=secret"])
def test_model_endpoints_reject_plaintext_remote_and_embedded_credentials(url):
    with pytest.raises(ValueError):
        ModelConfig(protocol="responses", model="test", api_key_env="TEST_KEY", base_url=url)


def test_no_config_is_safe_and_unknown_config_fails(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ZHIXING_CONFIG", raising=False)
    monkeypatch.delenv("ZHIXING_API_TOKEN", raising=False)
    monkeypatch.delenv("ZHIXING_DATA_DIR", raising=False)
    assert load_settings().models == {}
    config = Path("bad.toml")
    config.write_text('plain_api_key="do-not-accept"')
    monkeypatch.setenv("ZHIXING_CONFIG", str(config))
    with pytest.raises(ValueError, match="Unknown configuration fields"):
        load_settings()


@pytest.mark.parametrize("workspace", [".", "data"])
def test_workspace_cannot_expose_service_state(tmp_path, workspace):
    with pytest.raises(ValueError, match="must not contain"):
        Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / workspace)
