"""分析画面（リーダーの AI 画面の『分析』タブ）用の集計。BigQuery の分析ビュー（infra/analytics.tf）を読み取り専用で引く。

- GET /api/v1/facilities/{fid}/insights            … すべての内訳と主な数字（KPI）
- GET /api/v1/facilities/{fid}/insights/{section}  … 内訳 1 つ（SECTIONS のキー）

環境変数 INSIGHTS_ENABLED=1 のときだけ有効（未設定なら 404。従来どおりの動き）。決まった問い合わせ（パラメータは施設 ID だけ）
しか実行しない。結果は INSIGHTS_TTL 秒（既定 300）キャッシュする。BigQuery が使えないとき（テスト・ローカル・権限の反映待ち）は
例外を出さず、空の内訳と available=false を返す。データは合成（架空）の履歴を含む。
"""
from __future__ import annotations

import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, Protocol

from fastapi import FastAPI
from fastapi.responses import JSONResponse

# 内訳ごとの（見出し, SQL, 施設で絞るか）。{p} はプロジェクト ID、@f は施設 ID。
SECTIONS: dict[str, tuple[str, str, bool]] = {
    "vacancy_slots": ("曜日 × 勤務帯ごとの欠員と充足までの時間", """
        SELECT weekday_num, weekday_label, shift, vacancies, filled, fill_rate, avg_minutes_to_fill, median_minutes_to_fill, avg_lead_hours,
               filled_by_offer, filled_by_applicant, adjusted_by_leader
        FROM `{p}.care_ml.v_vacancy_slots` WHERE facility_id = @f ORDER BY weekday_num, shift""", True),
    "vacancy_monthly": ("月ごとの欠員数と充足までの時間", """
        SELECT FORMAT_DATE('%Y-%m', month) AS month, vacancies, filled, avg_minutes_to_fill, median_minutes_to_fill,
               filled_by_offer, filled_by_applicant, adjusted_by_leader
        FROM `{p}.care_ml.v_vacancy_monthly` WHERE facility_id = @f ORDER BY month""", True),
    "acceptance": ("打診の応諾率の推移（月 × 雇用形態 × 勤続年数）", """
        SELECT FORMAT_DATE('%Y-%m', month) AS month, employment, tenure_band, offers, accepted, declined, expired, accept_rate, median_response_min
        FROM `{p}.care_ml.v_offer_acceptance_monthly` WHERE facility_id = @f ORDER BY month, employment, tenure_band""", True),
    "model_runs": ("応諾予測モデルの精度の推移", """
        SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', run_at) AS run_at, version, model_kind, train_rows, live_rows, auc, logloss,
               baseline_logloss, logloss_gain, gate_passed, promoted, gate_reasons
        FROM `{p}.care_ml.v_model_runs` WHERE facility_id = @f ORDER BY run_at""", True),
    "forecast": ("週ごとの欠員数（実績と ARIMA_PLUS の予測）", """
        SELECT FORMAT_DATE('%Y-%m-%d', week_start) AS week_start, series, vacancies, lower_80, upper_80
        FROM `{p}.care_ml.v_vacancy_weekly_outlook` WHERE facility_id = @f ORDER BY week_start, series""", True),
    "forecast_model": ("予測モデル（ARIMA_PLUS）が選んだ形", """
        SELECT non_seasonal_p, non_seasonal_d, non_seasonal_q, has_drift, ARRAY_TO_STRING(seasonal_periods, ',') AS seasonal_periods, AIC AS aic
        FROM ML.ARIMA_EVALUATE(MODEL `{p}.care_ml.m_vacancy_forecast`, STRUCT(FALSE AS show_all_candidate_models)) WHERE facility_id = @f""", True),
    "solver_runs": ("ソルバー（CP-SAT）の実行時間", """
        SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', solved_at) AS solved_at, roster_month, status, wall_ms
        FROM `{p}.care_analytics.v_solver_runs` WHERE facility_id = @f ORDER BY solved_at DESC LIMIT 30""", True),
    # AI の呼び出しは施設に結びつかないもの（シフト作成君など）もあるので、全体で集計する（直近 30 日）
    "ai_usage": ("AI（Gemini）の利用状況（全体・直近 30 日）", """
        SELECT feature, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
               SUM(thinking_tokens) AS thinking_tokens, SUM(total_tokens) AS total_tokens, CAST(ROUND(AVG(latency_ms)) AS INT64) AS avg_latency_ms,
               APPROX_QUANTILES(latency_ms, 100 IGNORE NULLS)[SAFE_OFFSET(95)] AS p95_latency_ms
        FROM `{p}.care_analytics.v_ai_usage` WHERE called_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
        GROUP BY feature, model ORDER BY calls DESC""", False),
}
MAX_ROWS = 200
_FID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Source(Protocol):
    def run(self, section: str, fid: str) -> list[dict]: ...


