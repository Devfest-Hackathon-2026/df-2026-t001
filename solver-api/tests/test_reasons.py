import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.ai.llm import AIError, FakeLLM
from care.ai.privacy import Masker
from care.ai.service import AIService
from care.service import Svc
from care.store import MemoryRepo

URL = "/api/v1/candidate-reasons"
VAC = {"date": "2026-11-20", "shift": "夜勤", "unit_label": "ユニットA", "need_skills_labels": ["医療的ケア"]}
F1 = ["当日の勤務なし（空き）", "医療的ケアのスキルを保有", "今週の勤務は2日（余裕あり）"]
F2 = ["過去に夜勤希望あり", "ユニットAの経験あり"]
BODY = {"vacancy": VAC, "candidates": [{"ref": "c1", "facts": F1, "prob": 0.72}, {"ref": "c2", "facts": F2}]}
T1 = {"ref": "c1", "reason": "、".join(F1), "source": "template"}
T2 = {"ref": "c2", "reason": "、".join(F2), "source": "template"}
G1 = "当日は空いていて、医療的ケアのスキルがあり、今週の勤務は2日と余裕があります。"
G2 = "過去に夜勤の希望があり、ユニットAの経験もあります。"


def make(synth, structured, **env):
    guard.reset()
    svc = Svc(MemoryRepo.from_synth(synth))
    server.set_service(svc)
    llm = FakeLLM(structured=structured)
    a = AIService(svc, llm, Masker(mode="off"))
    for k, v in env.items():
        setattr(a, k, v)
    server.set_ai(a)
    return TestClient(server.app), llm


def out(*pairs):
    return {"items": [{"ref": r, "reason": t} for r, t in pairs]}


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    server.set_service(None)


def test_valid_gemini_reasons(synth):
    c, _ = make(synth, [out(("c1", G1), ("c2", G2))])
    r = c.post(URL, json=BODY)
    assert r.status_code == 200
    assert r.json() == {"items": [{"ref": "c1", "reason": G1, "source": "gemini"}, {"ref": "c2", "reason": G2, "source": "gemini"}]}


def test_probability_percent_is_allowed(synth):
    t = "空いていて、応諾の見込みは72%です。"
    c, _ = make(synth, [out(("c1", t), ("c2", G2))])
    assert c.post(URL, json=BODY).json()["items"][0] == {"ref": "c1", "reason": t, "source": "gemini"}


@pytest.mark.parametrize("bad", [
    "当日は空いていて、今週の勤務は5日です。",             # 事実にない数字
    "当日は空いていて、応諾の見込みは99%です。",           # prob と違う数字
    "山田さんは当日が空いています。",                      # 敬称つきの名前
    "当日は空いていて、サトウが入れます。",                # 事実にないカタカナの名前
    "当日は空いています。医療的ケアもできます。",          # 2文
    "当日は空いていて、医療的ケアのスキルがあり、今週の勤務は2日と余裕があり、とても頼りになります。",  # 長すぎ
    "当日は空いています😊",                                # 絵文字
    "",
])
def test_invented_content_falls_back_for_that_candidate_only(synth, bad):
    c, _ = make(synth, [out(("c1", bad), ("c2", G2))])
    items = c.post(URL, json=BODY).json()["items"]
    assert items[0] == T1
    assert items[1] == {"ref": "c2", "reason": G2, "source": "gemini"}


def test_missing_and_unknown_ref_fall_back(synth):
    c, _ = make(synth, [out(("c9", G1), ("c2", G2))])
    assert c.post(URL, json=BODY).json()["items"] == [T1, {"ref": "c2", "reason": G2, "source": "gemini"}]


@pytest.mark.parametrize("err", [AIError("boom"), RuntimeError("boom")])
def test_exception_all_template(synth, err):
    c, _ = make(synth, [err])
    r = c.post(URL, json=BODY)
    assert r.status_code == 200 and r.json() == {"items": [T1, T2]}


def test_usage_cap_all_template_with_200(synth):
    c, _ = make(synth, [out(("c1", G1), ("c2", G2)), out(("c1", G1), ("c2", G2))], intent_ip_limit=1)
    assert c.post(URL, json=BODY).json()["items"][0]["source"] == "gemini"
    r = c.post(URL, json=BODY)
    assert r.status_code == 200 and r.json() == {"items": [T1, T2]}


def test_ai_disabled_all_template(synth, monkeypatch):
    c, _ = make(synth, [out(("c1", G1), ("c2", G2))])
    monkeypatch.setenv("AI_ENABLED", "0")
    assert c.post(URL, json=BODY).json() == {"items": [T1, T2]}


def test_more_than_six_candidates_is_422(synth):
    c, _ = make(synth, [])
    cands = [{"ref": f"c{i}", "facts": ["空き"]} for i in range(1, 7)] + [{"ref": "c7", "facts": ["空き"]}]
    assert c.post(URL, json={"vacancy": VAC, "candidates": cands}).status_code == 422
    assert c.post(URL, json={"vacancy": VAC, "candidates": cands[:6]}).status_code == 200


def test_bad_input_is_422(synth):
    c, _ = make(synth, [])
    long_fact = {"ref": "c1", "facts": ["あ" * 31]}
    assert c.post(URL, json={"vacancy": VAC, "candidates": [long_fact]}).status_code == 422
    assert c.post(URL, json={"vacancy": VAC, "candidates": [{"ref": "c1", "facts": ["空き"] * 7}]}).status_code == 422
    assert c.post(URL, json={"vacancy": VAC, "candidates": [{"ref": "x", "facts": ["空き"]}]}).status_code == 422
    assert c.post(URL, json={"vacancy": VAC, "candidates": [{"ref": "c1", "facts": ["空き"]}, {"ref": "c1", "facts": ["空き"]}]}).status_code == 422
    assert c.post(URL, json={"vacancy": {**VAC, "date": "2026-13-40"}, "candidates": [{"ref": "c1", "facts": ["空き"]}]}).status_code == 422


def test_prompt_has_only_facts_and_no_ids_or_names(synth):
    c, llm = make(synth, [out(("c1", G1), ("c2", G2))])
    c.post(URL, json=BODY)
    p = llm.calls[0]["prompt"]
    assert "c1" in p and "医療的ケア" in p and "72%" in p
    names = [s.name for s in server.ai().svc.repo.staff()] if hasattr(server.ai().svc.repo, "staff") else []
    assert not any(n and n in p for n in names)
    assert "staff_id" not in p and "HDM-" not in p
    assert llm.calls[0]["kind"] == "structured"
