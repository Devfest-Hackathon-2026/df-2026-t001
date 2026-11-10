"""欠員の日だけを、変わる勤務を最小にして組み直す（画面の職員データと今の勤務表をそのまま送る。保存しない）。

POST /api/v1/replan-inline

* 入力は solve-inline と同じ職員・ルールの項目に、今の勤務表 cells・欠員の日 date・欠員 vacancy を足したもの。
* 欠員の日以外はすべて今の勤務に固定する（fixed_other_days）。動かせるのはその日の勤務だけ。
* モデルは monthly._Build（service.replan と同じ。fixed で固定・baseline で元の表）を使い、目的関数だけ次の順に重みを付け直す:
  その日の「強く」（希望休・夜勤の医療的ケア）1000 > 変わる勤務1件 100 > 月の公平さ・勤務日数の目安 1（同点のときの決め手）。
  つまり「その日の強い希望を守る案のうち、変わる勤務が最も少ない案」。
* 硬制約は solve-inline の app_labor_rules と同じ数え方（夜勤明けも連勤に数えて5日まで・常勤の公休8日以上・夜勤明け・
  遅番→早番の禁止・夜勤の上限・入れない日・入れない勤務区分）。ただし今の表がすでに破っているものは
  「これ以上悪くしない」に読み替える（固定した日の古い破れのせいで、欠員の日が解けなくなるのを防ぐ）。
* 欠員の勤務区分は「欠員を除いた人数 + 1」以上に戻す。その日のほかの勤務区分は、基準人数（今それより少なければ今の人数）を下回らない。
* 解けなければ、硬制約も罰点つきにして「何を何件破れば埋まるか」（relaxation）を返す。500 は返さない。
* 日次（時間帯ごとの業務割当, care/solver/daily.py）は、画面の施設に日課テンプレートが無いため返さない。
"""
from __future__ import annotations

import time
from typing import Literal

from ortools.sat.python import cp_model
from pydantic import BaseModel, Field, field_validator

from .dsl import OFF, PENALTY, WORK_SHIFTS, DaySel, Request, Staffing
from .inline_solve import APP_MAX_NIGHTS, APP_MAX_RUN, APP_MIN_OFF, InlineSolveIn, build
from .service import ServiceError
from .solver.monthly import DEFAULT_WORKERS, HARD_BROKEN_WEIGHT, Broken, _aggregate, _Build, _cells

MAX_TIME = 10.0
CHANGE_COST = 100     # 変わる勤務1件の罰点。月の公平さ（1件1点・1人の追加で高々数件）より必ず重く、その日の「強く」（1000）より軽い
_WORK = set(WORK_SHIFTS)


class VacancyRef(BaseModel):
    shift: Literal["早番", "日勤", "遅番", "夜勤"]
    absent_staff_id: str | None = Field(None, max_length=40)


class InlineReplanIn(InlineSolveIn):
    cells: dict[str, list[str]] = Field(max_length=80)
    date: int = Field(ge=1, le=31)
    vacancy: VacancyRef
    fixed_other_days: Literal[True] = True
    time_limit: float = Field(5.0, ge=1, le=18)      # solve-inline と同じ上限で受け、MAX_TIME に丸める

    @field_validator("cells")
    @classmethod
    def _cells(cls, v: dict[str, list[str]]) -> dict[str, list[str]]:
        for sid, row in v.items():
            if len(sid) > 40 or len(row) > 31:
                raise ValueError(f"cells が不正です: {sid[:40]}")
            bad = [k for k in row if k not in (*WORK_SHIFTS, "", OFF)]
            if bad:
                raise ValueError(f"勤務区分が不正です: {sid} {bad[:3]}")
        return v


