"""決定的なルール層。AI（Gemini）の出力は必ずここで検証・補正する。"""
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

SEED = Path(__file__).parent / "seed"
NIGHT_REQUIRED = 3          # 夜勤の必要人数（デモ設定）
NIGHT_REQUIRED_SKILL = "医療的ケア"  # 夜勤に最低1名必要なスキル


def load_seed(name: str) -> Any:
    return json.loads((SEED / f"{name}.json").read_text(encoding="utf-8"))


def care_workers() -> list[dict]:
    return [e for e in load_seed("employees") if e.get("role") == "介護職"]


def rank_candidates(
    absent_emp_id: str | None = None,
    required_skills: tuple[str, ...] = (NIGHT_REQUIRED_SKILL,),
    unavailable: set[str] | None = None,
) -> list[dict]:
    """欠員に対する代替候補を決定的にスコアリングする。提案であり本人の承諾ではない。"""
    unavailable = unavailable or set()
    out = []
    for e in care_workers():
        if e["id"] == absent_emp_id or e["id"] in unavailable:
            continue
        if not e.get("canNightShift"):
            continue
        score, reasons = 3, ["夜勤可"]
        for s in required_skills:
            if s in e.get("skills", []):
                score += 3
                reasons.append(f"必要スキル一致（{s}）")
        pref = (e.get("preferences") or {}).get("shiftPreference", "")
        if "夜勤" in pref:
            score += 2
            reasons.append("夜勤希望")
        if e.get("canMentor"):
            score += 1
            reasons.append("フォロー可")
        out.append({"empId": e["id"], "name": e["name"], "score": score, "reasons": reasons, "skills": e.get("skills", [])})
    out.sort(key=lambda c: (-c["score"], c["empId"]))
    return out


def month_dates(year: int, month: int) -> list[str]:
    d = date(year, month, 1)
    res = []
    while d.month == month:
        res.append(d.isoformat())
        d += timedelta(days=1)
    return res


def validate_night_plan(plan: dict[str, list[str]], year: int, month: int) -> list[str]:
    """夜勤割当の必須制約を検証し、違反メッセージを返す（空なら適合）。"""
    emps = {e["id"]: e for e in care_workers()}
    problems: list[str] = []
    prev: set[str] = set()
    for d in month_dates(year, month):
        ids = plan.get(d, [])
        if len(set(ids)) != len(ids):
            problems.append(f"{d}: 同一職員が重複")
        if len(ids) < NIGHT_REQUIRED:
            problems.append(f"{d}: 夜勤人数不足（{len(ids)}/{NIGHT_REQUIRED}）")
        for i in ids:
            e = emps.get(i)
            if not e or not e.get("canNightShift"):
                problems.append(f"{d}: {i} は夜勤不可または未登録")
        if ids and not any(NIGHT_REQUIRED_SKILL in emps.get(i, {}).get("skills", []) for i in ids):
            problems.append(f"{d}: {NIGHT_REQUIRED_SKILL}スキル保持者がいない")
        if prev & set(ids):
            problems.append(f"{d}: 前日夜勤からの連続夜勤 {sorted(prev & set(ids))}")
        prev = set(ids)
    return problems


def greedy_night_plan(year: int, month: int) -> dict[str, list[str]]:
    """公平性（夜勤回数の均等化）を意識した決定的な割当。AI不使用時・検証失敗時のフォールバック。"""
    workers = [e for e in care_workers() if e.get("canNightShift")]
    count = {e["id"]: 0 for e in workers}
    plan: dict[str, list[str]] = {}
    prev: set[str] = set()
    for d in month_dates(year, month):
        picked: list[str] = []
        medical = sorted((e for e in workers if NIGHT_REQUIRED_SKILL in e["skills"] and e["id"] not in prev), key=lambda e: (count[e["id"]], e["id"]))
        if medical:
            picked.append(medical[0]["id"])
        rest = sorted((e for e in workers if e["id"] not in prev and e["id"] not in picked), key=lambda e: (count[e["id"]], e["id"]))
        for e in rest:
            if len(picked) >= NIGHT_REQUIRED:
                break
            picked.append(e["id"])
        for i in picked:
            count[i] += 1
        plan[d] = picked
        prev = set(picked)
    return plan


def plan_stats(plan: dict[str, list[str]]) -> dict[str, int]:
    c: dict[str, int] = {}
    for ids in plan.values():
        for i in ids:
            c[i] = c.get(i, 0) + 1
    return c
