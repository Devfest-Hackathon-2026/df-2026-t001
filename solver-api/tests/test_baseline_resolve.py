"""U2（解き直しで前の表を保つ：2段求解・baseline・changed・説明文）のテスト。"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.dsl import OFF, Facility, Month, PeopleSel, Request, ShiftSel, Staffing, StaffMember, DaySel
from care.inline_solve import InlineSolveIn, solve_inline
from care.solver import monthly
from care.solver.monthly import solve_monthly

URL = "/api/v1/solve-inline"
FIXTURE = Path(__file__).parent / "fixtures" / "app_staff.json"
UX_RULE_06 = Path(__file__).parent / "fixtures" / "ux_rules" / "ikegami-2shift" / "06_night_two_days_off.json"


@pytest.fixture
def client():
    guard.reset()
    return TestClient(server.app)


def _staff_12():
    sh = ["早番", "日勤", "遅番", "夜勤"]
    return [
        {
            "staff_id": f"S{i:02d}",
            "role": "介護福祉士" if i > 1 else "主任",
            "employment": "常勤",
            "skills": ["medical"] if i % 2 == 0 else [],
            "shifts": ["早番", "日勤", "遅番"] if i == 1 else list(sh),
            "is_leader": i == 1,
        }
        for i in range(1, 13)
    ]


def test_u2_no_op_rule_keeps_zero_changed_cells():
    sakura = json.loads(FIXTURE.read_text())
    base_req = {
        "month": "2026-11",
        "staff": sakura,
        "need_per_shift": {"早番": 4, "日勤": 4, "遅番": 4, "夜勤": 4},
        "time_limit": 12.0,
    }
    base_res = solve_inline(InlineSolveIn.model_validate(base_req), workers=1)
    assert base_res["status"] == "OPTIMAL"
    base_cells = base_res["cells"]

    # 基準の表ですでに満たされているルール（日勤は毎日4人以上・絶対）を追加しても、1マスも動かない
    req_noop = copy.deepcopy(base_req)
    req_noop["baseline"] = base_cells
    req_noop["rules"] = [
        {
            "id": "r-noop",
            "type": "staffing",
            "label": "日勤は毎日4人以上",
            "strength": "絶対",
            "shifts": {"ids": ["日勤"]},
            "at_least": 4,
        }
    ]
    res2 = solve_inline(InlineSolveIn.model_validate(req_noop), workers=1)
    assert res2["status"] == "OPTIMAL"
    assert res2["changed"] == {"count": 0, "cells": []}
    assert res2["cells"] == base_cells
    assert res2["explanation"][0].startswith("前の表から変わった勤務は0件")


def test_u2_constraining_rule_changes_only_near_violations_and_keeps_primary_quality():
    # (a) 1日1マスの制約を足したとき、局所的な入れ替えだけで済み、他の日の大部分が保たれる
    st12 = _staff_12()
    base_req = {
        "month": "2026-11",
        "staff": st12,
        "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
        "time_limit": 10.0,
    }
    base_res = solve_inline(InlineSolveIn.model_validate(base_req), workers=1)
    assert base_res["status"] == "OPTIMAL"
    base_cells = base_res["cells"]

    # 5日目に日勤に入っている職員1人を5日目休みに固定する追加ルール
    target_sid = next(s["staff_id"] for s in st12 if base_cells[s["staff_id"]][4] == "日勤")
    rule_day5 = {
        "id": "r-day5-off",
        "type": "request",
        "label": f"{target_sid} の5日休み希望",
        "strength": "絶対",
        "people": {"ids": [target_sid]},
        "days": {"dates": [5]},
        "shifts": {"ids": ["休"]},
        "want": True,
    }
    no_bl = solve_inline(InlineSolveIn.model_validate({**base_req, "rules": [rule_day5]}), workers=1)
    with_bl = solve_inline(
        InlineSolveIn.model_validate({**base_req, "rules": [rule_day5], "baseline": base_cells}),
        workers=1,
    )
    assert with_bl["status"] == "OPTIMAL"
    assert with_bl["cells"][target_sid][4] == ""
    assert 0 < with_bl["changed"]["count"] <= 6
    assert sum(b["count"] for b in with_bl["soft_broken"]) == sum(b["count"] for b in no_bl["soft_broken"])

    # (b) 0.2 の実測パターン（夜勤→休→早番にしない）を sakura苑（34人）に足しても、
    #     元の破り件数 V の 5倍以内かつ、1段目と同等以上の目的関数品質になる
    sakura = json.loads(FIXTURE.read_text())
    r06_rule = json.loads(UX_RULE_06.read_text())["rules"][0]
    req_sakura = {
        "month": "2026-11",
        "staff": sakura,
        "need_per_shift": {"早番": 4, "日勤": 4, "遅番": 4, "夜勤": 4},
        "time_limit": 12.0,
    }
    s_base = solve_inline(InlineSolveIn.model_validate(req_sakura), workers=1)
    v_before = sum(
        1
        for row in s_base["cells"].values()
        for d in range(28)
        if row[d] == "夜勤" and row[d + 1] == "" and row[d + 2] in ("早番", "夜勤")
    )
    assert v_before > 0
    s_no_bl = solve_inline(InlineSolveIn.model_validate({**req_sakura, "rules": [r06_rule]}), workers=1)
    s_bl = solve_inline(
        InlineSolveIn.model_validate({**req_sakura, "rules": [r06_rule], "baseline": s_base["cells"]}),
        workers=1,
    )
    assert s_bl["status"] in ("OPTIMAL", "FEASIBLE")
    v_after = sum(
        1
        for row in s_bl["cells"].values()
        for d in range(28)
        if row[d] == "夜勤" and row[d + 1] == "" and row[d + 2] in ("早番", "夜勤")
    )
    assert v_after == 0
    assert 0 < s_bl["changed"]["count"] <= max(5, v_before * 5)
    assert sum(b["count"] for b in s_bl["soft_broken"]) <= sum(b["count"] for b in s_no_bl["soft_broken"])
    assert s_bl["explanation"][0] == f"前の表から変わった勤務は{s_bl['changed']['count']}件です。"
    assert len(s_bl["changed"]["cells"]) == s_bl["changed"]["count"]


def test_u2_baseline_omitted_matches_legacy_response():
    st12 = _staff_12()
    req = {
        "month": "2026-11",
        "staff": st12,
        "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
    }
    res = solve_inline(InlineSolveIn.model_validate(req), workers=1)
    assert "changed" not in res
    assert not any("前の表から変わった勤務" in ln for ln in res["explanation"])


def test_u2_baseline_validation_422(client):
    st12 = _staff_12()
    base_req = {
        "month": "2026-11",
        "staff": st12,
        "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
    }
    valid_cells = {s["staff_id"]: [""] * 30 for s in st12}

    # 1. 職員の欠落
    missing = {k: v for k, v in valid_cells.items() if k != "S01"}
    r1 = client.post(URL, json={**base_req, "baseline": missing})
    assert r1.status_code == 422 and "baseline" in r1.text

    # 2. 未知の職員ID
    extra = {**valid_cells, "UNKNOWN": [""] * 30}
    r2 = client.post(URL, json={**base_req, "baseline": extra})
    assert r2.status_code == 422 and "baseline" in r2.text

    # 3. 日数不一致
    short_row = {**valid_cells, "S01": [""] * 29}
    r3 = client.post(URL, json={**base_req, "baseline": short_row})
    assert r3.status_code == 422 and "30日" in r3.text

    # 4. 不正な勤務区分
    bad_shift = {**valid_cells, "S02": ["謎勤務"] + [""] * 29}
    r4 = client.post(URL, json={**base_req, "baseline": bad_shift})
    assert r4.status_code == 422 and "謎勤務" in r4.text


def test_u2_fallback_non_strict_and_relaxed_two_stage():
    # (a) _solve_strict（公休8日以上）を満たせない人手タイトな構成 → solve_monthly にフォールバックしても baseline を保つ
    tight_staff = [
        {
            "staff_id": f"T{i:02d}",
            "role": "介護職員",
            "employment": "常勤",
            "skills": ["medical"],
            "shifts": ["早番", "日勤", "遅番", "夜勤"],
        }
        for i in range(1, 13)
    ]
    tight_req = {
        "month": "2026-11",
        "staff": tight_staff,
        "need_per_shift": {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 1},  # 常勤12人に対し1日10勤務+明け=平均27.5稼働日→公休8日不可
        "time_limit": 18.0,
    }
    r_fb = solve_inline(InlineSolveIn.model_validate(tight_req), workers=1)
    assert r_fb["status"] in ("OPTIMAL", "FEASIBLE")
    assert r_fb["app_labor_rules"] is False

    r_fb2 = solve_inline(InlineSolveIn.model_validate({**tight_req, "baseline": r_fb["cells"]}), workers=1)
    assert r_fb2["app_labor_rules"] is False
    assert r_fb2["changed"] == {"count": 0, "cells": []}
    assert r_fb2["cells"] == r_fb["cells"]

    # (b) 通常の solve_monthly で INFEASIBLE → relax=True の二度解きにも 2段目が掛かり、baseline との差が小さい緩和解になる
    fac = Facility(
        facility_id="f-rel",
        name="f-rel",
        staff=[StaffMember(staff_id=f"S{i}", name=f"S{i}", role="介護職員", employment="常勤", shifts=["日勤"]) for i in range(1, 5)],
    )
    mo = Month(month="2026-11", days=10, first_weekday=0)
    r_need = Staffing(id="need2", label="日勤2人", strength="絶対", shifts=ShiftSel(ids=["日勤"]), at_least=2, at_most=2)
    base_m = solve_monthly(fac, mo, [r_need], use_coverage=False, workers=1)
    assert base_m.status == "OPTIMAL"

    # 不可能な全希望を追加（全員全日休み・絶対）→ INFEASIBLE + relaxation に2段目適用
    r_imp = Request(
        id="imp", label="全員休み", strength="絶対",
        people=PeopleSel(), days=DaySel(), shifts=ShiftSel(ids=[OFF]), want=True,
    )
    rel_bl = solve_monthly(fac, mo, [r_need, r_imp], baseline=base_m.cells, two_stage=True, use_coverage=False, workers=1)
    assert rel_bl.status == "INFEASIBLE"
    assert rel_bl.relaxation
    assert len(rel_bl.cells) == 4


def test_u2_stage2_timeout_falls_back_to_stage1_with_explanation(monkeypatch):
    st12 = _staff_12()
    base_req = {
        "month": "2026-11",
        "staff": st12,
        "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
        "time_limit": 6.0,
    }
    base_res = solve_inline(InlineSolveIn.model_validate(base_req), workers=1)
    target_sid = next(s["staff_id"] for s in st12 if base_res["cells"][s["staff_id"]][2] == "日勤")
    rule_day3 = {
        "id": "r-day3-off",
        "type": "request",
        "label": f"{target_sid} の3日休み",
        "strength": "絶対",
        "people": {"ids": [target_sid]},
        "days": {"dates": [3]},
        "shifts": {"ids": ["休"]},
        "want": True,
    }
    # 残り時間要件を大きくし、2段目が動けない状況を作る
    monkeypatch.setattr(monthly, "MIN_STAGE2_TIME", 999.0)
    res = solve_inline(
        InlineSolveIn.model_validate({**base_req, "rules": [rule_day3], "baseline": base_res["cells"]}),
        workers=1,
    )
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    assert res["cells"][target_sid][2] == ""
    assert "changed" in res and res["changed"]["count"] == len(res["changed"]["cells"])
    assert res["explanation"][0].startswith("前の表から変わった勤務は")
    assert any("前の表に寄せる時間がありませんでした" in ln for ln in res["explanation"])
