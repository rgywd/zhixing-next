from fastapi.testclient import TestClient

from zhixing_next.api import create_app
from zhixing_next.config import Settings


def test_business_schema_requires_auth_and_describes_real_data_routes(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", api_token="test-token")
    client = TestClient(create_app(settings))
    assert client.get("/v1/business/schema").status_code == 401
    response = client.get("/v1/business/schema", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    schema = response.json()
    assert "/v1/finance/summary" in schema["paths"]
    assert "/v1/health/summary" in schema["paths"]
    assert "/v1/memories" in schema["paths"]
    assert all(path.split("/")[2] in {"finance", "health", "life", "memories", "resources"} for path in schema["paths"])
    assert "test-token" not in response.text
