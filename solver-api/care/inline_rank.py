"""画面（リーダーの欠員フロー）から呼ぶ、状態を持たない候補の順位付け。POST /api/v1/rank-candidates

画面は自分の職員・勤務の一部（欠員日の前7日〜後2日）を送り、ここで「打診の時点で分かる特徴量」を作って、
学習済みの応諾予測モデル（champion）で応諾の見込みを返す。Firestore は読まない・書かない。名前は受け取らない・記録しない。

* 特徴量は Svc.offer_features（fact_offers の列）と同じ定義。画面の職員は合成施設の職員と別人なので、
  人ごとの過去の応諾率（staff_prior）は施設全体の応諾率になる（ID を "app:" で区切り、学習データの人と混ざらないようにする）。
* モデルは RANK_PRIOR_FACILITY（既定 fac-sakura）の champion を事前分布として使う。読めなければ model="none" を返す（エラーにしない）。
* A/B（AB_CHALLENGER_SHARE > 0）のとき、vacancy_id を送ると、そのハッシュで champion / challenger を決め、応答の "ab" に腕を返す
  （画面は打診のイベントにそのまま載せられる）。vacancy_id が無い・A/B が無効なら従来どおり champion。
* 打診してよいかの最終判断（連勤・夜勤明け・週の上限など）は画面側が持つ。ここでの除外は、明らかに入れない人だけ。
* ただし画面がその月の勤務（cells）を送ったときは、候補ごとに「引き受けたらソルバーの絶対ルールを破るか」を
  inline_verify で確かめ、破る人を excluded に移す（reason はルールの名前、rule_id つき）。cells が無ければ従来どおり。
"""
from __future__ import annotations

import os
from datetime import date as Date, datetime, timedelta, timezone
from typing import Callable, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator

from .inline_verify import check_cells, exclude_hard
from .learn import ab, scoring
from .learn.store import ModelStore
from .solver.monthly import WORK_H

Shift = Literal["早番", "日勤", "遅番", "夜勤"]
_DATE = r"^\d{4}-\d{2}-\d{2}$"
_TS = r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$"
_ID = r"^[A-Za-z0-9_.:-]{1,40}$"
JST = timezone(timedelta(hours=9))
SHIFT_START = {"早番": 7.0, "日勤": 9.0, "遅番": 12.0, "夜勤": 16.5}     # Svc.SHIFT_START と同じ（JST の時刻）
JA = {"log_lead": "依頼までの余裕", "is_night": "夜勤の依頼", "is_early": "早番の依頼", "is_late": "遅番の依頼", "same_unit": "同じユニット",
      "skill_match": "必要な資格", "consec_excess": "連勤が続いていること", "hours_dev": "今月の勤務時間", "nights_last30": "最近の夜勤の多さ",
      "offers_last14": "最近の打診の多さ", "tenure": "経験年数", "part_time": "パート勤務", "is_weekend": "土日の依頼", "staff_prior": "この人の過去の応諾率"}


class StaffIn(BaseModel):
    id: str = Field(pattern=_ID)
    role: str = Field("", max_length=20)
    employment: str = Field("常勤", max_length=10)
    skills: list[str] = Field(default_factory=list, max_length=20)
    shifts: list[str] = Field(default_factory=list, max_length=4)
    home_unit: str | None = Field(None, max_length=20)
    years: float = Field(0, ge=0, le=60)
    leave_by: str | None = Field(None, max_length=5)
    # 画面が月全体から数えた値（任意）。無ければ送られた期間の勤務から数える
    month_hours_before: float | None = Field(None, ge=0, le=400)
    nights_last30: int | None = Field(None, ge=0, le=31)
    offers_last14: int | None = Field(None, ge=0, le=100)


class AsgIn(BaseModel):
    staff_id: str = Field(pattern=_ID)
    date: str = Field(pattern=_DATE)
    shift: Shift
    status: str = Field("assigned", max_length=12)


class AvailIn(BaseModel):
    staff_id: str = Field(pattern=_ID)
    date: str = Field(pattern=_DATE)
    shifts: list[str] = Field(default_factory=list, max_length=4)


