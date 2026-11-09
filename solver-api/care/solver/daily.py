"""日次スケジュール（時間帯別の業務割当）の CP-SAT。

月次で決まった「その日に誰がどの勤務か」を前提に、1日（00:00〜24:00、30分刻み）を解く。
* 日課テンプレートの業務を「枠×人数」の単位（duty）に分け、在席していて資格のある人に割り当てる。
* 同じ人の業務は重ならない。休憩は人ごとに時間窓の中で1回。
* 足りない業務は unmet として残し、原因（在席不足・資格者なし）と不足枠を返す。
  不足枠は月次へ戻して必要人数を引き上げるのに使う（loop.py）。
* 担当の継続性（同じ業務の連続枠は同じ人）・業務量の偏り・日次ルール（TaskRequest）は軟制約。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from .. import vocab
from ..dsl import PENALTY, OFF, WORK_SHIFTS, Facility, Month, StaffMember, TaskRequest, TaskTemplate
from .monthly import DEFAULT_WORKERS
from .coverage import SKIP_TASKS, SLOTS, hh, presence, skill_need, slot_label, slots_of

UNMET_WEIGHT = 100_000
CONTINUITY_REWARD = 3
LOAD_WEIGHT = 5
BREAK_LEN = {"早番": 2, "日勤": 2, "遅番": 2}                 # 枠（30分）
BREAK_START = {"早番": (22, 27), "日勤": (24, 29), "遅番": (30, 36)}   # [開始枠の範囲)
NIGHT_BREAK_LEN, NIGHT_BREAK_START = 4, (4, 11)               # 前日の夜勤: 02:00〜05:30 開始
LONG_CHUNK = 4                                                  # これを超える窓は1時間（2枠）ずつに分ける


@dataclass
class Duty:
    idx: int
    template_id: str
    task: str
    chunk: int
    unit: int
    start: int
    end: int                  # 枠（終了を含まない）
    skill: str | None

    @property
    def label(self) -> str:
        return f"{slot_label(self.start)}〜{slot_label(self.end) if self.end < SLOTS else '24:00'}"


@dataclass
class OnDuty:
    staff: StaffMember
    shift: str
    prev_day: bool            # 前日に始まった夜勤の明け
    slots: frozenset[int]


@dataclass
class DailyResult:
    status: str
    assignments: list[dict] = field(default_factory=list)   # {staff_id, task, template_id, start, end}
    breaks: list[dict] = field(default_factory=list)        # {staff_id, start, end}
    unmet: list[dict] = field(default_factory=list)         # {template_id, task, start, end, skill, cause}
    shortfall: dict[int, int] = field(default_factory=dict)  # 枠 -> 不足人数（資格を問わない業務。月次へ戻す情報）
    skill_shortfall: dict[tuple[int, str], int] = field(default_factory=dict)  # (枠, 資格) -> 不足人数
    load: dict[str, int] = field(default_factory=dict)      # staff_id -> 業務枠の合計
    switches: int = 0
    wall_ms: int = 0
    stats: dict = field(default_factory=dict)


def on_duty(fac: Facility, month: Month, cells: dict[str, list[str]], day: int,
            carry_in: dict[str, str] | None = None) -> list[OnDuty]:
    """運用日 day に在席する人。退勤上限（leave_by）があれば在席枠を切り詰める。"""
    out: list[OnDuty] = []
    for s in fac.staff:
        row = cells.get(s.staff_id, [])
        today = row[day - 1] if day - 1 < len(row) else ""
        prev = row[day - 2] if day >= 2 else (carry_in or {}).get(s.staff_id, "")
        cand = []
        if today in WORK_SHIFTS:
            cand.append((today, False, presence(today, False)))
        if prev == "夜勤":
            cand.append((prev, True, presence(prev, True)))
        for sh, pv, sl in cand:
            if s.leave_by:
                lim = int(hh(s.leave_by) * 2)
                sl = frozenset(k for k in sl if k < lim)
            if sl:
                out.append(OnDuty(s, sh, pv, sl))
    return out


def build_duties(templates: list[TaskTemplate]) -> list[Duty]:
    duties: list[Duty] = []
    for t in templates:
        if t.task in SKIP_TASKS:
            continue
        r = slots_of(t)
        a, b = r.start, r.stop
        step = (b - a) if (b - a) <= LONG_CHUNK else 2
        chunks = [(x, min(x + step, b)) for x in range(a, b, step)]
        for ci, (x, y) in enumerate(chunks):
            for u in range(t.headcount):
                duties.append(Duty(len(duties), t.template_id, t.task, ci, u, x, y,
                                   t.skill if (t.skill and u < skill_need(t)) else None))
    return duties


def solve_daily(fac: Facility, month: Month, cells: dict[str, list[str]], day: int, *,
                carry_in: dict[str, str] | None = None, rules: list[TaskRequest] | None = None,
                time_limit: float = 10.0, seed: int = 0, workers: int = DEFAULT_WORKERS, gap: float = 0.0) -> DailyResult:
    t0 = time.time()
    duties = build_duties(fac.templates)
    staff = on_duty(fac, month, cells, day, carry_in)
    m = cp_model.CpModel()

    a: dict[tuple[int, int], cp_model.IntVar] = {}      # (duty, staff index)
    unmet = {d.idx: m.new_bool_var(f"unmet_{d.idx}") for d in duties}
    penalty_terms: list = []
    rules = [r for r in (rules or []) if not r.lifecycle.stopped]

    for d in duties:
        elig = []
        for i, sd in enumerate(staff):
            if not all(k in sd.slots for k in range(d.start, d.end)):
                continue
            if d.skill and d.skill not in sd.staff.skills:
                continue
            # 日次ルール: 絶対の回避は割当そのものを禁止、軟は罰点
            forbid, pen = False, 0
            for r in rules:
                if r.people.match(sd.staff) and r.task == d.task and r.from_hour * 2 < d.end and d.start < r.to_hour * 2:
                    if not r.want:
                        if r.strength == "絶対":
                            forbid = True
                        else:
                            pen += PENALTY[r.strength]
                    else:
                        pen -= PENALTY.get(r.strength, 1000)   # 希望は報酬
            if forbid:
                continue
            v = m.new_bool_var(f"a_{d.idx}_{i}")
            a[d.idx, i] = v
            elig.append(v)
            if pen:
                penalty_terms.append(pen * v)
        m.add(sum(elig) + unmet[d.idx] == 1)

    # 休憩（人ごとに1回）
    brk: dict[tuple[int, int], cp_model.IntVar] = {}
    brk_len: dict[int, int] = {}
    for i, sd in enumerate(staff):
        if len(sd.slots) < 12:               # 6時間未満は休憩なし
            continue
        if sd.prev_day:
            ln, (lo, hi) = NIGHT_BREAK_LEN, NIGHT_BREAK_START
        elif sd.shift in BREAK_START:
            ln, (lo, hi) = BREAK_LEN[sd.shift], BREAK_START[sd.shift]
        else:
            continue                          # 当日開始の夜勤の休憩は翌日の明けの側で扱う
        opts = [k for k in range(lo, hi) if all(x in sd.slots for x in range(k, k + ln))]
        if not opts:
            continue
        brk_len[i] = ln
        vs = []
        for k in opts:
            brk[i, k] = m.new_bool_var(f"b_{i}_{k}")
            vs.append(brk[i, k])
        m.add_exactly_one(vs)

    # 同じ人の業務・休憩は重ならない
    by_slot: dict[tuple[int, int], list] = {}
    for (di, i), v in a.items():
        d = duties[di]
        for k in range(d.start, d.end):
            by_slot.setdefault((i, k), []).append(v)
    for (i, k0), v in brk.items():
        for k in range(k0, k0 + brk_len[i]):
            by_slot.setdefault((i, k), []).append(v)
    for lits in by_slot.values():
        if len(lits) > 1:
            m.add_at_most_one(lits)

    # 継続性: 同じ業務の連続する枠は同じ人（担当の入れ替わりを減らす）
    reward: list = []
    by_tpl: dict[str, dict[int, list[Duty]]] = {}
    for d in duties:
        by_tpl.setdefault(d.template_id, {}).setdefault(d.chunk, []).append(d)
    cont_vars = 0
    for chunks in by_tpl.values():
        for ci in sorted(chunks):
            if ci + 1 not in chunks:
                continue
            for i in range(len(staff)):
                cur = [a[d.idx, i] for d in chunks[ci] if (d.idx, i) in a]
                nxt = [a[d.idx, i] for d in chunks[ci + 1] if (d.idx, i) in a]
                if cur and nxt:
                    y = m.new_bool_var(f"y_{ci}_{i}_{cont_vars}")
                    cont_vars += 1
                    m.add(y <= sum(cur))
                    m.add(y <= sum(nxt))
                    reward.append(y)

    # 業務量の偏り（最大を下げる）
    loads = []
    for i in range(len(staff)):
        terms = [(d.end - d.start) * a[d.idx, i] for d in duties if (d.idx, i) in a]
        if terms:
            loads.append(sum(terms))
    mx = m.new_int_var(0, SLOTS, "load_max")
    for ld in loads:
        m.add(mx >= ld)

    m.minimize(UNMET_WEIGHT * sum(unmet.values()) - CONTINUITY_REWARD * sum(reward) + LOAD_WEIGHT * mx + sum(penalty_terms))

    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = time_limit
    s.parameters.random_seed = seed
    s.parameters.num_workers = workers
    if gap:
        s.parameters.relative_gap_limit = gap     # 継続性などの軟制約は、わずかな差で最適性の証明に時間を使わない
    st = s.solve(m)
    res = DailyResult(status=s.status_name(st), wall_ms=int((time.time() - t0) * 1000),
                      stats={"duties": len(duties), "staff": len(staff), "vars": len(a)})
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return res

    for d in duties:
        who = next((i for i in range(len(staff)) if (d.idx, i) in a and s.value(a[d.idx, i])), None)
        if who is None:
            res.unmet.append(_unmet(d, staff))
            for k in range(d.start, d.end):
                if d.skill:
                    res.skill_shortfall[k, d.skill] = res.skill_shortfall.get((k, d.skill), 0) + 1
                else:
                    res.shortfall[k] = res.shortfall.get(k, 0) + 1
        else:
            sid = staff[who].staff.staff_id
            res.assignments.append({"staff_id": sid, "task": d.task, "template_id": d.template_id, "start": d.start, "end": d.end,
                                    "label": d.label})
            res.load[sid] = res.load.get(sid, 0) + (d.end - d.start)
    for (i, k0), v in brk.items():
        if s.value(v):
            res.breaks.append({"staff_id": staff[i].staff.staff_id, "start": k0, "end": k0 + brk_len[i]})
    res.switches = _switches(res.assignments, by_tpl, duties)
    res.wall_ms = int((time.time() - t0) * 1000)
    return res


def _unmet(d: Duty, staff: list[OnDuty]) -> dict:
    present = [sd for sd in staff if all(k in sd.slots for k in range(d.start, d.end))]
    if d.skill and not any(d.skill in sd.staff.skills for sd in present):
        cause = f"{vocab.skill(d.skill)}ができる人が在席していない"
    elif not present:
        cause = "在席している人がいない"
    else:
        cause = f"在席{len(present)}人では他の業務と重なって足りない"
    return {"template_id": d.template_id, "task": d.task, "start": d.start, "end": d.end, "label": d.label, "skill": d.skill, "cause": cause}


def _switches(assignments: list[dict], by_tpl, duties: list[Duty]) -> int:
    """連続する枠で担当が替わった回数（継続性の指標）。"""
    who = {}
    for a_ in assignments:
        who.setdefault((a_["template_id"], a_["start"]), set()).add(a_["staff_id"])
    n = 0
    for tid, chunks in by_tpl.items():
        for ci in sorted(chunks):
            if ci + 1 in chunks:
                x = {a_["staff_id"] for d in chunks[ci] for a_ in assignments if a_["template_id"] == tid and a_["start"] == d.start}
                y = {a_["staff_id"] for d in chunks[ci + 1] for a_ in assignments if a_["template_id"] == tid and a_["start"] == d.start}
                n += len(y - x)
    return n
