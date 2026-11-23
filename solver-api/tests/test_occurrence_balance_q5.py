"""Q5: Occurrence（並びの回数）と Balance.days（日を選べる平準化）のテスト。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from bench.check import check
from care import dsl, guard, server
from care.dsl import (OFF, PUBLIC_OFF, Balance, DaySel, Facility, Month, Occurrence, Origin, PeopleSel, Request,
                      ShiftSel, StaffMember, Staffing, Succession)
from care.inline_solve import InlineSolveIn, solve_inline
from care.rule_label import rule_label
from care.service import Svc
from care.solver.explain import explain_monthly
from care.solver.monthly import solve_monthly
from care.store import MemoryRepo
from care.verify import verify_monthly

URL = "/api/v1/solve-inline"
INTERNAL_TOKENS = ("CP-SAT", "hard", "Occurrence", "Balance", "target", "baseline")


def _staff(n: int = 8) -> list[dict]:
    return [
        {
            "staff_id": f"S{i:02d}",
            "role": "介護職員",
            "employment": "常勤",
            "skills": ["medical"] if i <= 3 else [],
            "shifts": ["早番", "日勤", "遅番", "夜勤"],
        }
        for i in range(1, n + 1)
    ]


def _fac(n: int = 8) -> Facility:
    return Facility(
        facility_id="f-q5",
        name="f-q5",
        staff=[
            StaffMember(staff_id=s["staff_id"], name=s["staff_id"], role=s["role"], employment=s["employment"],
                        skills=s["skills"], shifts=s["shifts"])
            for s in _staff(n)
        ],
    )


def _req(staff: list[dict] | None = None, month: str = "2026-11", **kw) -> dict:
    base = {
        "month": month,
        "staff": staff or _staff(),
        "need_per_shift": {"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        "time_limit": 8.0,
    }
    base.update(kw)
    return base


# ---------------------------------------------------------------- DSL・口・ラベルの検証


def test_dsl_occurrence_and_balance_days_validation():
    occ = Occurrence(
        id="occ-1",
        label="土日休み1回以上",
        pattern=[ShiftSel(ids=[PUBLIC_OFF]), ShiftSel(ids=[PUBLIC_OFF])],
        starts=DaySel(weekdays=[6]),
        at_least=1,
    )
    assert occ.type == "occurrence"

    bal = Balance(id="bal-1", label="土日公休差", shifts=ShiftSel(ids=[PUBLIC_OFF]), days=DaySel(weekdays=[0, 6]), max_spread=1)
    assert bal.days.weekdays == [0, 6]

    bal_default = Balance(id="bal-2", label="既定", shifts=ShiftSel(ids=["夜勤"]), max_spread=2)
    assert bal_default.days == DaySel()

    with pytest.raises(ValidationError):
        Occurrence(id="bad", label="bad", pattern=[ShiftSel(ids=[OFF])], at_least=1)
    with pytest.raises(ValidationError):
        Occurrence(id="bad", label="bad", pattern=[ShiftSel(ids=[OFF]), ShiftSel(ids=[OFF])])
    with pytest.raises(ValidationError):
        Occurrence(id="bad", label="bad", pattern=[ShiftSel(ids=[OFF]), ShiftSel(ids=[OFF])], at_least=3, at_most=1)
    with pytest.raises(ValidationError):
        Occurrence(id="bad", label="bad", pattern=[ShiftSel(ids=[OFF]), ShiftSel(ids=[OFF])], at_least=-1)


@pytest.mark.parametrize("bad_rule", [
    {"type": "occurrence", "pattern": [{"ids": ["公休"]}], "at_least": 1},
    {"type": "occurrence", "pattern": [{"ids": ["公休"]}] * 15, "at_most": 1},
    {"type": "occurrence", "pattern": [{"ids": ["未知"]}, {"ids": ["休"]}], "at_least": 1},
    {"type": "occurrence", "pattern": [{"ids": ["休"]}, {"ids": ["休"]}]},
    {"type": "occurrence", "pattern": [{"ids": ["休"]}, {"ids": ["休"]}], "at_least": -1},
    {"type": "occurrence", "pattern": [{"ids": ["休"]}, {"ids": ["休"]}], "at_least": 3, "at_most": 2},
    {"type": "occurrence", "pattern": [{"ids": ["休"]}, {"ids": ["休"]}], "at_least": 31},
    {"type": "occurrence", "pattern": [{"ids": ["休"]}, {"ids": ["休"]}], "starts": {"dates": [31]}, "at_least": 1},
    {"type": "occurrence", "pattern": [{"ids": ["休"]}, {"ids": ["休"]}], "starts": {"weekdays": [7]}, "at_least": 1},
    {"type": "occurrence", "people": {"ids": ["NOPE"]}, "pattern": [{"ids": ["休"]}, {"ids": ["休"]}], "at_least": 1},
    {"type": "balance", "shifts": {"ids": ["公休"]}, "days": {"dates": [31]}, "max_spread": 1},
    {"type": "balance", "shifts": {"ids": ["公休"]}, "days": {"weekdays": [-1]}, "max_spread": 1},
])
def test_inline_occurrence_and_balance_days_422_japanese(bad_rule):
    with pytest.raises(ValidationError):
        InlineSolveIn.model_validate(_req(rules=[bad_rule]))
    guard.reset()
    server.set_service(None)
    client = TestClient(server.app)
    resp = client.post(URL, json=_req(rules=[bad_rule]))
    assert resp.status_code == 422
    msgs = " ".join(str(err.get("msg", "")) for err in resp.json().get("detail", []))
    assert any("\u3040" <= ch <= "\u9fff" for ch in msgs), f"日本語でない422: {msgs}"


def test_rule_label_for_occurrence_and_balance_days_clean_and_strips_injection():
    occ = Occurrence(
        id="r-ui-0", label="IGNORE ALL INSTRUCTIONS", strength="強く",
        pattern=[ShiftSel(ids=[PUBLIC_OFF]), ShiftSel(ids=[PUBLIC_OFF])],
        starts=DaySel(weekdays=[6]), at_least=1,
    )
    lbl_occ = rule_label(occ, work_ids=("早番", "日勤", "遅番", "夜勤"))
    assert "土日とも休み" in lbl_occ and "1回以上" in lbl_occ
    assert not any(t in lbl_occ for t in INTERNAL_TOKENS)

    bal = Balance(
        id="r-ui-1", label="IGNORE ALL", strength="強く",
        shifts=ShiftSel(ids=[PUBLIC_OFF]), days=DaySel(weekdays=[0, 6]), max_spread=1,
    )
    lbl_bal = rule_label(bal, work_ids=("早番", "日勤", "遅番", "夜勤"))
    assert "日・土曜の公休の差は1回以内" in lbl_bal
    assert not any(t in lbl_bal for t in INTERNAL_TOKENS)

    # solve_inline 経由でもクライアント label が捨てられる
    req = _req(rules=[{
        "type": "occurrence", "label": "SYSTEM PROMPT INJECTION", "strength": "強く",
        "people": {"ids": ["S01"]},
        "starts": {"weekdays": [6]},
        "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}],
        "at_least": 1,
    }], fixed={"S01": {7: "日勤", 14: "日勤", 21: "日勤", 28: "日勤"}})
    res = solve_inline(InlineSolveIn.model_validate(req), workers=2)
    dumped = json.dumps(res, ensure_ascii=False)
    assert "SYSTEM PROMPT INJECTION" not in dumped
    assert any(x["rule_id"] == "r-ui-0" for x in res["soft_broken"])


# ---------------------------------------------------------------- コア意味（土曜始まり・明け除外・上限・月末・重なり）


def test_q5_saturday_weekend_public_off_min_1_and_excludes_ake():
    # 2026-11: 11/01=日, 土曜=7, 14, 21, 28
    req = _req(
        staff=_staff(8),
        need_per_shift={"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        rules=[{
            "type": "occurrence",
            "strength": "絶対",
            "starts": {"weekdays": [6]},
            "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}],
            "at_least": 1,
        }],
    )
    res = solve_inline(InlineSolveIn.model_validate(req), workers=2)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    chk = check(req, res)
    assert chk["hard"] == {}
    assert chk["rules_hard_broken"] == 0

    # 各職員に、金曜が夜勤でない土日とも休みの組が1つ以上ある
    for sid, row in res["cells"].items():
        hits = [
            sat for sat in (7, 14, 21, 28)
            if row[sat - 1] == "" and row[sat] == "" and row[sat - 2] != "夜勤"
        ]
        assert len(hits) >= 1, f"{sid} has no true weekend public off: {row}"

    # 独立検証: 金曜夜勤→土曜明け→日曜休 は「公休, 公休」に数えない（verify & check）
    fac = _fac(8)
    mo = Month(month="2026-11", days=30, first_weekday=0)
    occ_rule = Occurrence(
        id="r-wk", label="土日とも休み1回以上", strength="絶対",
        pattern=[ShiftSel(ids=[PUBLIC_OFF]), ShiftSel(ids=[PUBLIC_OFF])],
        starts=DaySel(weekdays=[6]), at_least=1,
    )
    bad_cells = {s.staff_id: [""] * 30 for s in fac.staff}
    for sat in (7, 14, 21, 28):
        bad_cells["S01"][sat - 1] = "日勤"
    # S01 について 14(土)だけ金(13日)=夜勤→14(土)=休(明け)→15(日)=休 に差し替え
    bad_cells["S01"][12] = "夜勤"
    bad_cells["S01"][13] = ""
    bad_cells["S01"][14] = ""
    # 13が金曜夜勤なので14土曜は明け。他週末7,21,28は日勤なので真の土日公休は0回
    assert verify_monthly(fac, mo, bad_cells, [occ_rule]) == {"r-wk": 1}
    bad_req = _req(need_per_shift={"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0}, rules=[{
        "type": "occurrence", "strength": "絶対", "starts": {"weekdays": [6]},
        "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}], "at_least": 1,
    }])
    chk_bad = check(bad_req, {"status": "OPTIMAL", "days": 30, "wall_ms": 5, "app_labor_rules": True, "cells": bad_cells})
    assert chk_bad["rules_hard_broken"] == 1
    assert chk_bad["hard"].get("追加ルール（並びの回数）") == 1


def test_q5_occurrence_at_most_2_and_overlapping_count():
    # 「同じ並びを2回以下」→ 3回以上の人がいない
    req = _req(
        staff=_staff(8),
        need_per_shift={"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        rules=[{
            "type": "occurrence",
            "strength": "絶対",
            "starts": {"weekdays": [6]},
            "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}],
            "at_most": 2,
        }],
    )
    res = solve_inline(InlineSolveIn.model_validate(req), workers=2)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    chk = check(req, res)
    assert chk["rules_hard_broken"] == 0
    for sid, row in res["cells"].items():
        hits = [sat for sat in (7, 14, 21, 28) if row[sat - 1] == "" and row[sat] == "" and row[sat - 2] != "夜勤"]
        assert len(hits) <= 2, f"{sid} had {len(hits)} weekends off"

    # 重なりを数える: 4連休（1〜4日）に対して［休, 休, 休］は 2回（1〜3日 と 2〜4日）
    fac = _fac(4)
    mo = Month(month="2026-11", days=10, first_weekday=0)
    r_overlap = Occurrence(
        id="r-ov", label="3連休は1回まで", strength="絶対",
        pattern=[ShiftSel(ids=[OFF]), ShiftSel(ids=[OFF]), ShiftSel(ids=[OFF])],
        at_most=1,
    )
    cells = {s.staff_id: ["日勤"] * 10 for s in fac.staff}
    for d in range(4):
        cells["S01"][d] = ""
    # S01 は 1〜4日休み → 1-3日 と 2-4日 の2回一致 (>1)
    assert verify_monthly(fac, mo, cells, [r_overlap]) == {"r-ov": 1}
    chk_ov = check(
        {
            "month": "2026-11",
            "staff": _staff(4),
            "need_per_shift": {"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
            "rules": [{"type": "occurrence", "strength": "絶対", "pattern": [{"ids": ["休"]}] * 3, "at_most": 1}],
        },
        {"status": "OPTIMAL", "days": 10, "wall_ms": 5, "app_labor_rules": True, "cells": cells},
    )
    assert chk_ov["rules_hard_broken"] == 1


def test_q5_end_of_month_saturday_not_counted():
    # 2026-10: 31日間、10/01=木(4)。土曜日は 3, 10, 17, 24, 31（31日は翌月1日が日曜で月末跨ぎ）
    req = _req(
        staff=_staff(8),
        month="2026-10",
        need_per_shift={"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        rules=[{
            "type": "occurrence",
            "strength": "絶対",
            "people": {"ids": ["S01"]},
            "starts": {"weekdays": [6]},
            "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}],
            "at_least": 1,
        }],
        # 3, 10, 17日（最初の3つの土曜）に勤務を固定 → 月内完結には 24(土)-25(日) を使うしかなく、31日だけでは満たせない
        fixed={"S01": {3: "日勤", 10: "日勤", 17: "日勤"}},
    )
    res = solve_inline(InlineSolveIn.model_validate(req), workers=2)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    row = res["cells"]["S01"]
    assert row[23] == "" and row[24] == "" and row[22] != "夜勤"  # 24(土)-25(日)が公休になる

    # 24(土)だけ日勤で31(土)だけ休みにしても、verify と check は 0回（違反）と判定する
    fac = _fac(8)
    mo = Month(month="2026-10", days=31, first_weekday=4)
    occ = Occurrence(
        id="r-oct", label="土日とも休み1回以上", strength="絶対",
        people=PeopleSel(ids=["S01"]),
        pattern=[ShiftSel(ids=[PUBLIC_OFF]), ShiftSel(ids=[PUBLIC_OFF])],
        starts=DaySel(weekdays=[6]), at_least=1,
    )
    cells_only_31 = {s.staff_id: ["日勤"] * 31 for s in fac.staff}
    cells_only_31["S01"][30] = ""  # 10/31(土)だけ休（翌月1日は数えない）
    assert verify_monthly(fac, mo, cells_only_31, [occ]) == {"r-oct": 1}
    chk = check(
        {
            "month": "2026-10",
            "staff": _staff(8),
            "need_per_shift": {"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
            "rules": [{
                "type": "occurrence", "strength": "絶対", "people": {"ids": ["S01"]},
                "starts": {"weekdays": [6]}, "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}], "at_least": 1,
            }],
        },
        {"status": "OPTIMAL", "days": 31, "wall_ms": 5, "app_labor_rules": True, "cells": cells_only_31},
    )
    assert chk["rules_hard_broken"] == 1


def test_q5_balance_days_weekend_public_off_and_omitted_days_unchanged():
    req = _req(
        staff=_staff(8),
        need_per_shift={"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        rules=[{
            "type": "balance",
            "strength": "絶対",
            "shifts": {"ids": ["公休"]},
            "days": {"weekdays": [0, 6]},
            "max_spread": 1,
        }],
    )
    res = solve_inline(InlineSolveIn.model_validate(req), workers=2)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    chk = check(req, res)
    assert chk["rules_hard_broken"] == 0
    assert chk["hard"] == {}

    # 土日の公休数を直接数えて 差 <= 1
    weekend_days = [1, 7, 8, 14, 15, 21, 22, 28, 29]  # 2026-11 の日・土
    counts = []
    for sid, row in res["cells"].items():
        c = sum(1 for d in weekend_days if row[d - 1] == "" and (d == 1 or row[d - 2] != "夜勤"))
        counts.append(c)
    assert max(counts) - min(counts) <= 1

    # check() と verify_monthly() が差 >= 2 を検出（ソフト/ハードとも）
    bad_cells = {s["staff_id"]: ["日勤"] * 30 for s in _staff(4)}
    for d in (1, 7, 8):
        bad_cells["S01"][d - 1] = ""  # S01=3回、他=0回 → 差3 (>1)
    fac4 = _fac(4)
    mo = Month(month="2026-11", days=30, first_weekday=0)
    r_bal = Balance(id="b1", label="土日公休", strength="強く", shifts=ShiftSel(ids=[PUBLIC_OFF]), days=DaySel(weekdays=[0, 6]), max_spread=1)
    assert verify_monthly(fac4, mo, bad_cells, [r_bal]) == {"b1": 1}
    chk_soft = check(
        {
            "month": "2026-11", "staff": _staff(4), "need_per_shift": {"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
            "rules": [{"type": "balance", "strength": "強く", "shifts": {"ids": ["公休"]}, "days": {"weekdays": [0, 6]}, "max_spread": 1}],
        },
        {"status": "OPTIMAL", "days": 30, "wall_ms": 5, "app_labor_rules": True, "cells": bad_cells},
    )
    assert chk_soft["rules_soft_broken"] == 1
    assert "追加ルール（偏り）" not in chk_soft["hard"]

    # days を省略した既存の Balance は全日と同じ結果
    r_all_default = Balance(id="b2", label="全", shifts=ShiftSel(ids=["夜勤"]), max_spread=1)
    r_all_explicit = Balance(id="b2", label="全", shifts=ShiftSel(ids=["夜勤"]), days=DaySel(), max_spread=1)
    m_def = solve_monthly(fac4, Month(month="2026-11", days=14, first_weekday=0),
                          [Staffing(id="n", label="n", shifts=ShiftSel(ids=["夜勤"]), at_least=1, at_most=1), r_all_default], workers=1)
    m_exp = solve_monthly(fac4, Month(month="2026-11", days=14, first_weekday=0),
                          [Staffing(id="n", label="n", shifts=ShiftSel(ids=["夜勤"]), at_least=1, at_most=1), r_all_explicit], workers=1)
    assert m_def.cells == m_exp.cells
    assert m_def.objective == m_exp.objective


def test_q5_explain_format_for_occurrence_and_without_r_ake_or_relax():
    # S01 に全土曜の勤務を固定し、ソフトの発生回数ルールで explain の文面を確認
    req = _req(
        staff=_staff(8),
        need_per_shift={"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        rules=[{
            "type": "occurrence",
            "strength": "強く",
            "people": {"ids": ["S01"]},
            "starts": {"weekdays": [6]},
            "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}],
            "at_least": 1,
        }],
        fixed={"S01": {7: "日勤", 14: "日勤", 21: "日勤", 28: "日勤"}},
    )
    res = solve_inline(InlineSolveIn.model_validate(req), workers=2)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    sb = next(x for x in res["soft_broken"] if x["rule_id"] == "r-ui-0")
    assert sb["count"] == 1
    assert sb["detail"] == ["S01さんの『土日とも休み』が月0回（1回以上）"]
    assert any("S01さんの『土日とも休み』が月0回（1回以上）" in ln for ln in res["explanation"])

    # r-ake 無しの直接 solve_monthly + relax=True（infeasible時）でも _public_off_bool が -1 を出さず破綻しないこと
    fac = _fac(3)
    mo = Month(month="2026-11", days=7, first_weekday=0)
    r_occ = Occurrence(
        id="occ-p", label="土曜休み2連", strength="絶対",
        pattern=[ShiftSel(ids=[PUBLIC_OFF]), ShiftSel(ids=[PUBLIC_OFF])],
        starts=DaySel(weekdays=[6]), at_least=1,
    )
    r_imp = Succession(id="r-max1", label="連勤1", strength="絶対", max_run=0 if False else 1)
    r_need = Staffing(id="st", label="日勤2", strength="絶対", shifts=ShiftSel(ids=["日勤"]), at_least=3, at_most=3)
    m_res = solve_monthly(fac, mo, [r_need, r_occ, r_imp], workers=1)
    assert m_res.status == "INFEASIBLE"
    assert m_res.relaxation  # 緩和候補が返り、モデル不整合で例外にならない
    exp = explain_monthly(m_res)
    assert exp

    # r-ake なしでも 金夜勤→土休→日休 を公休2日として数えない
    r_occ_fri = Occurrence(
        id="occ-sat", label="土日とも休み", strength="絶対",
        people=PeopleSel(ids=["S01"]),
        pattern=[ShiftSel(ids=[PUBLIC_OFF]), ShiftSel(ids=[PUBLIC_OFF])],
        starts=DaySel(weekdays=[6]), at_least=1,
    )
    # 7日（7日は土曜なので 7+2-1=8>7 で月末、14日でテストし 6日(金)に夜勤固定 → 7(土)は明けなので 14-15 が使われる）
    mo15 = Month(month="2026-11", days=15, first_weekday=0)
    m_no_ake = solve_monthly(
        fac, mo15, [r_occ_fri],
        fixed={"S01": {6: "夜勤", 7: OFF, 8: OFF}},  # 6金が夜勤 → 7土は明けなので土日とも休みは 14-15 で取る必要がある
        workers=1,
    )
    assert m_no_ake.status == "OPTIMAL"
    assert m_no_ake.cells["S01"][13] == "" and m_no_ake.cells["S01"][14] == ""


def test_service_accepts_and_validates_occurrence_and_balance_days(synth):
    guard.reset()
    svc = Svc(MemoryRepo.from_synth(synth))
    server.set_service(svc)
    client = TestClient(server.app)
    try:
        good_occ = {
            "id": "r-occ-test", "type": "occurrence", "label": "土日とも休み1回以上",
            "strength": "強く", "origin": {"kind": "リーダーの言葉"},
            "starts": {"weekdays": [6]}, "pattern": [{"ids": ["公休"]}, {"ids": ["公休"]}], "at_least": 1,
        }
        r1 = client.post("/api/v1/facilities/fac-hidamari/rules", json=good_occ)
        assert r1.status_code == 201

        good_bal = {
            "id": "r-bal-test", "type": "balance", "label": "土日公休差1以内",
            "strength": "強く", "origin": {"kind": "リーダーの言葉"},
            "shifts": {"ids": ["公休"]}, "days": {"weekdays": [0, 6]}, "max_spread": 1,
        }
        r2 = client.post("/api/v1/facilities/fac-hidamari/rules", json=good_bal)
        assert r2.status_code == 201

        bad_occ = {**good_occ, "id": "r-occ-bad", "starts": {"dates": [32]}}
        r3 = client.post("/api/v1/facilities/fac-hidamari/rules", json=bad_occ)
        assert r3.status_code == 422
    finally:
        server.set_service(None)
        guard.reset()
