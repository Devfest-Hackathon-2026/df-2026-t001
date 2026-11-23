"""Q6: translate.py の拡張（balance / occurrence / pair / staffing / setting / unsupported）と POST /api/v1/rules/translate-inline。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from bench.check import check
from care import guard, server
from care.ai.llm import AIError, FakeLLM
from care.ai.privacy import Masker
from care.ai.service import AIService
from care.ai.translate import RuleDraft, mentioned_staff, validate
from care.dsl import Facility, StaffMember
from care.inline_solve import InlineSolveIn, solve_inline
from care.service import Svc
from care.store import MemoryRepo

URL = "/api/v1/rules/translate-inline"
FAC_TRANSLATE_URL = "/api/v1/facilities/fac-hidamari/rules/translate"
SENTENCES_PATH = Path(__file__).parent / "fixtures" / "rule_sentences.yaml"
SENTENCES = yaml.safe_load(SENTENCES_PATH.read_text())

INTERNAL_TOKENS = ("CP-SAT", "hard", "Staffing", "Request", "Succession", "Count", "Balance", "Occurrence", "target", "baseline")


def _default_staff(shift_types: list[dict] | None = None) -> list[dict]:
    shifts = [st["id"] for st in shift_types] if shift_types else ["早番", "日勤", "遅番", "夜勤"]
    roles = ["主任", "介護福祉士", "介護職員", "新人", "看護師", "介護職員", "新人", "介護福祉士"]
    return [
        {
            "staff_id": f"EMP-{i:03d}",
            "role": roles[i - 1],
            "employment": "常勤" if i <= 7 else "パート",
            "skills": ["medical"] if i <= 3 else [],
            "shifts": list(shifts),
        }
        for i in range(1, 9)
    ]


def _make(synth, llm, **env):
    guard.reset()
    svc = Svc(MemoryRepo.from_synth(synth))
    server.set_service(svc)
    a = AIService(svc, llm, Masker(mode="off"))
    for k, v in env.items():
        setattr(a, k, v)
    server.set_ai(a)
    return TestClient(server.app), svc, a


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    server.set_service(None)
    guard.reset()


# ---------------------------------------------------------------- 評価用文集（36文・FakeLLM）


def test_rule_sentences_fixture_covers_required_categories():
    assert len(SENTENCES) >= 30
    types = {s["draft"]["type"] for s in SENTENCES}
    assert types >= {"request", "succession", "count", "balance", "occurrence", "pair", "staffing", "setting", "unsupported"}
    assert sum(1 for s in SENTENCES if s.get("holdout")) >= 10


@pytest.mark.parametrize("case", SENTENCES, ids=[s["id"] for s in SENTENCES])
def test_translate_inline_all_sentences_with_fakellm(synth, case):
    draft = RuleDraft.model_validate(case["draft"])
    # 数が抜けた下書きは1回だけやり直す（同じ答えを2回用意する。数がそろった下書きは1回しか呼ばない）
    llm = FakeLLM(structured=[draft, draft])
    client, svc, _ = _make(synth, llm)
    shift_types = case.get("shift_types") or []
    staff = _default_staff(shift_types or None)

    body = {
        "text": case["utterance"],
        "month": "2026-11",
        "staff": staff,
        **({"shift_types": shift_types} if shift_types else {}),
        **({"staff_id": case["staff_id"]} if case.get("staff_id") else {}),
        **({"day": case["day"]} if case.get("day") else {}),
    }
    resp = client.post(URL, json=body)
    assert resp.status_code == 200, f"{case['id']}: {resp.text}"
    j = resp.json()
    exp = case["expect"]
    assert j["kind"] == exp["kind"]

    if exp["kind"] == "candidates":
        assert j["candidates"], f"{case['id']}: 候補が空"
        c0 = j["candidates"][0]
        assert c0["rule"]["type"] == exp["rule_type"]
        if "strength" in exp:
            assert c0["strength"] == exp["strength"]
        if "scopes_include" in exp:
            got_scopes = {c["scope"] for c in j["candidates"]}
            assert set(exp["scopes_include"]) <= got_scopes
        if "pattern_len" in exp:
            assert len(c0["rule"]["pattern"]) == exp["pattern_len"]
        if "max_run" in exp:
            assert c0["rule"]["max_run"] == exp["max_run"]
        if "at_least" in exp:
            assert c0["rule"]["at_least"] == exp["at_least"]
        if "at_most" in exp:
            assert c0["rule"]["at_most"] == exp["at_most"]
        if "target" in exp:
            assert c0["rule"]["target"] == exp["target"]
        if "max_spread" in exp:
            assert c0["rule"]["max_spread"] == exp["max_spread"]
        if "weekdays" in exp:
            assert sorted(c0["rule"]["days"]["weekdays"]) == sorted(exp["weekdays"])
        if "start_weekdays" in exp:
            assert sorted(c0["rule"]["starts"]["weekdays"]) == sorted(exp["start_weekdays"])
        if "dates" in exp:
            day_obj = c0["rule"].get("starts") or c0["rule"].get("days")
            assert sorted(day_obj["dates"]) == sorted(exp["dates"])

        # 全候補が InlineSolveIn の口を通り、ラベルに内部語を含まないこと
        for c in j["candidates"]:
            lbl = c["label"]
            assert lbl and not any(tok in lbl for tok in INTERNAL_TOKENS), f"内部語露出: {lbl}"
            InlineSolveIn.model_validate({
                "month": "2026-11",
                "staff": staff,
                **({"shift_types": shift_types} if shift_types else {}),
                "rules": [c["rule"]],
            })

    elif exp["kind"] == "setting":
        assert j["candidates"] == []
        assert j["setting_field"] == exp["setting_field"]
        assert j["message"].startswith("設定の") and "で入ります" in j["message"]
        assert not any(tok in j["message"] for tok in INTERNAL_TOKENS)

    elif exp["kind"] == "ask":
        assert j["candidates"] == []
        assert j["message"] and not any(tok in j["message"] for tok in INTERNAL_TOKENS)
        assert len(llm.calls) == 2, "数が抜けたら1回だけやり直す"

    else:
        assert j["candidates"] == []
        assert j["unsupported_kind"] == exp["unsupported_kind"]
        assert j["message"] == "今のルールの形では書けません。"


# ---------------------------------------------------------------- impact（今の表での破れ数）と求解連携


def test_translate_inline_computes_impact_for_occurrence_balance_pair(synth):
    staff = _default_staff()
    cells = {s["staff_id"]: ["日勤"] * 30 for s in staff}
    # 2026-11: 土曜=7, 14, 21, 28 / 日曜=1, 8, 15, 22, 29
    # EMP-001 は 14-15 土日休み。ただし 13(金)に夜勤を入れると 14(土)は明けになり土日公休は0回
    cells["EMP-001"][12] = "夜勤"
    cells["EMP-001"][13] = ""
    cells["EMP-001"][14] = ""
    # EMP-002..EMP-008 は誰も土日休みなし（7人も0回 → 全員で8人破り）
    # EMP-002 は 1,7,8,21,22 が休み（土日公休5回）、他は0回 → balance(max_spread=1) で破り1件

    # 1) Occurrence: EMP-001 のみ=1件、全員=8件
    d_occ = RuleDraft(type="occurrence", pattern=[["公休"], ["公休"]], start_weekdays=[6], at_least=1)
    client, _, _ = _make(synth, FakeLLM(structured=[d_occ]))
    r_occ = client.post(URL, json={
        "text": "月1回は土日とも休みにして",
        "month": "2026-11",
        "staff": staff,
        "staff_id": "EMP-001",
        "current": cells,
    })
    assert r_occ.status_code == 200
    cands = r_occ.json()["candidates"]
    assert [c["scope"] for c in cands] == ["person", "everyone"]
    assert cands[0]["impact"]["broken_now"] == 1
    assert cands[1]["impact"]["broken_now"] == 8

    # 2) Balance: EMP-002 は土日5回休、他は0回 → spread 5 (>1)
    cells["EMP-002"][0] = ""
    cells["EMP-002"][6] = ""
    cells["EMP-002"][7] = ""
    cells["EMP-002"][20] = ""
    cells["EMP-002"][21] = ""
    d_bal = RuleDraft(type="balance", shift_ids=["公休"], max_spread=1, weekdays=[0, 6])
    c_bal, _, _ = _make(synth, FakeLLM(structured=[d_bal]))
    r_bal = c_bal.post(URL, json={
        "text": "土日の公休差を1以内にして",
        "month": "2026-11",
        "staff": staff,
        "current": cells,
    })
    assert r_bal.status_code == 200
    assert r_bal.json()["candidates"][0]["impact"]["broken_now"] == 1

    # 3) Pair: 5日と6日に EMP-001 と EMP-002 を同じ夜勤に置く → broken_now == 2
    cells["EMP-001"][4] = "夜勤"
    cells["EMP-002"][4] = "夜勤"
    cells["EMP-001"][5] = "夜勤"
    cells["EMP-002"][5] = "夜勤"
    d_pair = RuleDraft(type="pair", shift_ids=["夜勤"])
    c_pair, _, _ = _make(synth, FakeLLM(structured=[d_pair]))
    r_pair = c_pair.post(URL, json={
        "text": "EMP-001さんとEMP-002さんは同じ日の夜勤に入れないで",
        "month": "2026-11",
        "staff": staff,
        "current": cells,
    })
    assert r_pair.status_code == 200
    assert r_pair.json()["candidates"][0]["impact"]["broken_now"] == 2


def test_translate_inline_roundtrip_into_solve_inline(synth):
    staff = _default_staff()
    drafts = [
        RuleDraft(type="occurrence", pattern=[["公休"], ["公休"]], start_weekdays=[6], at_least=1, strength_hint="絶対"),
        RuleDraft(type="balance", shift_ids=["公休"], max_spread=1, weekdays=[0, 6], strength_hint="絶対"),
        RuleDraft(type="pair", shift_ids=["夜勤"], strength_hint="絶対"),
        RuleDraft(type="staffing", shift_ids=["日勤"], roles=["主任"], at_least=1, strength_hint="絶対"),
    ]
    client, _, _ = _make(synth, FakeLLM(structured=drafts))
    texts = [
        "月1回は土日とも休みにして",
        "土日の公休回数の差を1以内にして",
        "EMP-001さんとEMP-002さんは同じ夜勤に入れないで",
        "日勤に主任を毎日1人以上入れて",
    ]
    chosen_rules = []
    for txt in texts:
        r = client.post(URL, json={"text": txt, "month": "2026-11", "staff": staff})
        assert r.status_code == 200
        # everyone / pair の候補を選ぶ
        chosen_rules.append(r.json()["candidates"][-1]["rule"])

    solve_req = {
        "month": "2026-11",
        "staff": staff,
        "need_per_shift": {"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        "rules": chosen_rules,
        "time_limit": 10.0,
    }
    res = solve_inline(InlineSolveIn.model_validate(solve_req), workers=2)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    chk = check(solve_req, res)
    assert chk["rules_hard_broken"] == 0
    assert chk["hard"] == {}


# ---------------------------------------------------------------- プライバシー・ログ・境界・エラー


def test_translate_inline_rejects_names_fails_closed_dlp_and_logs_only_kind(synth, monkeypatch):
    llm = FakeLLM(structured=[RuleDraft(type="unsupported", unsupported_kind="pair_same")])
    client, svc, a = _make(synth, llm)
    staff = _default_staff()

    # 1) 氏名を受け取らない（name を送ると 422）
    bad_staff = [{**staff[0], "name": "田中花子"}, *staff[1:]]
    r_name = client.post(URL, json={"text": "休みを増やして", "month": "2026-11", "staff": bad_staff})
    assert r_name.status_code == 422
    assert llm.calls == []

    # 2) DLP 失敗時は AI を呼ばず 503
    a.masker = Masker(mode="required")
    monkeypatch.setattr(Masker, "mask", lambda self, t: (_ for _ in ()).throw(AIError("dlp down")))
    r_dlp = client.post(URL, json={"text": "月1回は土日とも休み", "month": "2026-11", "staff": staff})
    assert r_dlp.status_code == 503
    assert llm.calls == []

    # 3) unsupported 時、イベントログに文面が残らず種類だけ残る
    monkeypatch.undo()
    a.masker = Masker(mode="off")
    secret_phrase = "田中さんと佐藤さんを同じ勤務に入れてください特記事項"
    r_unsup = client.post(URL, json={"text": secret_phrase, "month": "2026-11", "staff": staff})
    assert r_unsup.status_code == 200
    assert r_unsup.json()["kind"] == "unsupported"
    events = svc.events.local
    dumped = json.dumps(events, ensure_ascii=False)
    assert secret_phrase not in dumped
    assert any(
        e.get("event_type") == "rule_unsupported" and json.loads(e.get("payload", "{}")).get("kind") == "pair_same"
        for e in events
    )


def test_mentioned_staff_handles_short_and_hyphen_ids_without_prefix_collision():
    fac = Facility(
        facility_id="t",
        name="t",
        staff=[
            StaffMember(staff_id=sid, name=sid, role="介護職員", employment="常勤", shifts=["日勤"])
            for sid in ("P1", "P10", "EMP-001", "A01")
        ],
    )
    assert mentioned_staff("P10さんは休み、P1さんは夜勤。あとA01とEMP-001", fac) == ["P10", "P1", "A01", "EMP-001"]
    assert mentioned_staff("P10は休み", fac) == ["P10"]  # P1 を誤検出しない


def test_translate_inline_validation_and_error_codes(synth, monkeypatch):
    staff = _default_staff()
    bad_drafts = [
        RuleDraft(type="request", shift_ids=["公休"], want=True),
        RuleDraft(type="succession", pattern=[["公休"], ["早番"]]),
        RuleDraft(type="succession", pattern=[["早番"]]),
        # 数だけが抜けた下書き（差の無い balance・回数の無い occurrence）は 422 ではなく聞き返し（test_missing_number_twice_asks_back）
        RuleDraft(type="occurrence", pattern=[["休"]], at_least=1),
        RuleDraft(type="pair", shift_ids=["夜勤"]),  # 対象が2人未満
        RuleDraft(type="pair", shift_ids=["公休"]),
        RuleDraft(type="staffing", shift_ids=["公休"], at_least=1),
        RuleDraft(type="count", shift_ids=["公休"], target=4, strength_hint="絶対"),
        RuleDraft(type="setting", setting_field=None),
    ]
    monkeypatch.setattr(guard, "AI_LIMIT", 50)
    client, _, _ = _make(synth, FakeLLM(structured=bad_drafts))
    for _ in bad_drafts:
        r = client.post(URL, json={"text": "条件追加", "month": "2026-11", "staff": staff})
        assert r.status_code == 422

    # 境界エラー: 未知の staff_id (404)、存在しない日 (400)、taskRequest は inline で unsupported
    c2, _, _ = _make(synth, FakeLLM(structured=[RuleDraft(type="taskRequest", task="bath", want=False)]))
    assert c2.post(URL, json={"text": "x", "month": "2026-11", "staff": staff, "staff_id": "NONE"}).status_code == 404
    assert c2.post(URL, json={"text": "x", "month": "2026-11", "staff": staff, "day": 31}).status_code == 400
    r_tr = c2.post(URL, json={"text": "午後の入浴介助は外して", "month": "2026-11", "staff": staff})
    assert r_tr.status_code == 200 and r_tr.json()["kind"] == "unsupported"
    assert r_tr.json()["unsupported_kind"] == "intra_shift"

    # AI レート上限が /api/v1/rules/translate-inline でも効くこと
    monkeypatch.setattr(guard, "AI_LIMIT", 1)
    c_lim, _, _ = _make(synth, FakeLLM(structured=[RuleDraft(type="unsupported", unsupported_kind="other")] * 2))
    assert c_lim.post(URL, json={"text": "a", "month": "2026-11", "staff": staff}).status_code == 200
    assert c_lim.post(URL, json={"text": "b", "month": "2026-11", "staff": staff}).status_code == 429


def test_facility_translate_also_supports_new_types_without_breaking_legacy(synth):
    # 既存の POST /api/v1/facilities/{fid}/rules/translate でも occurrence / balance / pair / unsupported が動く
    occ = RuleDraft(type="occurrence", pattern=[["公休"], ["公休"]], start_weekdays=[6], at_least=1)
    client, _, _ = _make(synth, FakeLLM(structured=[occ]))
    r = client.post(FAC_TRANSLATE_URL, json={"text": "月1回は土日とも休み", "month": "2026-11"})
    assert r.status_code == 200
    j = r.json()
    assert j["kind"] == "candidates"
    assert j["candidates"][0]["rule"]["type"] == "occurrence"
    assert client.post(f"/api/v1/facilities/fac-hidamari/rules", json=j["candidates"][0]["rule"]).status_code == 201


# ---------------------------------------------------------------- 数が抜けた下書き：1回だけやり直し、それでも抜けたら聞き返す


def test_missing_number_is_retried_once_with_note(synth):
    first = RuleDraft(type="staffing", shift_ids=["夜勤"], roles=["新人"])
    second = RuleDraft(type="staffing", shift_ids=["夜勤"], roles=["新人"], at_most=1)
    llm = FakeLLM(structured=[first, second])
    client, *_ = _make(synth, llm)
    j = client.post(URL, json={"text": "夜勤に新人は各日1人までにして", "month": "2026-11", "staff": _default_staff()}).json()
    assert j["kind"] == "candidates" and j["candidates"][0]["rule"]["at_most"] == 1
    assert len(llm.calls) == 2
    assert "抜けて" in llm.calls[1]["prompt"] and "抜けて" not in llm.calls[0]["prompt"]


@pytest.mark.parametrize("draft,word", [
    (RuleDraft(type="staffing", shift_ids=["夜勤"], skills=["medical"]), "何人"),
    (RuleDraft(type="count", shift_ids=["夜勤"]), "何回"),
    (RuleDraft(type="occurrence", pattern=[["休"], ["休"]]), "何回"),
    (RuleDraft(type="balance", shift_ids=["公休"]), "差"),
])
def test_missing_number_twice_asks_back(synth, draft, word):
    llm = FakeLLM(structured=[draft, draft])
    client, *_ = _make(synth, llm)
    r = client.post(URL, json={"text": "夜勤に医療的ケアの人を入れて", "month": "2026-11", "staff": _default_staff()})
    assert r.status_code == 200
    j = r.json()
    assert j["kind"] == "ask" and j["candidates"] == [] and word in j["message"]
    assert len(llm.calls) == 2


def test_other_validation_errors_are_not_retried(synth):
    llm = FakeLLM(structured=[RuleDraft(type="staffing", shift_ids=["存在しない勤務"], at_least=1)])
    client, *_ = _make(synth, llm)
    r = client.post(URL, json={"text": "夜勤に2人", "month": "2026-11", "staff": _default_staff()})
    assert r.status_code == 422 and len(llm.calls) == 1