def _plain(v):
    return v if isinstance(v, (int, float, str, bool, type(None))) else str(v)


class BQSource:
    """本番用。care-solver-sa は care_ml・care_analytics の dataViewer と bigquery.jobUser だけを持つ（読み取り専用）。"""

    def __init__(self, project: str | None = None) -> None:
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT") or "gdgoc-514203"
        self._bq = None

    def run(self, section: str, fid: str) -> list[dict]:
        from google.cloud import bigquery

        _, sql, by_fac = SECTIONS[section]
        if self._bq is None:
            self._bq = bigquery.Client(project=self.project)
        params = [bigquery.ScalarQueryParameter("f", "STRING", fid)] if by_fac else []
        cfg = bigquery.QueryJobConfig(query_parameters=params, maximum_bytes_billed=1024 ** 3, use_query_cache=True)
        rows = self._bq.query(sql.format(p=self.project), job_config=cfg, location=os.getenv("BQ_LOCATION", "asia-northeast1")).result(timeout=20)
        return [{k: _plain(v) for k, v in dict(r).items()} for r in rows][:MAX_ROWS]


class FakeSource:
    """テスト・ローカル用。data に内訳ごとの行を入れる。fail に入れた内訳は例外にする。"""

    def __init__(self, data: dict[str, list[dict]] | None = None, fail: set[str] | None = None) -> None:
        self.data, self.fail, self.calls = data or {}, fail or set(), []

    def run(self, section: str, fid: str) -> list[dict]:
        self.calls.append((section, fid))
        if section in self.fail:
            raise RuntimeError("fake failure")
        return list(self.data.get(section, []))


