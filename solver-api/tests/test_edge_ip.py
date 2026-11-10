from care import guard


def test_client_ip_default_uses_last_hop(monkeypatch):
    monkeypatch.delenv("EDGE_PROXY_IPS", raising=False)
    assert guard.client_ip({"x-forwarded-for": "1.1.1.1, 2.2.2.2"}, None) == "2.2.2.2"


def test_client_ip_strips_trusted_lb(monkeypatch):
    monkeypatch.setenv("EDGE_PROXY_IPS", "136.81.247.37")
    assert guard.client_ip({"x-forwarded-for": "9.9.9.9, 2.2.2.2, 136.81.247.37"}, None) == "2.2.2.2"
    assert guard.client_ip({"x-forwarded-for": "136.81.247.37"}, None) == "136.81.247.37"
