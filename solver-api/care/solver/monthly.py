"""月次シフトの CP-SAT。

* 勤務区分ごとの人数・休み・連なり・回数などは DSL（5型）のルールから組み立てる。
* 日課テンプレートから導いた「時間帯ごとの必要人数」を集約制約として入れる。
  これで日次（時間帯別の業務割当）が解ける月次案になりやすい。
* 絶対のルールは硬制約。強く/できれば は罰点つきの軟制約。
* 解けないときは、絶対のルールを全部軟にして「どのルールを何件破れば通るか」を測る（二度解き）。
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from ..dsl import (OFF, PENALTY, WORK_SHIFTS, Balance, Count, Facility, Month, Request, RuleBase, StaffMember,
                   Staffing, Succession)
from .coverage import Sig, hh, signatures

WORK_H = {"早番": 8, "日勤": 8, "遅番": 8, "夜勤": 13}   # 休憩を除く概算の勤務時間
COVERAGE_WEIGHT = PENALTY["強く"]
CHANGE_WEIGHT = 5
HARD_BROKEN_WEIGHT = 1_000_000
LOCKED_MULT = 10
DEFAULT_WORKERS = int(os.getenv("SOLVER_WORKERS", "8"))    # Cloud Run の vCPU 数に合わせる
RELAX_TIME = 8.0     # 二度解きの時間上限（秒）。最小の破りが証明できなくても、見つかった最良の案を返す


class CoverageRule(RuleBase):
    """日課から導いた必要人数。ルール一覧には出ないが、破れの説明には出す。"""
    type: str = "coverage"
    strength: str = "強く"


@dataclass
class Broken:
    rule_id: str
    label: str
    count: int = 0                   # 破れたインスタンス数（coverage は不足人数の合計）
    detail: list[str] = field(default_factory=list)


@dataclass
class MonthlyResult:
    status: str                      # OPTIMAL / FEASIBLE / INFEASIBLE / UNKNOWN
    cells: dict[str, list[str]] = field(default_factory=dict)      # staff_id -> 日ごと（空文字=休）
    soft_broken: list[Broken] = field(default_factory=list)
    relaxation: list[Broken] = field(default_factory=list)         # 不充足のとき: 破れ量
    shortfalls: list[tuple[int, int, int]] = field(default_factory=list)   # (日, 枠, 不足人数) 日次へ戻すための情報
    objective: float | None = None
    wall_ms: int = 0
    stats: dict = field(default_factory=dict)


class _Build:
    def __init__(self, fac: Facility, month: Month, rules: list, *, fixed: dict[str, dict[int, str]] | None,
                 carry_in: dict[str, str] | None, relax: bool, boost: dict[int, dict[int, int]] | None,
                 baseline: dict[str, list[str]] | None, use_coverage: bool,
                 boost_skill: dict[int, dict[tuple[int, str], int]] | None = None):
        self.fac, self.month, self.rules, self.relax = fac, month, rules, relax
        self.staff = fac.staff
        self.N = month.days
        self.days = list(range(1, self.N + 1))
        self.m = cp_model.CpModel()
        self.x: dict[tuple[str, int, str], cp_model.IntVar] = {}
        self.insts: list[tuple[cp_model.IntVar, object, str]] = []      # (満たしたか, ルール, 詳細)
        self.shorts: list[tuple[cp_model.IntVar, int, int, str, bool]] = []   # (不足, 日, 代表枠, 詳細, 資格の不足か)
        self.carry = carry_in or {}

        kinds = (*WORK_SHIFTS, OFF)
        for s in self.staff:
            for d in self.days:
                for k in kinds:
                    self.x[s.staff_id, d, k] = self.m.new_bool_var(f"x_{s.staff_id}_{d}_{k}")
                self.m.add_exactly_one(self.x[s.staff_id, d, k] for k in kinds)
                for k in WORK_SHIFTS:
                    if k not in s.shifts:
                        self.m.add(self.x[s.staff_id, d, k] == 0)   # 入れない勤務区分
            c = self.carry.get(s.staff_id)
            if c == "夜勤":                                          # 前月末の夜勤の明け
                for k in WORK_SHIFTS:
                    self.m.add(self.x[s.staff_id, 1, k] == 0)
            elif c == "遅番":
                self.m.add(self.x[s.staff_id, 1, "早番"] == 0)
        for sid, row in (fixed or {}).items():
            for d, k in row.items():
                self.m.add(self.x[sid, d, k] == 1)

        for r in rules:
            self._act = [d for d in self.days if month.active(r, d)]     # 期限つきルールは期限の日まで（停止は全日なし）
            if not self._act:
                continue
            getattr(self, f"_add_{r.type}")(r)
        self._act = list(self.days)
        if use_coverage and fac.templates:
            self._add_coverage(fac.templates, boost or {}, boost_skill or {})

        terms: list = []
        for v, r, _ in self.insts:
            w = self._weight(r)
            terms.append(w * (1 - v))
        for sh, _, _, _, _ in self.shorts:
            terms.append(COVERAGE_WEIGHT * sh)
        if baseline:
            for sid, row in baseline.items():
                for d, k in enumerate(row[: self.N], start=1):
                    terms.append(CHANGE_WEIGHT * (1 - self.x[sid, d, k or OFF]))
        if terms:
            self.m.minimize(sum(terms))

    # ------------------------------------------------------------ 補助
    def _weight(self, r) -> int:
        if r.strength == "絶対":
            return HARD_BROKEN_WEIGHT * (LOCKED_MULT if r.locked else 1)
        return PENALTY[r.strength]

    def _post(self, rule, add, detail: str = ""):
        """絶対は硬制約。それ以外（と二度解き）は満たしたかの変数をつけて目的関数へ。"""
        if rule.strength == "絶対" and not self.relax:
            add(None)
            return
        v = self.m.new_bool_var(f"lit_{rule.id}_{len(self.insts)}")
        add(v)
        self.insts.append((v, rule, detail))

    def _people(self, sel) -> list[StaffMember]:
        return [s for s in self.staff if sel.match(s)]

    def _days(self, sel) -> list[int]:
        """日付群のうち、いま組み立て中のルールが効く日（期限内）だけ。"""
        act = set(getattr(self, "_act", self.days))
        return [d for d in self.days if d in act and sel.match(d, self.month.weekday(d))]

    def _in(self, sid: str, d: int, kinds: list[str]):
        return sum(self.x[sid, d, k] for k in kinds)

    @staticmethod
    def _en(c, lit):
        return c if lit is None else c.only_enforce_if(lit)

    # ------------------------------------------------------------ 5型
    def _add_staffing(self, r: Staffing):
        people, kinds = self._people(r.people), r.shifts.kinds()
        for d in self._days(r.days):
            tot = sum(self._in(p.staff_id, d, kinds) for p in people)
            if r.at_least is not None:
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot >= r.at_least), lit), f"{d}日")
            if r.at_most is not None:
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= r.at_most), lit), f"{d}日")

    def _add_request(self, r: Request):
        kinds = r.shifts.kinds()
        for p in self._people(r.people):
            for d in self._days(r.days):
                tot = self._in(p.staff_id, d, kinds)
                cond = (tot >= 1) if r.want else (tot == 0)
                self._post(r, lambda lit, cond=cond: self._en(self.m.add(cond), lit), f"{p.staff_id} {d}日")

    def _add_succession(self, r: Succession):
        people = self._people(r.people)
        if r.max_run is not None:
            n = r.max_run
            for p in people:
                for s in range(1, self.N - n + 1):
                    if s not in self._act:
                        continue
                    tot = sum(self._in(p.staff_id, s + i, list(WORK_SHIFTS)) for i in range(n + 1))
                    self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= n), lit), f"{p.staff_id} {s}日〜")
            return
        pats = [sel.kinds() for sel in r.pattern]
        L = len(pats)
        for p in people:
            for s in range(1, self.N - L + 2):
                if s not in self._act:
                    continue
                tot = sum(self._in(p.staff_id, s + i, ks) for i, ks in enumerate(pats))
                cond = (tot <= L - 1) if r.forbid else (tot >= L)
                self._post(r, lambda lit, cond=cond: self._en(self.m.add(cond), lit), f"{p.staff_id} {s}日〜")

    def _count_expr(self, sid: str, kinds: list[str], days: list[int], unit: str):
        if unit == "回":
            return sum(self._in(sid, d, kinds) for d in days)
        return sum(self.x[sid, d, k] * WORK_H[k] for d in days for k in kinds if k in WORK_H)

    def _add_count(self, r: Count):
        kinds, days = r.shifts.kinds(), self._days(r.days)
        for p in self._people(r.people):
            tot = self._count_expr(p.staff_id, kinds, days, r.unit)
            if r.at_least is not None:
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot >= int(r.at_least)), lit), p.staff_id)
            if r.at_most is not None:
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= int(r.at_most)), lit), p.staff_id)

    def _add_balance(self, r: Balance):
        kinds = r.shifts.kinds()
        people = self._people(r.people)
        if len(people) < 2:
            return
        mx = self.m.new_int_var(0, self.N, f"mx_{r.id}")
        mn = self.m.new_int_var(0, self.N, f"mn_{r.id}")
        for p in people:
            c = self._count_expr(p.staff_id, kinds, self._act, "回")
            self.m.add(mx >= c)
            self.m.add(mn <= c)
        self._post(r, lambda lit: self._en(self.m.add(mx - mn <= r.max_spread), lit), "")

    # ------------------------------------------------------------ 集約制約（日課 → 時間帯の必要人数）
    def _add_coverage(self, templates, boost: dict[int, dict[int, int]], boost_skill: dict[int, dict[tuple[int, str], int]]):
        cov = CoverageRule(id="coverage", label="日課から導いた時間帯ごとの必要人数",
                           origin={"kind": "日課から導出"})  # type: ignore[arg-type]
        self.cov_rule = cov
        for d in self.days:
            sigs = signatures(templates, boost.get(d), boost_skill.get(d))
            for sg in sigs:
                need = sg.need
                if need <= 0 and not sg.skills:
                    continue
                on = []
                end_h = (max(sg.slots) + 1) / 2
                for s in self.staff:
                    sid = s.staff_id
                    if s.leave_by and hh(s.leave_by) < end_h:
                        continue          # 退勤上限より後ろまで続く時間帯には数えない（日次より甘くしない）
                    for k in sg.today:
                        on.append((s, self.x[sid, d, k]))
                    if d > 1:
                        for k in sg.prev:
                            on.append((s, self.x[sid, d - 1, k]))
                    elif self.carry.get(sid) in sg.prev:
                        on.append((s, 1))
                tot = sum(v for _, v in on)
                if need > 0:
                    sh = self.m.new_int_var(0, need, f"cov_{d}_{sg.slots[0]}")
                    self.m.add(tot + sh >= need)
                    self.shorts.append((sh, d, sg.slots[0], f"{d}日 {sg.label} 必要{need}人", False))
                for skill, n in sg.skills.items():
                    sk = sum(v for s, v in on if skill in s.skills)
                    sh = self.m.new_int_var(0, n, f"covs_{d}_{sg.slots[0]}_{skill}")
                    self.m.add(sk + sh >= n)
                    self.shorts.append((sh, d, sg.slots[0], f"{d}日 {sg.label} {skill}が{n}人", True))


def _cells(solver, b: _Build) -> dict[str, list[str]]:
    out = {}
    for s in b.staff:
        row = []
        for d in b.days:
            row.append(next((k for k in WORK_SHIFTS if solver.value(b.x[s.staff_id, d, k])), ""))
        out[s.staff_id] = row
    return out


def _aggregate(solver, b: _Build) -> list[Broken]:
    agg: dict[str, Broken] = {}
    for v, r, det in b.insts:
        if not solver.value(v):
            k = agg.setdefault(r.id, Broken(r.id, r.label))
            k.count += 1
            if len(k.detail) < 3 and det:
                k.detail.append(det)
    short_total = 0
    for sh, d, slot, det, _skill in b.shorts:
        n = solver.value(sh)
        if n:
            k = agg.setdefault("coverage", Broken("coverage", "日課から導いた時間帯ごとの必要人数"))
            k.count += n
            short_total += n
            if len(k.detail) < 3:
                k.detail.append(f"{det}（{n}人不足）")
    return sorted(agg.values(), key=lambda x: -x.count)


def solve_monthly(fac: Facility, month: Month, rules: list, *, fixed: dict[str, dict[int, str]] | None = None,
                  carry_in: dict[str, str] | None = None, boost: dict[int, dict[int, int]] | None = None,
                  boost_skill: dict[int, dict[tuple[int, str], int]] | None = None,
                  baseline: dict[str, list[str]] | None = None, use_coverage: bool = True,
                  time_limit: float = 20.0, seed: int = 0, workers: int = DEFAULT_WORKERS) -> MonthlyResult:
    """月次の勤務表を解く。解けなければ破れ量（relaxation）を返す。

    fixed:    {staff_id: {日: 勤務}} 確定済みのセル
    boost:    {日: {枠: 追加人数}} 日次で足りなかった時間帯を月次へ戻す
    boost_skill: {日: {(枠, 資格): 追加人数}} 日次で資格者が足りなかった分
    baseline: 欠員補充などで、変更を最小にしたいときの元の表
    """
    t0 = time.time()
    b = _Build(fac, month, rules, fixed=fixed, carry_in=carry_in, relax=False, boost=boost, baseline=baseline,
               use_coverage=use_coverage, boost_skill=boost_skill)
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = time_limit
    s.parameters.random_seed = seed
    s.parameters.num_workers = workers
    st = s.solve(b.m)
    res = MonthlyResult(status=s.status_name(st), wall_ms=int((time.time() - t0) * 1000),
                        stats={"vars": len(b.x), "instances": len(b.insts), "coverage_terms": len(b.shorts)})
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        res.cells = _cells(s, b)
        res.soft_broken = _aggregate(s, b)
        res.objective = s.objective_value
        res.shortfalls = [(d, slot, s.value(sh)) for sh, d, slot, _, skill in b.shorts if s.value(sh) and not skill]
        res.wall_ms = int((time.time() - t0) * 1000)
        return res

    # 二度解き: 絶対のルールを全部軟にして、最小で何件破れば通るかを測る
    b2 = _Build(fac, month, rules, fixed=fixed, carry_in=carry_in, relax=True, boost=boost, baseline=None,
                use_coverage=use_coverage, boost_skill=boost_skill)
    s2 = cp_model.CpSolver()
    s2.parameters.max_time_in_seconds = min(time_limit, RELAX_TIME)
    s2.parameters.num_workers = workers
    res.stats["first_ms"] = int((time.time() - t0) * 1000)
    st2 = s2.solve(b2.m)
    res.stats["relax_status"] = s2.status_name(st2)
    if st2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        res.relaxation = [x for x in _aggregate(s2, b2)]
        res.cells = _cells(s2, b2)             # 参考表示用（制約を破っている）
    res.wall_ms = int((time.time() - t0) * 1000)
    return res
