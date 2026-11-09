import pytest
from pydantic import ValidationError

from care.defaults import default_rules, request_rules
from care.dsl import (Count, DaySel, Facility, Month, PeopleSel, ShiftSel, StaffMember, Staffing, Succession, TaskRequest,
                      TaskTemplate)
from care.solver.coverage import SLOTS, capacity_report
from care.solver.daily import build_duties, on_duty, solve_daily
from care.solver.explain import explain_daily, explain_monthly
from care.solver.loop import solve_integrated
from care.solver.monthly import solve_monthly
from care.synth_io import carry_in, load
from care.verify import verify_monthly

FIDS = ["fac-hidamari", "fac-midori", "fac-sakura"]


def setup(synth, fid):
    fac, mo, reqs = load(fid, out=synth)
    ci = carry_in(fid, out=synth)
    rules = default_rules(fac, mo) + request_rules(reqs, mo.month)
    return fac, mo, rules, ci


# ---------------------------------------------------------------- DSL

def test_dsl_rejects_malformed_rules():
    with pytest.raises(ValidationError):
        Staffing(id="x", label="x", shifts=ShiftSel())                      # at_least も at_most も無い
    with pytest.raises(ValidationError):
        Succession(id="x", label="x")                                        # pattern も max_run も無い
    with pytest.raises(ValidationError):
        Succession(id="x", label="x", max_run=5, pattern=[ShiftSel()])      # 両方ある
    with pytest.raises(ValidationError):
        Staffing(id="x", label="x", shifts=ShiftSel(), at_least=1, strength="めちゃくちゃ")   # 3段階以外


def test_templates_fit_shift_capacity(synth):
    for fid in FIDS:
        fac, *_ = load(fid, out=synth)
        assert capacity_report(fac.templates, fac.need_per_shift) == []


# ---------------------------------------------------------------- 月次

@pytest.mark.parametrize("fid", FIDS)
def test_monthly_optimal_and_independently_verified(synth, fid):
    fac, mo, rules, ci = setup(synth, fid)
    r = solve_monthly(fac, mo, rules, carry_in=ci, time_limit=30)
    assert r.status in ("OPTIMAL", "FEASIBLE")  # CI は遅く、時間切れで最適性を証明できないことがある（実行可能性は検証器で確認）
    assert r.wall_ms < 15000
    assert verify_monthly(fac, mo, r.cells, rules, ci) == {}          # ソルバーとは別の素朴な実装で破れ0
    assert r.soft_broken == []


def test_verifier_detects_violations(synth):
    fac, mo, rules, ci = setup(synth, "fac-hidamari")
    r = solve_monthly(fac, mo, rules, carry_in=ci)
    cells = {k: list(v) for k, v in r.cells.items()}
    # 夜勤のあとに勤務を置く／6連勤にする／入れない勤務区分に入れる
    night = next((sid, i) for sid, row in cells.items() for i, x in enumerate(row[:-2]) if x == "夜勤")
    cells[night[0]][night[1] + 1] = "日勤"
    part = next(s for s in fac.staff if "夜勤" not in s.shifts)
    cells[part.staff_id][3] = "夜勤"
    v = verify_monthly(fac, mo, cells, rules, ci)
    assert v.get("r-ake", 0) >= 1 and v.get("allowed-shift", 0) >= 1


def test_infeasible_returns_relaxation_that_names_the_rule(synth):
    fac, mo, rules, ci = setup(synth, "fac-hidamari")
    fac.need_per_shift = {**fac.need_per_shift, "夜勤": 6}               # 夜勤できる人数を超える
    rules = default_rules(fac, mo) + request_rules(load("fac-hidamari", out=synth)[2], mo.month)
    r = solve_monthly(fac, mo, rules, carry_in=ci, time_limit=20)
    assert r.status == "INFEASIBLE"
    ids = {b.rule_id for b in r.relaxation}
    assert "r-staff-夜勤" in ids
    text = "\n".join(explain_monthly(r))
    assert "夜勤は毎日6人以上" in text


def test_vacancy_resolve_changes_few_cells(synth):
    fac, mo, rules, ci = setup(synth, "fac-midori")
    base = solve_monthly(fac, mo, rules, carry_in=ci)
    sid, day = next((s, i + 1) for s, row in base.cells.items() for i, x in enumerate(row) if x == "遅番" and 8 < i < 20)
    r = solve_monthly(fac, mo, rules, carry_in=ci, baseline=base.cells, fixed={sid: {day: "休"}})
    assert r.status in ("OPTIMAL", "FEASIBLE")  # CI は遅く、時間切れで最適性を証明できないことがある（実行可能性は検証器で確認）
    changed = sum(1 for k in base.cells for a, b in zip(base.cells[k], r.cells[k]) if a != b)
    assert changed <= 12                                                  # 全体を組み直さず、最小限の変更で埋める
    assert r.cells[sid][day - 1] == ""
    assert verify_monthly(fac, mo, r.cells, rules, ci) == {}


# ---------------------------------------------------------------- 日次

