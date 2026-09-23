"""Login, roles, action log and admin endpoints (no network: integration checks without URLs)."""
import os

os.environ.setdefault("DATA_DIR", "data/sample")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def _login(c, u, p):
    r = c.post("/api/auth/login", json={"username": u, "password": p})
    return r


def test_login_roles_and_action_log():
    with TestClient(app) as c:
        assert c.get("/api/health").status_code == 200  # public
        assert c.post("/api/replenish/run", json={}).status_code == 401  # no token
        assert _login(c, "manager", "wrong").status_code == 401
        r = _login(c, "manager", "demo")
        assert r.status_code == 200 and r.json()["user"]["role"] == "manager"
        h = {"Authorization": f"Bearer {r.json()['token']}"}
        run = c.post("/api/replenish/run", json={"warehouse": "Главный"}, headers=h)
        assert run.status_code == 200 and run.json()["summary"]["positions"] > 0
        assert c.get("/api/admin/audit", headers=h).status_code == 403  # manager is not admin
        tok = r.json()["token"]
        assert c.get(f"/api/export?format=csv&token={tok}").status_code == 200  # download link with token
        ra = _login(c, "admin", "admin")
        ha = {"Authorization": f"Bearer {ra.json()['token']}"}
        log = c.get("/api/admin/audit", headers=ha).json()["items"]
        actions = {i["action"] for i in log}
        assert {"login", "login_failed", "run", "export"} <= actions
        run_rec = next(i for i in log if i["action"] == "run")
        assert run_rec["user"] == "manager" and run_rec["details"]["positions"] > 0
        integ = c.get("/api/admin/integrations", headers=ha).json()
        assert "onec" in integ and "bitrix24" in integ and integ["users"]
        saved = c.put("/api/admin/integrations/onec", json={"enabled": True, "base_url": "", "password": "secret"}, headers=ha).json()
        assert saved["password"] != "secret"  # masked
        t = c.post("/api/admin/integrations/onec/test", headers=ha).json()
        assert t["ok"] is False and "OData" in t["message"]
        assert c.get("/api/admin/audit.csv", headers=ha).status_code == 200
