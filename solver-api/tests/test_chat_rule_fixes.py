"""2026-11-24：チャットで足したルールを本物の Gemini で試して見つかった不具合のテスト。

- 「全員」の回数の差（Balance）に、その勤務に入れない人（いつも0回）が混ざって、守れない・作れない
- 「夜勤の後は二日休み」が、明けで最初から守られる「夜勤→勤務」の2日の並びになる
- ラベル「全員は…」が不自然
- translate-inline のモデル
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.ai.llm import RULE_MODEL, FakeLLM
from care.ai.privacy import Masker
from care.ai.service import AIService
from care.ai.translate import RuleDraft, validate
from care.dsl import Balance, DaySel, Facility, Month, PeopleSel, ShiftSel, StaffMember, Succession
from care.inline_solve import InlineSolveIn, solve_inline
from care.rule_label import rule_label
from care.service import Svc
from care.store import MemoryRepo
from care.verify import verify_monthly

URL = "/api/v1/rules/translate-inline"
ALL = ["早番", "日勤", "遅番", "夜勤"]
DAY = ["早番", "日勤", "遅番"]


def _staff(n_night: int = 6, n_day: int = 3) -> list[dict]:
    return [
        {"staff_id": f"S{i:02d}", "role": "介護職員", "employment": "常勤", "skills": ["medical"],
         "shifts": ALL if i <= n_night else DAY}
        for i in range(1, n_night + n_day + 1)
    ]


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    server.set_service(None)
    guard.reset()


# ---------------------------------------------------------------- Balance の対象


def test_balance_members_skip_people_who_cannot_work_the_shift():
    staff = [StaffMember(staff_id=s["staff_id"], name=s["staff_id"], role=s["role"], employment=s["employment"],
                         skills=s["skills"], shifts=s["shifts"]) for s in _staff()]
    night = Balance(id="b1", label="x", shifts=ShiftSel(ids=["夜勤"]), max_spread=1)
    assert [s.staff_id for s in night.members(staff)] == [f"S{i:02d}" for i in range(1, 7)]
    # 休み・公休・すべての勤務の差は全員のまま
    for sel in (ShiftSel(ids=["公休"]), ShiftSel(ids=["休"]), ShiftSel()):
        assert len(Balance(id="b2", label="x", shifts=sel, max_spread=1).members(staff)) == 9


def test_everyone_night_balance_is_solvable_when_day_only_staff_exist():
    """夜勤に入れない人（いつも0回）を混ぜると「差1以内」は「全員1回以下」になり、絶対では作れなかった。"""
    req = {
        "month": "2026-11",
        "staff": _staff(),
        "need_per_shift": {"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        "time_limit": 8.0,
        "rules": [{"type": "balance", "strength": "絶対", "people": {}, "shifts": {"ids": ["夜勤"]}, "max_spread": 1}],
    }
    out = solve_inline(InlineSolveIn.model_validate(req), workers=1)
    assert out["status"] in ("OPTIMAL", "FEASIBLE"), out["explanation"]
    nights = sorted(sum(1 for v in row if v == "夜勤") for sid, row in out["cells"].items() if int(sid[1:]) <= 6)
    assert nights[-1] - nights[0] <= 1
    # 検査（impact の数）も同じ対象で数える：今の表では破りなし
    fac = Facility(facility_id="f", name="f", staff=[
        StaffMember(staff_id=s["staff_id"], name=s["staff_id"], role=s["role"], employment=s["employment"],
                    skills=s["skills"], shifts=s["shifts"]) for s in _staff()])
    rule = Balance(id="r", label="x", strength="絶対", shifts=ShiftSel(ids=["夜勤"]), max_spread=1)
    assert sum(verify_monthly(fac, Month(month="2026-11", days=30, first_weekday=0), out["cells"], [rule]).values()) == 0


# ---------------------------------------------------------------- ラベル


def test_labels_for_everyone():
    bal = Balance(id="b", label="x", shifts=ShiftSel(ids=["夜勤"]), days=DaySel(weekdays=[0, 6]), max_spread=1)
    assert rule_label(bal, work_ids=ALL) == "夜勤に入れる人の日・土曜の夜勤の差は1回以内"
    off = Balance(id="b", label="x", shifts=ShiftSel(ids=["公休"]), max_spread=1)
    assert rule_label(off, work_ids=ALL).startswith("全員の")
    suc = Succession(id="s", label="x", pattern=[ShiftSel(ids=["夜勤"]), ShiftSel(ids=["休"]), ShiftSel()], forbid=True)
    assert rule_label(suc, work_ids=ALL) == "夜勤→休→勤務の並びにしない"
    who = Succession(id="s", label="x", people=PeopleSel(ids=["S01"]), max_run=4)
    assert rule_label(who, work_ids=ALL, staff_names={"S01": "山田"}) == "山田さんは連続勤務4日まで"
    assert rule_label(Succession(id="s", label="x", max_run=4), work_ids=ALL) == "連続勤務は4日まで"


# ---------------------------------------------------------------- 夜勤の後の休み


def _fac() -> Facility:
    return Facility(facility_id="f", name="f", staff=[
        StaffMember(staff_id=s["staff_id"], name=s["staff_id"], role=s["role"], employment=s["employment"],
                    skills=s["skills"], shifts=s["shifts"]) for s in _staff()])


@pytest.mark.parametrize("draft", [
    {"type": "succession", "pattern": [["夜勤"], []]},
    {"type": "succession", "pattern": [["夜勤"], ["早番", "日勤", "遅番", "夜勤"]]},
    {"type": "succession", "shift_ids": ["夜勤"], "after_shift_ids": ["早番", "日勤"]},
])
def test_night_then_work_is_rejected_because_ake_already_blocks_it(draft):
    errs = validate(RuleDraft.model_validate(draft), _fac(), inline=True)
    assert any("明け" in e for e in errs), errs


def test_night_rest_rest_pattern_is_accepted():
    d = RuleDraft.model_validate({"type": "succession", "pattern": [["夜勤"], ["休"], []]})
    assert validate(d, _fac(), inline=True) == []
    # 夜勤のあとに夜勤以外の並び（遅番→早番）は今までどおり通る
    d2 = RuleDraft.model_validate({"type": "succession", "shift_ids": ["遅番"], "after_shift_ids": ["早番"]})
    assert validate(d2, _fac(), inline=True) == []


def test_translate_inline_uses_rule_model_and_tells_llm_about_ake(synth):
    guard.reset()
    svc = Svc(MemoryRepo.from_synth(synth))
    server.set_service(svc)
    llm = FakeLLM(structured=[RuleDraft.model_validate({"type": "succession", "pattern": [["夜勤"], ["休"], []]})])
    server.set_ai(AIService(svc, llm, Masker(mode="off")))
    staff = [{**s, "staff_id": f"EMP-{i:03d}"} for i, s in enumerate(_staff(), start=1)]
    r = TestClient(server.app).post(URL, json={"text": "夜勤の後は二日休みにして", "month": "2026-11", "staff": staff})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["kind"] == "candidates"
    c0 = j["candidates"][0]
    assert len(c0["rule"]["pattern"]) == 3 and c0["label"] == "夜勤→休→勤務の並びにしない"
    assert llm.calls[0]["model"] == RULE_MODEL == "gemini-3.8-flash"
    assert "翌日が明けになる勤務: 夜勤" in llm.calls[0]["prompt"]
