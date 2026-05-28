"""Integration tests for the companion's HTTP endpoints."""
import requests


def test_status_returns_json(base_url, localhost_origin):
    r = requests.get(f"{base_url}/status", headers={"Origin": localhost_origin})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body
    assert "passthrough" in body["features"]


def test_apps_returns_array(base_url, localhost_origin):
    r = requests.get(f"{base_url}/apps", headers={"Origin": localhost_origin})
    assert r.status_code == 200
    body = r.json()
    apps = body.get("apps", body)
    assert isinstance(apps, list)


def test_outputs_returns_render_endpoints(base_url, localhost_origin):
    r = requests.get(f"{base_url}/outputs", headers={"Origin": localhost_origin})
    assert r.status_code == 200
    body = r.json()
    outputs = body.get("outputs", body)
    assert isinstance(outputs, list)


def test_unknown_path_404(base_url, localhost_origin):
    r = requests.get(f"{base_url}/nope", headers={"Origin": localhost_origin})
    assert r.status_code == 404


def test_cors_preflight_ok(base_url, localhost_origin):
    r = requests.options(
        f"{base_url}/status",
        headers={
            "Origin": localhost_origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 204
    assert r.headers.get("Access-Control-Allow-Origin") == localhost_origin


def test_disallowed_origin_rejected(base_url):
    r = requests.get(
        f"{base_url}/status", headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403
