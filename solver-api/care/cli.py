"""ローカルで月次＋日次を解いて要約を出す（デモ・計測用）。

  cd solver-api && .venv/bin/python -m care.cli --facility fac-sakura --day 12
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from care.coverage_view import day_timeline  # noqa: E402
from care.defaults import default_rules, request_rules  # noqa: E402
from care.solver.explain import explain_daily, explain_monthly  # noqa: E402
from care.solver.loop import solve_integrated  # noqa: E402
from care.synth_io import carry_in, load  # noqa: E402
from care.verify import verify_monthly  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--facility", default="fac-sakura")
    ap.add_argument("--month", default="2026-11")
    ap.add_argument("--day", type=int, default=12)
    ap.add_argument("--out", default=None, help="合成データのディレクトリ（省略時は scripts/synth/out）")
    a = ap.parse_args()
    fac, mo, reqs = load(a.facility, a.month, a.out)
    ci = carry_in(a.facility, a.month, a.out)
    rules = default_rules(fac, mo) + request_rules(reqs, mo.month)
    r = solve_integrated(fac, mo, rules, carry_in=ci)
    m = r.monthly
    print(f"== {fac.name} {a.month}  月次 {m.status} {m.wall_ms}ms / 日次30日 / 合計 {r.wall_ms}ms / 反復 {len(r.iterations)}回 / 未割当 {r.unmet_total}")
    print("\n".join(explain_monthly(m)))
    print("独立検証の破れ:", verify_monthly(fac, mo, m.cells, rules, ci) or "なし")
    d = r.daily.get(a.day)
    if d:
        print(f"\n-- {a.day}日の日次スケジュール（{d.wall_ms}ms, 担当の入れ替わり {d.switches}）")
        print("\n".join(explain_daily(d)))
        print(day_timeline(fac, mo, m.cells, a.day, d, ci))


if __name__ == "__main__":
    main()