class RankIn(BaseModel):
    date: str = Field(pattern=_DATE)
    shift: Shift
    unit_id: str | None = Field(None, max_length=20)
    absent_staff_id: str | None = Field(None, max_length=40)
    need_skills: list[str] = Field(default_factory=list, max_length=10)
    discovered_at: str | None = Field(None, pattern=_TS, description="欠員を知った時刻。タイムゾーンなしは JST。省略すると今")
    staff: list[StaffIn] = Field(max_length=120)
    assignments: list[AsgIn] = Field(default_factory=list, max_length=2000)
    avail: list[AvailIn] = Field(default_factory=list, max_length=2000)
    # 任意: その月の勤務（staff_id -> 日ごとの勤務。"" は休み）。あれば、候補ごとにソルバーの絶対ルールを確かめる（inline_verify）
    cells: dict[str, list[str]] | None = Field(None, max_length=200)
    month_days: int | None = Field(None, ge=28, le=31)
    first_weekday: int | None = Field(None, ge=0, le=6)
    carry_in: dict[str, str] = Field(default_factory=dict, max_length=200)
    night_max: int | None = Field(None, ge=1, le=15)
    vacancy_id: str | None = Field(None, pattern=_ID, description="任意。A/B の腕を決めるのに使う（記録はしない）")

    @model_validator(mode="after")
    def _cells(self):
        try:                       # 形（pattern）だけでなく暦として正しいか（2026-02-30 は 422。500 にしない）
            Date.fromisoformat(self.date)
            _ts(self.discovered_at)
            for x in (*self.assignments, *self.avail):
                Date.fromisoformat(x.date)
        except ValueError as e:
            raise ValueError(f"日付・時刻が不正です: {e}") from None
        if self.cells is not None:
            check_cells(self.cells, self.date)
        return self


def _ts(s: str | None) -> datetime:
    if not s:
        return datetime.now(timezone.utc)
    t = datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T"))
    return t if t.tzinfo else t.replace(tzinfo=JST)


def features(body: RankIn, s: StaffIn, work: dict[str, dict[str, str]]) -> dict:
    """Svc.offer_features と同じ列。work は {staff_id: {date: shift}}（休みの連絡済みは含めない）。"""
    d = Date.fromisoformat(body.date)
    start = datetime(d.year, d.month, d.day, tzinfo=JST) + timedelta(hours=SHIFT_START[body.shift])
    t0 = _ts(body.discovered_at)
    mine = work.get(s.id, {})
    run = 0
    while (d - timedelta(days=run + 1)).isoformat() in mine:
        run += 1
    before = [(k, v) for k, v in mine.items() if k < body.date]
    hours = s.month_hours_before if s.month_hours_before is not None else float(sum(WORK_H[v] for k, v in before if k[:7] == body.date[:7]))
    lo = (d - timedelta(days=30)).isoformat()
    nights = s.nights_last30 if s.nights_last30 is not None else sum(1 for k, v in before if k >= lo and v == "夜勤")
    return {"staff_id": f"app:{s.id}", "status": "", "lead_hours": round(max((start - t0).total_seconds() / 3600, 0.5), 2),
            "weekday": d.isoweekday() % 7, "shift": body.shift, "same_unit": bool(s.home_unit and s.home_unit == body.unit_id),
            "skill_match": set(body.need_skills) <= set(s.skills), "consec_before": run, "month_hours_before": float(hours),
            "nights_last30": int(nights), "offers_last14": int(s.offers_last14 or 0), "tenure_years": s.years, "employment": s.employment}