class Insights:
    def __init__(self, source: Source, ttl: float | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.source, self.clock = source, clock
        self.ttl = float(os.getenv("INSIGHTS_TTL", "300")) if ttl is None else ttl
        self._cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
        self._lock = threading.Lock()

    def section(self, fid: str, name: str) -> dict:
        """内訳 1 つ。失敗しても例外にせず ok=False と空の行を返す（失敗はキャッシュしない）。"""
        key = (fid if SECTIONS[name][2] else "*", name)
        now = self.clock()
        with self._lock:
            hit = self._cache.get(key)
        if hit and now - hit[0] < self.ttl:
            return {"title": SECTIONS[name][0], "ok": True, "cached": True, "rows": hit[1]}
        try:
            rows = self.source.run(name, fid)
        except Exception:  # noqa: BLE001  BigQuery が使えない・権限の反映待ちなど。内部の詳細は返さない
            return {"title": SECTIONS[name][0], "ok": False, "cached": False, "rows": []}
        with self._lock:
            self._cache[key] = (now, rows)
        return {"title": SECTIONS[name][0], "ok": True, "cached": False, "rows": rows}

    def overview(self, fid: str) -> dict:
        with ThreadPoolExecutor(max_workers=len(SECTIONS)) as ex:
            got = dict(zip(SECTIONS, ex.map(lambda n: self.section(fid, n), SECTIONS)))
        ok = any(s["ok"] for s in got.values())
        return {"facility_id": fid, "available": ok, "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "note": "合成（架空）の履歴を含みます。予測は BigQuery ML（ARIMA_PLUS）による目安です。" if ok
                else "分析データを読み込めませんでした（準備中）。",
                "kpis": kpis({k: v["rows"] for k, v in got.items()}), "sections": got}


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def kpis(s: dict[str, list[dict]]) -> dict:
    """画面の上に並べる主な数字。元の行から計算する（行が無ければ None）。"""
    slots = s.get("vacancy_slots") or []
    vac = sum(int(r.get("vacancies") or 0) for r in slots)
    filled = sum(int(r.get("filled") or 0) for r in slots)
    w = [(r["avg_minutes_to_fill"], int(r.get("filled") or 0)) for r in slots if _num(r.get("avg_minutes_to_fill")) is not None]
    peak = max(slots, key=lambda r: int(r.get("vacancies") or 0), default=None)

    acc = s.get("acceptance") or []
    offers = sum(int(r.get("offers") or 0) for r in acc)
    accepted = sum(int(r.get("accepted") or 0) for r in acc)

    runs = s.get("model_runs") or []
    last = runs[-1] if runs else None

    fc = [r for r in (s.get("forecast") or []) if r.get("series") == "予測"][:4]
    solver = [_num(r.get("wall_ms")) for r in (s.get("solver_runs") or []) if _num(r.get("wall_ms")) is not None]
    ai = s.get("ai_usage") or []
    return {
        "vacancies": vac or None,
        "fill_rate": round(filled / vac, 3) if vac else None,
        "avg_minutes_to_fill": round(sum(m * n for m, n in w) / sum(n for _, n in w), 1) if w and sum(n for _, n in w) else None,
        "peak_slot": {"weekday": peak.get("weekday_label"), "shift": peak.get("shift"), "vacancies": peak.get("vacancies")} if peak and vac else None,
        "accept_rate": round(accepted / offers, 3) if offers else None,
        "offers": offers or None,
        "model_auc": _num(last.get("auc")) if last else None,
        "model_promoted": bool(last.get("promoted")) if last else None,
        "forecast_next4w": round(sum(_num(r.get("vacancies")) or 0 for r in fc), 1) if fc else None,
        "solver_avg_ms": round(sum(solver) / len(solver)) if solver else None,
        "ai_calls_30d": sum(int(r.get("calls") or 0) for r in ai) or None,
        "ai_tokens_30d": sum(int(r.get("total_tokens") or 0) for r in ai) or None,
    }


# ---------------------------------------------------------------- 登録

_svc: Insights | None = None


def enabled() -> bool:
    return os.getenv("INSIGHTS_ENABLED", "0") == "1"


def get() -> Insights:
    global _svc
    if _svc is None:
        _svc = Insights(BQSource())
    return _svc


def set_insights(i: Insights | None) -> None:     # テスト用
    global _svc
    _svc = i


def _off() -> JSONResponse:
    return JSONResponse({"error": "分析は有効になっていません"}, status_code=404)


def register(app: FastAPI) -> None:
    @app.get("/api/v1/facilities/{fid}/insights")
    def insights_overview(fid: str):
        """分析タブ。欠員の発生と充足・応諾率の推移・モデルの精度・欠員数の予測・AI の利用・ソルバーの実行時間。"""
        if not enabled() or not _FID.match(fid):
            return _off()
        return get().overview(fid)

    @app.get("/api/v1/facilities/{fid}/insights/{section}")
    def insights_section(fid: str, section: str):
        if not enabled() or not _FID.match(fid):
            return _off()
        if section not in SECTIONS:
            return JSONResponse({"error": f"section は {sorted(SECTIONS)} のいずれか"}, status_code=404)
        return {"facility_id": fid, "section": section, **get().section(fid, section)}
