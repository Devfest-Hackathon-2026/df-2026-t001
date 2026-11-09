"""解けなかった理由・破れた理由を、リーダーが読む文章にする（Gemini が整えるための素材にもなる）。

決定的なテンプレートで作る。数字と対象は solver の出力そのもので、ここに推測は混ぜない。
Gemini は P4 でこの出力を言い換えるだけ（新しい事実は足さない）。
"""
from __future__ import annotations

from .. import vocab
from .daily import DailyResult
from .monthly import Broken, MonthlyResult


def _line(b: Broken, prefix: str) -> str:
    ex = f"（例: {b.detail[0]}）" if b.detail else ""
    return f"{prefix}「{b.label}」が{b.count}件{ex}"


def explain_monthly(r: MonthlyResult) -> list[str]:
    if r.status in ("OPTIMAL", "FEASIBLE"):
        if not r.soft_broken:
            return ["すべてのルールを満たす勤務表を作れました。"]
        return ["作れました。次のルールは守りきれませんでした（優先度の低い順に破っています）。",
                *[_line(b, "・") for b in r.soft_broken]]
    if r.relaxation:
        lines = ["今のルールのままでは勤務表を作れません。最も少ない破りで通すなら、次のルールを緩める必要があります。"]
        lines += [_line(b, "・") for b in r.relaxation]
        if r.stats.get("relax_status") == "FEASIBLE":
            lines.append("（時間内に見つかった案です。破りがこれより少なくなる可能性があります。）")
        lines.append("上から順に見直すと、影響が小さいものから確認できます。")
        return lines
    return ["勤務表を作れませんでした（時間内に解が見つかりませんでした）。ルールを減らすか、時間を延ばして再実行してください。"]


def explain_daily(r: DailyResult) -> list[str]:
    if not r.unmet:
        return ["この日の業務はすべて割り当てられました。"]
    by: dict[str, list[dict]] = {}
    for u in r.unmet:
        by.setdefault(u["cause"], []).append(u)
    lines = [f"この日は{len(r.unmet)}件の業務を割り当てられませんでした。"]
    for cause, us in by.items():
        head = "・".join(f"{u['label']} {vocab.task(u['task'])}" for u in us[:3])
        lines.append(f"・{cause}: {head}" + (f" ほか{len(us) - 3}件" if len(us) > 3 else ""))
    return lines