class _Hard:
    """硬制約（「これ以上悪くしない」つき）。relax=True なら罰点つきの軟制約にして、破れた分を数える。"""

    def __init__(self, bd: _Build, base: dict[str, list[str]], carry: dict[str, str], relax: bool):
        self.bd, self.base, self.carry, self.relax = bd, base, carry, relax
        self.lits: list[tuple[cp_model.IntVar, str, str, str]] = []     # (満たしたか, rule_id, label, 詳細)

    def term(self, sid: str, day: int, kinds: set[str]):
        """(変数 or 定数)。day=0 は前月末（carry_in）"""
        if day == 0:
            return 1 if self.carry.get(sid) in kinds else 0
        return sum(self.bd.x[sid, day, k] for k in kinds)

    def base_val(self, sid: str, day: int, kinds: set[str]) -> int:
        if day == 0:
            return 1 if self.carry.get(sid) in kinds else 0
        return 1 if (self.base[sid][day - 1] or OFF) in kinds else 0

    def post(self, rid: str, label: str, terms: list[tuple[str, int, set[str]]], sense: str, bound: int, detail: str,
             keep_worse: bool = True, always_hard: bool = False) -> None:
        expr = sum(self.term(*t) for t in terms)
        if keep_worse:
            now = sum(self.base_val(*t) for t in terms)
            bound = max(bound, now) if sense == "<=" else min(bound, now)
        c = (expr <= bound) if sense == "<=" else (expr >= bound)
        if isinstance(c, bool):          # 変数を含まない（固定日だけ）の式
            return
        if not self.relax or always_hard:
            self.bd.m.add(c)
            return
        lit = self.bd.m.new_bool_var(f"h_{rid}_{len(self.lits)}")
        self.bd.m.add(c).only_enforce_if(lit)
        self.lits.append((lit, rid, label, detail))


def _prepare(b: InlineReplanIn):
    fac, mo, rules, carry = build(b)
    N, d = mo.days, b.date
    if d > N:
        raise ServiceError(400, f"date は 1〜{N} です")
    known = {s.staff_id for s in fac.staff}
    unknown = sorted(set(b.cells) - known)
    if unknown:
        raise ServiceError(400, f"cells に staff に無い職員がいます: {unknown[:3]}")
    if any(len(row) != N for row in b.cells.values()):
        raise ServiceError(400, f"cells の日数は {N} 日です")
    absent = b.vacancy.absent_staff_id
    if absent is not None and absent not in known:
        raise ServiceError(400, f"absent_staff_id が staff にいません: {absent}")
    base = {s.staff_id: [("" if k == OFF else k) for k in b.cells.get(s.staff_id, [""] * N)] for s in fac.staff}
    if absent:
        base[absent][d - 1] = ""
    # 固定した日に、今の表で「入れない勤務区分」が入っていても解けなくならないよう、モデル上は許す（欠員の日は別に禁止する）
    orig = {s.staff_id: set(s.shifts) for s in fac.staff}
    for s in fac.staff:
        extra = sorted({k for k in base[s.staff_id] if k} - orig[s.staff_id])
        if extra:
            s.shifts = [*s.shifts, *extra]
    return fac, mo, rules, carry, base, orig


def _held_before(r: Staffing, fac, base: dict[str, list[str]], d: int, sh: str, absent: str | None) -> bool:
    """その日の人数の目安（軟）を、欠員が出る前の表が満たしていたか。満たしていたものだけ守る（戻す）"""
    kinds = set(r.shifts.kinds())
    people = [s for s in fac.staff if r.people.match(s)]
    n = sum(1 for s in people if base[s.staff_id][d - 1] in kinds)
    anyone = not (r.people.ids or r.people.roles or r.people.skills or r.people.employment)
    if sh in kinds and ((absent is None and anyone) or any(s.staff_id == absent for s in people)):
        n += 1                            # 欠けた1人（欠員の前はいた）
    return (r.at_least is None or n >= r.at_least) and (r.at_most is None or n <= r.at_most)