def rank(body: RankIn, art: dict | None) -> dict:
    work: dict[str, dict[str, str]] = {}
    for a in body.assignments:
        if a.status != "absent":
            work.setdefault(a.staff_id, {})[a.date] = a.shift
    avail = {(x.staff_id, x.date) for x in body.avail if not x.shifts or body.shift in x.shifts}
    ok, excluded, seen = [], [], set()
    for s in body.staff:
        if s.id in seen:
            continue
        seen.add(s.id)
        if s.id == body.absent_staff_id:
            excluded.append({"staff_id": s.id, "reason": "欠勤した本人"})
        elif any(a.staff_id == s.id and a.date == body.date and a.status == "absent" for a in body.assignments):
            excluded.append({"staff_id": s.id, "reason": "本人が休みの連絡済み"})
        elif body.date in work.get(s.id, {}):
            excluded.append({"staff_id": s.id, "reason": "当日は別の勤務あり"})
        elif s.shifts and body.shift not in s.shifts:
            excluded.append({"staff_id": s.id, "reason": f"{body.shift}は不可"})
        elif not set(body.need_skills) <= set(s.skills):
            excluded.append({"staff_id": s.id, "reason": "必要な資格がない"})
        else:
            ok.append(s)
    if body.cells is not None:   # ソルバーの絶対ルールを破る人は、打診の候補にしない
        ok, hard = exclude_hard(body.date, body.shift, ok, body.cells, body.carry_in, body.month_days, body.first_weekday, body.night_max)
        excluded += hard
    rows =[features(body, s, work) for s in ok]
    probs, tops = None, None
    if art is not None and rows:
        try:
            probs = [scoring.predict(art, r) for r in rows]
            tops = [scoring.explain(art, r, 2) for r in rows]
        except Exception as e:  # noqa: BLE001  採点に失敗したら、モデルなしとして返す
            print(f"[inline-rank] predict failed: {type(e).__name__}")
            probs, tops = None, None
    out = []
    for i, (s, row) in enumerate(zip(ok, rows)):
        reasons = []
        if (s.id, body.date) in avail:
            reasons.append("入れる日に登録済み")
        if row["same_unit"]:
            reasons.append("同じユニット")
        c = {"staff_id": s.id, "accept_probability": None, "rank_score": round((1.0 if row["same_unit"] else 0.0) - 0.0025 * row["month_hours_before"], 4), "reasons": reasons}
        if probs is not None:
            p = probs[i]
            c["accept_probability"], c["rank_score"] = round(p, 3), round(p, 4)
            c["reasons"] = [f"応諾の見込み {p * 100:.0f}%（過去の打診から学習）", *reasons]
            top = [f"{JA.get(n, n)}が{'プラス' if v > 0 else 'マイナス'}" for n, v in tops[i] if abs(v) >= 0.15]
            if top:
                c["reasons"].append("影響の大きい要因: " + "、".join(top))
        out.append(c)
    out.sort(key=lambda x: -x["rank_score"])
    return {"candidates": out, "excluded": excluded, "model": "champion" if probs is not None or (art is not None and not rows) else "none"}


_own: ModelStore | None = None


def _models(svc_ref: Callable[[], object | None]):
    """API 本体（Svc）が持つモデル置き場を使う。まだ作られていなければ MODEL_ROOT から自前で読む（Firestore には触れない）。"""
    global _own
    s = svc_ref()
    if s is not None:
        return getattr(s, "models", None)
    if os.getenv("MODEL_ROOT"):
        if _own is None:
            _own = ModelStore(os.getenv("MODEL_ROOT"))
        return _own
    return None


def register(app, svc_ref: Callable[[], object | None]) -> None:
    router = APIRouter()

    @router.post("/api/v1/rank-candidates")
    def rank_candidates(body: RankIn):
        """欠員の候補を、学習済みの応諾予測で並べる（状態なし・名前なし）。モデルが無ければ model="none"。"""
        art, info = None, None
        try:
            ms = _models(svc_ref)
            if ms:
                art, info = ab.choose(ms, os.getenv("RANK_PRIOR_FACILITY", "fac-sakura"), body.vacancy_id)
        except Exception as e:  # noqa: BLE001  モデルが読めなくても止めない
            print(f"[inline-rank] model load failed: {type(e).__name__}")
        from .guard import heavy_slot  # 候補ごとに検証を回すので、求解と同じ同時実行の枠で動かす（分あたりの枠はミドルウェアで消費済み）

        with heavy_slot():
            out = rank(body, art)
        if info:                                # A/B が有効なときだけ（無効なら応答は従来どおり）
            out["ab"] = info
        return out

    app.include_router(router)
