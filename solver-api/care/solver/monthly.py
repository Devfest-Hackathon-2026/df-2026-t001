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

from ..dsl import (OFF, PENALTY, PUBLIC_OFF, WORK_SHIFTS, Balance, Count, Facility, Month, Occurrence, Request,
                   RuleBase, StaffMember, Staffing, Succession)
from ..rule_label import occurrence_pattern_ja
from .coverage import Sig, hh, signatures

WORK_H = {"早番": 8, "日勤": 8, "遅番": 8, "夜勤": 13}   # 休憩を除く概算の勤務時間
COVERAGE_WEIGHT = PENALTY["強く"]
# 目標（公休など）の1日あたりのずれ罰点。
# できれば（1）より十分大きくして不要な人員増を抑えつつ、
# 1勤務の付け替えで2人の公休が同時にずれても（400×2=800）希望休（強く=1000）を優先できるよう 400 にする。
TARGET_PENALTY: dict[str, int] = {"強く": 400, "できれば": 1}
CHANGE_WEIGHT = 5
HARD_BROKEN_WEIGHT = 1_000_000
LOCKED_MULT = 10
DEFAULT_WORKERS = int(os.getenv("SOLVER_WORKERS", "8"))    # Cloud Run の vCPU 数に合わせる
RELAX_TIME = 8.0     # 二度解きの時間上限（秒）。最小の破りが証明できなくても、見つかった最良の案を返す
MIN_STAGE2_TIME = 0.2  # 2段目（前の表との差を最小化）を試みる最低残り時間（秒）


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
    max_dev: int | None = None


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
                 boost_skill: dict[int, dict[tuple[int, str], int]] | None = None,
                 history: dict[str, list[str]] | None = None):
        self.fac, self.month, self.rules, self.relax = fac, month, rules, relax
        self.staff = fac.staff
        self.N = month.days
        self.days = list(range(1, self.N + 1))
        self.m = cp_model.CpModel()
        self.x: dict[tuple[str, int, str], cp_model.IntVar] = {}
        self.insts: list[tuple[cp_model.IntVar, object, str]] = []      # (満たしたか, ルール, 詳細)
        self.devs: list[tuple[cp_model.IntVar, cp_model.IntVar, Count, str, int]] = []  # (超過, 不足, ルール, sid, 目標)
        self.shorts: list[tuple[cp_model.IntVar, int, int, str, bool]] = []   # (不足, 日, 代表枠, 詳細, 資格の不足か)
        self.carry = carry_in or {}
        self.history = {sid: list(seq) for sid, seq in (history or {}).items() if seq}
        self.shift_types = fac.effective_shift_types()
        self.work_ids = fac.work_shift_ids()
        self._ake_shifts = fac.ake_shift_ids()
        self.work_min = {st.id: st.work_minutes() for st in self.shift_types}
        self.ward_night_avg: tuple | None = None
        self._po_vars: dict[tuple[str, int], cp_model.IntVar] = {}
        self.occ_meta: dict[int, tuple[str, list[cp_model.IntVar], str]] = {}

        kinds = (*self.work_ids, OFF)
        has_default_interval = (not fac.shift_types) and any(
            isinstance(r, Succession) and r.id == "r-interval" for r in rules
        )
        for s in self.staff:
            for d in self.days:
                for k in kinds:
                    self.x[s.staff_id, d, k] = self.m.new_bool_var(f"x_{s.staff_id}_{d}_{k}")
                self.m.add_exactly_one(self.x[s.staff_id, d, k] for k in kinds)
                for k in self.work_ids:
                    if k not in s.shifts:
                        self.m.add(self.x[s.staff_id, d, k] == 0)   # 入れない勤務区分
            c = self._last_prev(s.staff_id)
            if c in self._ake_shifts:                                # 前月末の明け対象勤務
                for k in self.work_ids:
                    self.m.add(self.x[s.staff_id, 1, k] == 0)
            elif has_default_interval and c == "遅番" and "早番" in self.work_ids:
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
        if fac.ward_night_avg_max is not None:
            self._add_ward_night_avg()

        terms: list = []
        for v, r, _ in self.insts:
            w = self._weight(r)
            terms.append(w * (1 - v))
        for over, under, r, _, _ in self.devs:
            w = TARGET_PENALTY[r.strength]
            terms.append(w * (over + under))
        for sh, _, _, _, _ in self.shorts:
            terms.append(COVERAGE_WEIGHT * sh)
        if self.ward_night_avg is not None:
            _, _, _, _, _, excess_min, excess_h = self.ward_night_avg
            terms.append(PENALTY["強く"] * excess_h + excess_min)
        self.primary_terms: list = list(terms)
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

    def _last_prev(self, sid: str) -> str:
        h = self.history.get(sid)
        return h[-1] if h else self.carry.get(sid, "")

    def _is_ake(self, sid: str, d: int):
        if d <= 1:
            if d == 1:
                return 1 if self._last_prev(sid) in self._ake_shifts else 0
            h = self.history.get(sid)
            if not h:
                return 0
            idx = len(h) + d - 2
            return 1 if 0 <= idx < len(h) and h[idx] in self._ake_shifts else 0
        return sum(self.x[sid, d - 1, k] for k in self._ake_shifts)

    def _in(self, sid: str, d: int, kinds: list[str]):
        has_pub = PUBLIC_OFF in kinds
        has_off = OFF in kinds
        base_kinds = [k for k in kinds if k != PUBLIC_OFF]
        if d <= 0:
            h = self.history.get(sid)
            if not h:
                return 0
            idx = len(h) + d - 1
            if idx < 0:
                return 0
            val = h[idx] or OFF
            if has_pub and not has_off and val == OFF:
                prev_val = (h[idx - 1] or OFF) if idx > 0 else ""
                return 0 if prev_val in self._ake_shifts else 1
            return 1 if val in base_kinds else 0
        expr = sum(self.x[sid, d, k] for k in base_kinds)
        if has_pub and not has_off:
            ake = self._is_ake(sid, d)
            if isinstance(ake, int):
                if ake == 0:
                    expr = expr + self.x[sid, d, OFF]
            elif not self.relax:
                expr = expr + self.x[sid, d, OFF] - ake
            else:
                po = self.m.new_bool_var(f"po_{sid}_{d}_{len(self.insts)}_{len(self.devs)}")
                self.m.add(po <= self.x[sid, d, OFF])
                self.m.add(po <= 1 - ake)
                self.m.add(po >= self.x[sid, d, OFF] - ake)
                expr = expr + po
        return expr

    def _public_off_bool(self, sid: str, d: int):
        """d 日が公休（休かつ前日が明け対象でない）であることを表す 0/1 式またはキャッシュ済み BoolVar。"""
        if d == 1:
            return 0 if self._last_prev(sid) in self._ake_shifts else self.x[sid, 1, OFF]
        if not self._ake_shifts:
            return self.x[sid, d, OFF]
        cached = self._po_vars.get((sid, d))
        if cached is not None:
            return cached
        ake = sum(self.x[sid, d - 1, k] for k in self._ake_shifts)
        po = self.m.new_bool_var(f"pob_{sid}_{d}")
        self.m.add(po <= self.x[sid, d, OFF])
        self.m.add(po <= 1 - ake)
        self.m.add(po >= self.x[sid, d, OFF] - ake)
        self._po_vars[(sid, d)] = po
        return po

    def _in_bool(self, sid: str, d: int, kinds: list[str]):
        """add_min_equality に渡せる {0, 1} 保証つきの d 日勤務・休み一致式。"""
        has_pub = PUBLIC_OFF in kinds
        has_off = OFF in kinds
        base_kinds = [k for k in kinds if k != PUBLIC_OFF]
        expr = sum(self.x[sid, d, k] for k in base_kinds)
        if has_pub and not has_off:
            expr = expr + self._public_off_bool(sid, d)
        return expr

    @staticmethod
    def _en(c, lit):
        return c if lit is None else c.only_enforce_if(lit)

    # ------------------------------------------------------------ 5型
    def _add_staffing(self, r: Staffing):
        people, kinds = self._people(r.people), r.shifts.kinds(self.work_ids)
        for d in self._days(r.days):
            tot = sum(self._in(p.staff_id, d, kinds) for p in people)
            if r.at_least is not None:
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot >= r.at_least), lit), f"{d}日")
            if r.at_most is not None:
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= r.at_most), lit), f"{d}日")

    def _add_request(self, r: Request):
        kinds = r.shifts.kinds(self.work_ids)
        for p in self._people(r.people):
            for d in self._days(r.days):
                tot = self._in(p.staff_id, d, kinds)
                cond = (tot >= 1) if r.want else (tot == 0)
                self._post(r, lambda lit, cond=cond: self._en(self.m.add(cond), lit), f"{p.staff_id} {d}日")

    def _add_succession(self, r: Succession):
        people = self._people(r.people)
        act = set(self._act)
        if r.max_run is not None:
            n = r.max_run
            all_work = list(self.work_ids)
            for p in people:
                h = self.history.get(p.staff_id)
                if h and 1 in act:
                    s0 = max(1 - n, 1 - len(h))
                    for s in range(s0, min(1, self.N - n + 1)):
                        pre_sum = sum(self._in(p.staff_id, d, all_work) for d in range(s, 1))
                        if pre_sum <= -s:
                            continue  # 前月側に休みが含まれ当月分を全部勤務しても n 以下（自明）
                        tot = pre_sum + sum(self._in(p.staff_id, d, all_work) for d in range(1, s + n + 1))
                        self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= n), lit), f"{p.staff_id} 前月〜")
                for s in range(1, self.N - n + 1):
                    if s not in act:
                        continue
                    tot = sum(self._in(p.staff_id, s + i, all_work) for i in range(n + 1))
                    self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= n), lit), f"{p.staff_id} {s}日〜")
            return
        pats = [sel.kinds(self.work_ids) for sel in r.pattern]
        L = len(pats)
        for p in people:
            h = self.history.get(p.staff_id)
            if not h and L == 2 and self.carry.get(p.staff_id):
                h = [self.carry[p.staff_id]]
            if h and L >= 2 and 1 in act:
                s0 = max(2 - L, 1 - len(h))
                for s in range(s0, min(1, self.N - L + 2)):
                    pre_vals = []
                    for i, ks in enumerate(pats):
                        if s + i <= 0:
                            idx = len(h) + (s + i) - 1
                            val = (h[idx] or OFF) if 0 <= idx < len(h) else ""
                            pre_vals.append(1 if val in ks else 0)
                    if any(v == 0 for v in pre_vals):
                        continue  # 前月側が不成立（forbid は既に起きない／非 forbid は当月では満たせない）
                    tot = sum(
                        (1 if (((h[len(h) + s + i - 1] or OFF) in ks) if 0 <= len(h) + s + i - 1 < len(h) else False) else 0)
                        if s + i <= 0
                        else self._in(p.staff_id, s + i, ks)
                        for i, ks in enumerate(pats)
                    )
                    cond = (tot <= L - 1) if r.forbid else (tot >= L)
                    self._post(r, lambda lit, cond=cond: self._en(self.m.add(cond), lit), f"{p.staff_id} 前月〜")
            for s in range(1, self.N - L + 2):
                if s not in act:
                    continue
                tot = sum(self._in(p.staff_id, s + i, ks) for i, ks in enumerate(pats))
                cond = (tot <= L - 1) if r.forbid else (tot >= L)
                self._post(r, lambda lit, cond=cond: self._en(self.m.add(cond), lit), f"{p.staff_id} {s}日〜")

    def _count_expr(self, sid: str, kinds: list[str], days: list[int], unit: str):
        if unit == "回":
            return sum(self._in(sid, d, kinds) for d in days)
        return sum(self.x[sid, d, k] * self.work_min[k] for d in days for k in kinds if k in self.work_min)

    def _add_count(self, r: Count):
        kinds, days = r.shifts.kinds(self.work_ids), self._days(r.days)
        scale = 60 if r.unit == "時間" else 1
        for p in self._people(r.people):
            tot = self._count_expr(p.staff_id, kinds, days, r.unit)
            if r.at_least is not None:
                lo = int(round(r.at_least * scale))
                self._post(r, lambda lit, tot=tot, lo=lo: self._en(self.m.add(tot >= lo), lit), p.staff_id)
            if r.at_most is not None:
                hi = int(round(r.at_most * scale))
                self._post(r, lambda lit, tot=tot, hi=hi: self._en(self.m.add(tot <= hi), lit), p.staff_id)
            if r.target is not None:
                tg = int(round(r.target * scale))
                ub = max(tg, len(days) * (24 * 60 if r.unit == "時間" else 1))
                over = self.m.new_int_var(0, ub, f"ov_{r.id}_{p.staff_id}")
                under = self.m.new_int_var(0, ub, f"un_{r.id}_{p.staff_id}")
                self.m.add(tot - tg == over - under)
                self.devs.append((over, under, r, p.staff_id, int(r.target)))

    def _add_balance(self, r: Balance):
        kinds = r.shifts.kinds(self.work_ids)
        people = r.members(self.staff, self.work_ids)
        days = self._days(r.days)
        if len(people) < 2 or not days:
            return
        mx = self.m.new_int_var(0, len(days), f"mx_{r.id}")
        mn = self.m.new_int_var(0, len(days), f"mn_{r.id}")
        for p in people:
            c = self._count_expr(p.staff_id, kinds, days, "回")
            self.m.add(mx >= c)
            self.m.add(mn <= c)
        self._post(r, lambda lit: self._en(self.m.add(mx - mn <= r.max_spread), lit), "")

    def _add_occurrence(self, r: Occurrence):
        pats = [sel.kinds(self.work_ids) for sel in r.pattern]
        L = len(pats)
        start_days = [d for d in self._days(r.starts) if d + L - 1 <= self.N]
        for p in self._people(r.people):
            hits: list[cp_model.IntVar] = []
            for d in start_days:
                hit = self.m.new_bool_var(f"occ_{r.id}_{p.staff_id}_{d}_{len(self.occ_meta)}")
                self.m.add_min_equality(hit, [self._in_bool(p.staff_id, d + i, ks) for i, ks in enumerate(pats)])
                hits.append(hit)
            tot = sum(hits) if hits else 0
            if r.at_least is not None:
                before = len(self.insts)
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot >= r.at_least), lit), p.staff_id)
                if len(self.insts) > before:
                    self.occ_meta[len(self.insts) - 1] = (p.name, hits, f"{r.at_least}回以上")
            if r.at_most is not None:
                before = len(self.insts)
                self._post(r, lambda lit, tot=tot: self._en(self.m.add(tot <= r.at_most), lit), p.staff_id)
                if len(self.insts) > before:
                    self.occ_meta[len(self.insts) - 1] = (p.name, hits, f"{r.at_most}回以下")

    # ------------------------------------------------------------ 72時間ルール（病棟の月平均夜勤時間数）
    def _add_ward_night_avg(self):
        cap_h = self.fac.ward_night_avg_max
        if cap_h is None:
            return
        win = self.fac.night_window
        ov_min = {
            st.id: st.night_overlap_minutes(win.start, win.hours)
            for st in self.shift_types
            if st.group == "夜勤系" and st.counts
        }
        ov_min = {k: v for k, v in ov_min.items() if v > 0}
        if not ov_min:
            return
        cap_min = cap_h * 60
        thresh_min = max(1, self.fac.night_worker_min_h * 60)
        max_person_min = self.N * max(ov_min.values())
        h_vars: list[cp_model.IntVar] = []
        y_vars: list[cp_model.IntVar] = []
        eff_vars: list[cp_model.IntVar] = []
        for s in self.staff:
            sid = s.staff_id
            h_var = self.m.new_int_var(0, max_person_min, f"nh_{sid}")
            h_expr = sum(self.x[sid, d, k] * v for d in self.days for k, v in ov_min.items())
            self.m.add(h_var == h_expr)
            y_var = self.m.new_bool_var(f"nw_{sid}")
            self.m.add(h_var >= thresh_min).only_enforce_if(y_var)
            self.m.add(h_var <= thresh_min - 1).only_enforce_if(y_var.Not())
            eff_var = self.m.new_int_var(0, max_person_min, f"nhe_{sid}")
            self.m.add(eff_var == h_var).only_enforce_if(y_var)
            self.m.add(eff_var == 0).only_enforce_if(y_var.Not())
            h_vars.append(h_var)
            y_vars.append(y_var)
            eff_vars.append(eff_var)
        max_tot = max_person_min * max(1, len(self.staff))
        excess_min = self.m.new_int_var(0, max_tot, "night_avg_excess_min")
        self.m.add(sum(eff_vars) - cap_min * sum(y_vars) <= excess_min)
        excess_h = self.m.new_int_var(0, max_tot // 60 + 1, "night_avg_excess_h")
        self.m.add(60 * excess_h >= excess_min)
        self.ward_night_avg = (cap_min, ov_min, h_vars, y_vars, eff_vars, excess_min, excess_h)

    # ------------------------------------------------------------ 集約制約（日課 → 時間帯の必要人数）
    def _add_coverage(self, templates, boost: dict[int, dict[int, int]], boost_skill: dict[int, dict[tuple[int, str], int]]):
        cov = CoverageRule(id="coverage", label="日課から導いた時間帯ごとの必要人数",
                           origin={"kind": "日課から導出"})  # type: ignore[arg-type]
        self.cov_rule = cov
        for d in self.days:
            sigs = signatures(templates, boost.get(d), boost_skill.get(d), self.shift_types)
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
            row.append(next((k for k in b.work_ids if solver.value(b.x[s.staff_id, d, k])), ""))
        out[s.staff_id] = row
    return out


def _aggregate(solver, b: _Build) -> list[Broken]:
    agg: dict[str, Broken] = {}
    shift_names = {st.id: st.name for st in b.shift_types} if b.occ_meta else None
    for idx, (v, r, det) in enumerate(b.insts):
        if not solver.value(v):
            k = agg.setdefault(r.id, Broken(r.id, r.label))
            k.count += 1
            if len(k.detail) < 3:
                if idx in b.occ_meta:
                    pname, hits, bound_str = b.occ_meta[idx]
                    actual = sum(solver.value(h) for h in hits)
                    what = occurrence_pattern_ja(r, shift_names=shift_names, work_ids=b.work_ids)
                    k.detail.append(f"{pname}さんの『{what}』が月{actual}回（{bound_str}）")
                elif det:
                    k.detail.append(det)
    for over, under, r, sid, target in b.devs:
        raw_dev = solver.value(over) + solver.value(under)
        if raw_dev > 0:
            dev = (raw_dev + 59) // 60 if r.unit == "時間" else raw_dev
            k = agg.setdefault(r.id, Broken(r.id, r.label))
            k.count += 1
            k.max_dev = max(k.max_dev or 0, dev)
            if len(k.detail) < 3:
                unit_lbl = "日" if r.unit == "回" else "時間"
                what = "公休" if r.shifts.ids == [PUBLIC_OFF] else "回数"
                k.detail.append(f"{sid}さんの{what}（目標{target}{unit_lbl}）が{dev}{unit_lbl}ずれ")
    if b.ward_night_avg is not None:
        _, _, _, y_vars, eff_vars, excess_min, _ = b.ward_night_avg
        ex_m = solver.value(excess_min)
        if ex_m > 0:
            workers = sum(solver.value(y) for y in y_vars)
            tot_m = sum(solver.value(e) for e in eff_vars)
            cap_h = b.fac.ward_night_avg_max or 72
            avg_h = (tot_m / 60.0) / workers if workers else 0.0
            over_h = max(0.0, avg_h - cap_h)
            agg["r-ward-night-avg"] = Broken(
                "r-ward-night-avg",
                f"病棟の月平均夜勤時間（上限{cap_h}時間）",
                count=max(1, int(round(over_h))),
                detail=[f"月平均{avg_h:.1f}時間（上限{cap_h}時間を{over_h:.1f}時間超過、対象{workers}人）"],
            )
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


def _norm_cell(v: str) -> str:
    return "" if v in ("", OFF) else v


def _diff_count(baseline: dict[str, list[str]], cells: dict[str, list[str]], days: int) -> int:
    total = 0
    for sid, row in cells.items():
        brow = baseline.get(sid)
        if brow is None:
            continue
        for d in range(min(days, len(row), len(brow))):
            if _norm_cell(brow[d]) != _norm_cell(row[d]):
                total += 1
    return total


def _apply_baseline_hints(bd: _Build, baseline: dict[str, list[str]]) -> None:
    bd.m.clear_hints()
    for s in bd.staff:
        row = baseline.get(s.staff_id)
        if not row:
            continue
        for d in bd.days:
            if d - 1 >= len(row):
                continue
            bk = _norm_cell(row[d - 1]) or OFF
            var = bd.x.get((s.staff_id, d, bk))
            if var is not None:
                bd.m.add_hint(var, 1)


def solve_two_stage(
    bd: _Build,
    baseline: dict[str, list[str]],
    *,
    time_limit: float,
    workers: int,
    seed: int = 0,
) -> tuple[str, dict[str, list[str]], list[Broken], float | None, list[tuple[int, int, int]], dict]:
    """2段求解: 1段目で本来の目的関数を最適化し、2段目でその罰点を超えない範囲で前の表からの変化を最小化する。"""
    t0 = time.time()
    _apply_baseline_hints(bd, baseline)
    s1 = cp_model.CpSolver()
    s1.parameters.max_time_in_seconds = time_limit
    s1.parameters.random_seed = seed
    s1.parameters.num_workers = workers
    st1 = s1.solve(bd.m)
    stage1_ms = int((time.time() - t0) * 1000)
    st1_name = s1.status_name(st1)
    if st1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return st1_name, {}, [], None, [], {"stage1_ms": stage1_ms}

    cells1 = _cells(s1, bd)
    broken1 = _aggregate(s1, bd)
    obj1 = int(round(s1.objective_value)) if bd.primary_terms else 0
    sf1 = [(d, slot, s1.value(sh)) for sh, d, slot, _, skill in bd.shorts if s1.value(sh) and not skill]
    diff1 = _diff_count(baseline, cells1, bd.N)
    extra: dict = {
        "stage1_ms": stage1_ms,
        "primary_objective": obj1,
        "stage1_changed": diff1,
    }
    if diff1 == 0:
        extra.update(stage2_status="SKIPPED_ZERO", stage2_changed=0, baseline_timeout=False)
        return st1_name, cells1, broken1, float(obj1), sf1, extra

    rem = time_limit - (time.time() - t0)
    if rem < MIN_STAGE2_TIME:
        extra.update(stage2_status="TIMEOUT", baseline_timeout=True)
        return st1_name, cells1, broken1, float(obj1), sf1, extra

    diff_terms = []
    for s in bd.staff:
        row = baseline.get(s.staff_id)
        if not row:
            continue
        for d in bd.days:
            if d - 1 >= len(row):
                continue
            bk = _norm_cell(row[d - 1]) or OFF
            var = bd.x.get((s.staff_id, d, bk))
            if var is not None:
                diff_terms.append(1 - var)
    if not diff_terms:
        extra.update(stage2_status="SKIPPED_NO_TERMS", baseline_timeout=False)
        return st1_name, cells1, broken1, float(obj1), sf1, extra

    if bd.primary_terms:
        bd.m.add(sum(bd.primary_terms) <= obj1)
    bd.m.minimize(sum(diff_terms))
    _apply_baseline_hints(bd, baseline)
    t1 = time.time()
    s2 = cp_model.CpSolver()
    s2.parameters.max_time_in_seconds = rem
    s2.parameters.random_seed = seed
    s2.parameters.num_workers = workers
    st2 = s2.solve(bd.m)
    extra["stage2_ms"] = int((time.time() - t1) * 1000)
    extra["stage2_status"] = s2.status_name(st2)
    if st2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        cells2 = _cells(s2, bd)
        diff2 = _diff_count(baseline, cells2, bd.N)
        if diff2 <= diff1:
            sf2 = [(d, slot, s2.value(sh)) for sh, d, slot, _, skill in bd.shorts if s2.value(sh) and not skill]
            extra.update(stage2_changed=diff2, baseline_timeout=False)
            return st1_name, cells2, _aggregate(s2, bd), float(obj1), sf2, extra

    extra["baseline_timeout"] = True
    return st1_name, cells1, broken1, float(obj1), sf1, extra


def solve_monthly(fac: Facility, month: Month, rules: list, *, fixed: dict[str, dict[int, str]] | None = None,
                  carry_in: dict[str, str] | None = None, boost: dict[int, dict[int, int]] | None = None,
                  boost_skill: dict[int, dict[tuple[int, str], int]] | None = None,
                  baseline: dict[str, list[str]] | None = None, use_coverage: bool = True,
                  time_limit: float = 20.0, seed: int = 0, workers: int = DEFAULT_WORKERS,
                  history: dict[str, list[str]] | None = None, two_stage: bool = False) -> MonthlyResult:
    """月次の勤務表を解く。解けなければ破れ量（relaxation）を返す。

    fixed:     {staff_id: {日: 勤務}} 確定済みのセル
    boost:     {日: {枠: 追加人数}} 日次で足りなかった時間帯を月次へ戻す
    boost_skill: {日: {(枠, 資格): 追加人数}} 日次で資格者が足りなかった分
    baseline:  欠員補充などで、変更を最小にしたいときの元の表
    history:   {staff_id: [勤務, ...]} 前月末の割り当て（最大7日分、古い順）
    two_stage: True かつ baseline ありのとき、1段目の目的値を保ったまま 2段目で変更を最小化する
    """
    t0 = time.time()
    if two_stage and baseline is not None:
        b = _Build(fac, month, rules, fixed=fixed, carry_in=carry_in, relax=False, boost=boost, baseline=None,
                   use_coverage=use_coverage, boost_skill=boost_skill, history=history)
        st1_name, cells, broken, obj, sf, extra = solve_two_stage(
            b, baseline, time_limit=time_limit, workers=workers, seed=seed
        )
        res = MonthlyResult(
            status=st1_name,
            wall_ms=int((time.time() - t0) * 1000),
            stats={"vars": len(b.x), "instances": len(b.insts), "coverage_terms": len(b.shorts), **extra},
        )
        if st1_name in ("OPTIMAL", "FEASIBLE") and cells:
            res.cells = cells
            res.soft_broken = broken
            res.objective = obj
            res.shortfalls = sf
            return res

        b2 = _Build(fac, month, rules, fixed=fixed, carry_in=carry_in, relax=True, boost=boost, baseline=None,
                    use_coverage=use_coverage, boost_skill=boost_skill, history=history)
        res.stats["first_ms"] = int((time.time() - t0) * 1000)
        st2_name, r_cells, r_broken, _, _, r_extra = solve_two_stage(
            b2, baseline, time_limit=min(time_limit, RELAX_TIME), workers=workers, seed=seed
        )
        res.stats["relax_status"] = st2_name
        res.stats["baseline_timeout"] = r_extra.get("baseline_timeout", False)
        if st2_name in ("OPTIMAL", "FEASIBLE") and r_cells:
            res.relaxation = r_broken
            res.cells = r_cells
        res.wall_ms = int((time.time() - t0) * 1000)
        return res

    b = _Build(fac, month, rules, fixed=fixed, carry_in=carry_in, relax=False, boost=boost, baseline=baseline,
               use_coverage=use_coverage, boost_skill=boost_skill, history=history)
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
                use_coverage=use_coverage, boost_skill=boost_skill, history=history)
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
