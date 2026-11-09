import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.ai.llm import AIError, FakeLLM
from care.ai.privacy import Masker
from care.ai.service import AIService
from care.service import Svc
from care.store import MemoryRepo

URL = "/api/v1/employee-compose"
BODY = {"kind": "休み", "date": "2026-11-20", "shift": "夜勤", "reason": "体調不良"}
TEMPLATE = {"text": "11/20の夜勤を休ませてください。理由は体調不良です。", "source": "template"}
GOOD = "11/20の夜勤をお休みさせていただきたく、体調不良のためご相談です。"


def make(synth, texts, **env):
    guard.reset()
    svc = Svc(MemoryRepo.from_synth(synth))
    server.set_service(svc)
    a = AIService(svc, FakeLLM(texts=texts), Masker(mode="off"))
    for k, v in env.items():
        setattr(a, k, v)
    server.set_ai(a)
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    server.set_service(None)


def test_valid_gemini_sentence_is_accepted(synth):
    r = make(synth, [GOOD]).post(URL, json=BODY)
    assert r.status_code == 200 and r.json() == {"text": GOOD, "source": "gemini"}


@pytest.mark.parametrize("bad", [
    "11/21の夜勤をお休みさせてください。体調不良のためです。",                          # 日付違い
    "11/20の夜勤を休みます。体調不良で38度の熱があります。",                            # 余計な数字
    "11/20の夜勤をお休みさせてください。体調不良のためです。" + "よろしくお願いします。" * 8,   # 長すぎ
    "11/20の日勤をお休みさせてください。体調不良のためです。",                          # 勤務帯違い
    "11/20の夜勤をお休みさせてください。私用のためです。",                              # 理由違い
    "11/20の夜勤をお休みさせてください。体調不良のためです😢",                          # 絵文字
])
def test_invalid_output_falls_back_to_template(synth, bad):
    r = make(synth, [bad]).post(URL, json=BODY)
    assert r.status_code == 200 and r.json() == TEMPLATE


def test_gemini_exception_falls_back(synth):
    assert make(synth, [AIError("boom")]).post(URL, json=BODY).json() == TEMPLATE
    assert make(synth, [RuntimeError("boom")]).post(URL, json=BODY).json() == TEMPLATE


def test_usage_cap_falls_back_with_200(synth):
    c = make(synth, [GOOD, GOOD], intent_ip_limit=1)
    assert c.post(URL, json=BODY).json()["source"] == "gemini"
    r = c.post(URL, json=BODY)
    assert r.status_code == 200 and r.json() == TEMPLATE


def test_ai_disabled_falls_back(synth, monkeypatch):
    c = make(synth, [GOOD])
    monkeypatch.setenv("AI_ENABLED", "0")
    assert c.post(URL, json=BODY).json() == TEMPLATE


def test_child_fever_and_synonym(synth):
    ok = "11/20の夜勤をお休みさせてください。子どもが熱を出したためです。"
    c = make(synth, [ok])
    r = c.post(URL, json={**BODY, "reason": "子どもの発熱"})
    assert r.json() == {"text": ok, "source": "gemini"}


def test_detail_digits_allowed_only_from_input(synth):
    body = {**BODY, "kind": "遅刻", "detail": "30分遅れ"}
    ok = "11/20の夜勤、30分遅れます。体調不良のためです。"
    assert make(synth, [ok]).post(URL, json=body).json()["source"] == "gemini"
    assert make(synth, ["11/20の夜勤、45分遅れます。体調不良のためです。"]).post(URL, json=body).json()["source"] == "template"


def test_bad_input_is_422(synth):
    c = make(synth, [GOOD])
    assert c.post(URL, json={**BODY, "reason": "自由な理由"}).status_code == 422
    assert c.post(URL, json={**BODY, "kind": "欠勤"}).status_code == 422
    assert c.post(URL, json={**BODY, "detail": "あ" * 41}).status_code == 422
    assert c.post(URL, json={**BODY, "date": "2026-13-40"}).status_code == 422
