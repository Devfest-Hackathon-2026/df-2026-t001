"""月次と日次をつなぐ。月次を解く → 全日を日次で解く → 足りなかった時間帯・資格を月次へ戻して再求解（最大 max_iter 回）。

日次が解けない月次案を、リーダーに出さないための仕組み。月次の集約制約は日課から導いた近似なので、
退勤上限・休憩・同時に走る業務などで日次が足りなくなる分を、実測した不足で補正する。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from ..dsl import Facility, Month, TaskRequest
from .daily import DailyResult, solve_daily
from .monthly import MonthlyResult, solve_monthly


@dataclass
class Iteration:
    n: int
    monthly_status: str
    monthly_ms: int
    daily_ms: int
    unmet: int


@dataclass
class IntegratedResult:
    monthly: MonthlyResult
    daily: dict[int, DailyResult] = field(default_factory=dict)
    iterations: list[Iteration] = field(default_factory=list)
    unmet_total: int = 0
    wall_ms: int = 0


def solve_integrated(fac: Facility, month: Month, rules: list, *, carry_in: dict[str, str] | None = None,
                     daily_rules: list[TaskRequest] | None = None, max_iter: int = 2, monthly_time: float = 20.0,
                     fixed: dict[str, dict[int, str]] | None = None, baseline: dict[str, list[str]] | None = None,
                     daily_time: float = 1.0, budget: float = 40.0) -> IntegratedResult:
    """budget: 全体の時間予算（秒）。Cloud Run の 60 秒タイムアウトに収める。日ごとの上限は残り時間で縮める。
    日次は「全業務を割り当てられるか」が分かれば連携には十分なので、最適性の証明に時間を使い切らない。"""
    t0 = time.time()
    deadline = t0 + budget
    boost: dict[int, dict[int, int]] = {}
    boost_skill: dict[int, dict[tuple[int, str], int]] = {}
    out: IntegratedResult | None = None
    its: list[Iteration] = []             # 反復の記録は反復をまたいで持つ
    for it in range(max_iter + 1):
        mr = solve_monthly(fac, month, rules, carry_in=carry_in, boost=boost, boost_skill=boost_skill, fixed=fixed,
                           baseline=baseline, time_limit=max(2.0, min(monthly_time, deadline - time.time())))
        if not mr.cells or mr.status not in ("OPTIMAL", "FEASIBLE"):
            out = IntegratedResult(monthly=mr)
            its.append(Iteration(it, mr.status, mr.wall_ms, 0, -1))
            break
        t1 = time.time()
        daily = {}
        for d in range(1, month.days + 1):
            left = month.days - d + 1
            tl = min(daily_time, max(0.3, (deadline - time.time()) / left))
            daily[d] = solve_daily(fac, month, mr.cells, d, carry_in=carry_in, rules=daily_rules, time_limit=tl)
        unmet = sum(len(r.unmet) for r in daily.values())
        out = IntegratedResult(monthly=mr, daily=daily, unmet_total=unmet)
        its.append(Iteration(it, mr.status, mr.wall_ms, int((time.time() - t1) * 1000), unmet))
        if unmet == 0 or it == max_iter or time.time() > deadline - 8:     # 予算が尽きそうなら、ここで返す
            break
        # 足りなかった時間帯・資格を月次へ戻す
        for d, r in daily.items():
            for slot, n in r.shortfall.items():
                boost.setdefault(d, {})[slot] = boost.get(d, {}).get(slot, 0) + n
            for key, n in r.skill_shortfall.items():
                boost_skill.setdefault(d, {})[key] = boost_skill.get(d, {}).get(key, 0) + n
    assert out is not None
    out.iterations = its
    out.wall_ms = int((time.time() - t0) * 1000)
    return out