def _model(b: InlineReplanIn, fac, mo, rules, carry, base, orig, relax: bool):
    N, d, sh = mo.days, b.date, b.vacancy.shift
    soft = []
    for r in rules:
        if r.strength == "絶対":
            continue                      # 硬制約は _Hard で、欠員の日にかかるものだけ入れ直す
        if isinstance(r, (Staffing, Request)):
            if not r.days.match(d, mo.weekday(d)):
                continue                  # 固定した日だけのルールは定数なので入れない
            if isinstance(r, Staffing) and not _held_before(r, fac, base, d, sh, b.vacancy.absent_staff_id):
                continue                  # 欠員の前から満たしていなかった人数の目安（行事の追加など）は、この組み直しで直しに行かない
            r = r.model_copy(update={"days": DaySel(dates=[d])})
        soft.append(r)
    fixed = {sid: {day: (row[day - 1] or OFF) for day in range(1, N + 1) if day != d} for sid, row in base.items()}
    bd = _Build(fac, mo, soft, fixed=fixed, carry_in=carry, relax=False, boost=None, baseline=base, use_coverage=False)
    H = _Hard(bd, base, carry, relax)
    W = _WORK
    cap = b.night_max or APP_MAX_NIGHTS
    unavailable = {sid for sid, ds in b.unavailable.items() if d in ds}
    for s in fac.staff:
        sid = s.staff_id
        H.post("r-ake", "夜勤のあとは翌日を休みにする", [(sid, d - 1, {"夜勤"}), (sid, d, W)], "<=", 1, f"{sid} {d}日")
        if d < N:
            H.post("r-ake", "夜勤のあとは翌日を休みにする", [(sid, d, {"夜勤"}), (sid, d + 1, W)], "<=", 1, f"{sid} {d + 1}日")
        H.post("r-interval", "遅番のあとに早番を置かない", [(sid, d - 1, {"遅番"}), (sid, d, {"早番"})], "<=", 1, f"{sid} {d}日")
        if d < N:
            H.post("r-interval", "遅番のあとに早番を置かない", [(sid, d, {"遅番"}), (sid, d + 1, {"早番"})], "<=", 1, f"{sid} {d + 1}日")
        # 画面の数え方: 夜勤明けの日も勤務日。6日の窓で5日まで（欠員の日 d と、その夜勤明けになる d+1 を含む窓だけ）
        cov = lambda day: [(sid, day, W), (sid, day - 1, {"夜勤"})]   # noqa: E731
        for i in range(max(1, d - APP_MAX_RUN), min(d + 1, N - APP_MAX_RUN) + 1):
            terms = [t for day in range(i, i + APP_MAX_RUN + 1) for t in cov(day)]
            H.post("r-run", f"連続勤務は{APP_MAX_RUN}日まで（夜勤明けも数える）", terms, "<=", APP_MAX_RUN, f"{sid} {i}日〜")
        H.post("r-night-cap", f"夜勤は月{cap}回まで", [(sid, day, {"夜勤"}) for day in range(1, N + 1)], "<=", cap, sid)
        if s.employment == "常勤" and not s.is_leader and orig[sid]:
            H.post("r-min-off", f"常勤の公休は月{APP_MIN_OFF}日以上（明けは数えない）",
                   [t for day in range(1, N + 1) for t in cov(day)], "<=", N - APP_MIN_OFF, sid)
        if sid in unavailable:
            H.post(f"na-{sid}", f"{sid} の入れない日", [(sid, d, W)], "<=", 0, f"{sid} {d}日")
        for k in WORK_SHIFTS:
            if k not in orig[sid]:
                H.post("r-shift-kind", "入れない勤務区分には入れない", [(sid, d, {k})], "<=", 0, f"{sid} {d}日 {k}")
    # 人数: 欠員の勤務区分は「欠員を除いた人数 + 1」に戻す。ほかの区分は基準人数（今それより少なければ今の人数）を下回らない
    need = dict(fac.need_per_shift)
    target = sum(1 for row in base.values() if row[d - 1] == sh) + 1
    H.post("r-vacancy", f"{d}日の{sh}を{target}人に戻す（欠員の補充）", [(sid, d, {sh}) for sid in base], ">=", target, f"{d}日 {sh}",
           keep_worse=False, always_hard=True)       # 二度解きでも、欠員は埋める前提で「何を破れば埋まるか」を測る
    for k in WORK_SHIFTS:
        if k != sh and k in need:
            H.post(f"r-staff-{k}", f"{k}は基準人数を下回らない", [(sid, d, {k}) for sid in base], ">=", need[k], f"{d}日 {k}")
    if b.vacancy.absent_staff_id:
        bd.m.add(bd.x[b.vacancy.absent_staff_id, d, OFF] == 1)   # 休む人は戻さない
    # 目的関数（_Build の既定を置き換える）: その日の強い希望（希望休・夜勤の医療的ケアなど） > 変わる勤務の数 > 月の公平さ（同点のときだけ）
    terms = [HARD_BROKEN_WEIGHT * (1 - v) for v, *_ in H.lits]
    terms += [(PENALTY[r.strength] if isinstance(r, (Staffing, Request)) else 1) * (1 - v) for v, r, _ in bd.insts]
    terms += [CHANGE_COST * (1 - bd.x[sid, d, row[d - 1] or OFF]) for sid, row in base.items()]
    bd.m.minimize(sum(terms))
    return bd, H


def _solve(bd: _Build, time_limit: float, workers: int):
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = time_limit
    s.parameters.num_workers = workers
    return s, s.solve(bd.m)