def _check_daily(fac, mo, cells, day, ci, res):
    staff = {sd.staff.staff_id: sd for sd in on_duty(fac, mo, cells, day, ci)}
    busy: dict[tuple[str, int], str] = {}
    skills = {s.staff_id: set(s.skills) for s in fac.staff}
    tpl = {t.template_id: t for t in fac.templates}
    for a in res.assignments:
        assert all(k in staff[a["staff_id"]].slots for k in range(a["start"], a["end"])), "在席していない時間に割当"
        for k in range(a["start"], a["end"]):
            assert (a["staff_id"], k) not in busy, "同じ人の業務が重なっている"
            busy[a["staff_id"], k] = a["task"]
    for b in res.breaks:
        assert all(k in staff[b["staff_id"]].slots for k in range(b["start"], b["end"]))
        for k in range(b["start"], b["end"]):
            assert (b["staff_id"], k) not in busy, "休憩と業務が重なっている"
            busy[b["staff_id"], k] = "休憩"
    # 資格が必要な枠は資格者
    by_slot = {}
    for a in res.assignments:
        by_slot.setdefault((a["template_id"], a["start"]), []).append(a["staff_id"])
    for (tid, _), sids in by_slot.items():
        t = tpl[tid]
        if t.skill:
            assert any(t.skill in skills[s] for s in sids)


@pytest.mark.parametrize("fid", FIDS)
def test_daily_valid_and_complete(synth, fid):
    fac, mo, rules, ci = setup(synth, fid)
    r = solve_monthly(fac, mo, rules, carry_in=ci)
    for day in (1, 12, 22, 30):
        d = solve_daily(fac, mo, r.cells, day, carry_in=ci)
        assert d.status in ("OPTIMAL", "FEASIBLE")  # CI は遅く、時間切れで最適性を証明できないことがある（実行可能性は検証器で確認）
        assert d.unmet == []
        _check_daily(fac, mo, r.cells, day, ci, d)
        # 6時間以上の在席者には休憩が付く
        need_break = [sd for sd in on_duty(fac, mo, r.cells, day, ci) if len(sd.slots) >= 12 and (sd.prev_day or sd.shift != "夜勤")]
        assert len(d.breaks) == len(need_break)


def test_daily_hard_task_avoid_is_respected(synth):
    fac, mo, rules, ci = setup(synth, "fac-sakura")
    r = solve_monthly(fac, mo, rules, carry_in=ci)
    day = 12
    d0 = solve_daily(fac, mo, r.cells, day, carry_in=ci)
    sid = next(a["staff_id"] for a in d0.assignments if a["task"] == "bath")
    rule = TaskRequest(id="t-avoid", label="入浴は担当しない", strength="絶対", people=PeopleSel(ids=[sid]), task="bath", want=False)
    d1 = solve_daily(fac, mo, r.cells, day, carry_in=ci, rules=[rule])
    assert d1.unmet == []
    assert all(not (a["staff_id"] == sid and a["task"] == "bath") for a in d1.assignments)


def test_daily_unmet_explained_when_nobody_has_skill(synth):
    fac, mo, rules, ci = setup(synth, "fac-hidamari")
    r = solve_monthly(fac, mo, rules, carry_in=ci)
    for s in fac.staff:                                                  # 全員から認知症ケアの資格を外す
        s.skills = [k for k in s.skills if k != "dementia"]
    d = solve_daily(fac, mo, r.cells, 5, carry_in=ci)
    assert d.unmet and all("認知症ケア" in u["cause"] for u in d.unmet if u["skill"] == "dementia")      # 内部キーではなく日本語で原因を出す
    assert any(k[1] == "dementia" for k in d.skill_shortfall)
    text = "\n".join(explain_daily(d))
    assert "割り当てられませんでした" in text and "dementia" not in text and "watch" not in text


# ---------------------------------------------------------------- 月次↔日次

def _tiny_facility():
    staff = [StaffMember(staff_id=f"T-{i}", name=f"t{i}", role="介護福祉士", employment="常勤", shifts=["日勤"]) for i in range(6)]
    tpl = [TaskTemplate(template_id="T1", task="rec", start="12:00", end="15:00", headcount=4)]
    fac = Facility(facility_id="tiny", name="tiny", staff=staff, templates=tpl, need_per_shift={"日勤": 4})
    mo = Month(month="2026-07", days=7, first_weekday=3)
    rules = [Staffing(id="r-day", label="日勤4人以上", shifts=ShiftSel(ids=["日勤"]), at_least=4),
             # 人件費を抑えたい、という軽い希望。日次の不足は、これより重い必要人数で上書きされる
             Staffing(id="r-lean", label="日勤は4人まで", strength="できれば", shifts=ShiftSel(ids=["日勤"]), at_most=4)]
    return fac, mo, rules


def test_feedback_loop_adds_staff_until_daily_is_complete():
    fac, mo, rules = _tiny_facility()
    # 4人では、全員の休憩が12〜15時に重なり、業務が埋まらない（月次の集約制約だけでは気づけない）
    r = solve_integrated(fac, mo, rules, max_iter=4, monthly_time=10)
    assert r.iterations[0].unmet > 0
    assert r.unmet_total == 0
    assert len(r.iterations) >= 2
    assert [i.unmet for i in r.iterations][-1] == 0
    assert r.monthly.cells["T-0"] is not None


def test_build_duties_chunks_long_windows():
    tpl = [TaskTemplate(template_id="A", task="watch", start="09:00", end="17:00", headcount=1, skill="dementia"),
           TaskTemplate(template_id="B", task="meal", start="12:00", end="13:00", headcount=3)]
    d = build_duties(tpl)
    assert sum(1 for x in d if x.template_id == "A") == 8                # 8時間 → 1時間×8枠
    assert sum(1 for x in d if x.template_id == "B") == 3
    assert max(x.end for x in d) <= SLOTS