def replan_inline(b: InlineReplanIn, *, workers: int | None = None) -> dict:
    t0 = time.time()
    w = workers or DEFAULT_WORKERS
    fac, mo, rules, carry, base, orig = _prepare(b)
    d, sh = b.date, b.vacancy.shift
    out: dict = {"month": b.month, "date": d, "shift": sh, "fixed_other_days": True, "app_labor_rules": True,
                 "changes": [], "filled_by": [], "changed_cells": 0}
    bd, _ = _model(b, fac, mo, rules, carry, base, orig, relax=False)
    s, st = _solve(bd, min(b.time_limit, MAX_TIME), w)
    out["status"] = s.status_name(st)
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        cells = _cells(s, bd)
        moved = [(sid, day) for sid, row in cells.items() for day in range(1, mo.days + 1) if row[day - 1] != base[sid][day - 1]]
        if any(day != d for _, day in moved):          # 固定した日が動くことはない（念のための検査。通らなければ案を返さない）
            out.update(status="CHECK_FAILED", explanation=["固定した日が変わる案になったため、使いません。"], wall_ms=int((time.time() - t0) * 1000))
            return out
        out["changes"] = [{"staff_id": sid, "from": base[sid][d - 1], "to": cells[sid][d - 1]} for sid, _ in moved]
        out["filled_by"] = [c["staff_id"] for c in out["changes"] if c["to"] == sh]
        out["changed_cells"] = len(moved)
        out["minimal"] = st == cp_model.OPTIMAL
        out["soft_broken_on_day"] = [{"rule_id": x.rule_id, "label": x.label, "count": x.count, "detail": x.detail}
                                     for x in _aggregate(s, bd) if x.rule_id.startswith(("req-", "spare-", "r-night-medical", "r-event-"))]
        out["explanation"] = _explain_ok(out, d, sh)
    elif st == cp_model.INFEASIBLE or st == cp_model.MODEL_INVALID:
        spent = time.time() - t0
        bd2, H2 = _model(b, fac, mo, rules, carry, base, orig, relax=True)
        s2, st2 = _solve(bd2, max(1.0, min(b.time_limit, MAX_TIME) - spent), w)
        out["relax_status"] = s2.status_name(st2)
        rel: dict[str, Broken] = {}
        if st2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            for v, rid, label, det in H2.lits:
                if not s2.value(v):
                    k = rel.setdefault(rid, Broken(rid, label))
                    k.count += 1
                    if len(k.detail) < 3:
                        k.detail.append(det)
        out["relaxation"] = [{"rule_id": x.rule_id, "label": x.label, "count": x.count, "detail": x.detail} for x in rel.values()]
        out["explanation"] = _explain_ng(out, d, sh)
    else:
        out["explanation"] = [f"{d}日の組み直しは時間内に答えが出ませんでした。画面の案で進めてください。"]
    out["wall_ms"] = int((time.time() - t0) * 1000)
    return out


def _explain_ok(out: dict, d: int, sh: str) -> list[str]:
    n = out["changed_cells"]
    lines = [f"{d}日以外の勤務はすべてそのままにして、{d}日の勤務だけを組み直しました。変わる勤務は{n}件"
             + ("（これより少ない組み直しはありません）。" if out.get("minimal") else "（時間内の最良の案です）。")]
    for c in out["changes"]:
        lines.append(f"・{c['staff_id']}: {c['from'] or '休み'} → {c['to'] or '休み'}")
    lines.append("連続勤務（夜勤明けも数える）・夜勤明け・遅番のあとの早番・夜勤の上限・常勤の公休は、画面の労務チェックと同じ数え方で守っています。")
    for x in out.get("soft_broken_on_day", []):
        lines.append(f"・守りきれなかった希望: {x['label']}（{x['count']}件）")
    return lines


def _explain_ng(out: dict, d: int, sh: str) -> list[str]:
    lines = [f"{d}日の勤務だけを組み直しても、{sh}の欠員は今のルールのままでは埋まりません。"]
    rel = [x for x in out.get("relaxation", []) if x["rule_id"] != "r-vacancy"]
    if rel:
        lines.append("埋めるには、次のルールを破る必要があります。")
        lines += [f"・{x['label']}: {x['count']}件（例: {x['detail'][0]}）" if x["detail"] else f"・{x['label']}: {x['count']}件" for x in rel]
    else:
        lines.append("ルールを緩めても、この日に入れる職員がいません（打診や求人で探してください）。")
    return lines
