"""チャットの道具「history_insights」の中身。BigQuery（care_ml）の決まった集計だけを実行する。

* SQL は下の QUERIES に固定。Gemini が選べるのは kind（列挙）と、staff_id・months の2つのパラメータだけで、
  どちらもクエリパラメータ（@s・@m）として渡す。文字列を SQL に埋め込むことは無い。
* 職員は仮名 ID（HDM-007 など）のまま返す。氏名の列は持たない（dim_staff を結合しない）。
  念のため、結果の文字列は Gemini に渡す前に ChatTools 側で仮名化し直す（chat.py の _pseudo_rows）。
* 読むだけ（maximum_bytes_billed で上限）。履歴には合成データ（架空）を含む。
* BigQuery が無い環境（ローカル・テスト）では FakeInsights を使う。値は固定の架空の数字で、fake=True を付けて返す。
"""
from __future__ import annotations

import os
import re

_WD = "['日','月','火','水','木','金','土'][OFFSET(EXTRACT(DAYOFWEEK FROM date) - 1)]"
_SINCE = "DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @m MONTH)"

QUERIES: dict[str, tuple[str, str]] = {
    "vacancy_by_weekday_shift": (
        "曜日×勤務区分ごとの欠員数・平均の余裕時間・打診で埋まった割合（欠員の出やすい枠の傾向）",
        f"""SELECT {_WD} AS weekday, shift, COUNT(*) AS vacancies, ROUND(AVG(lead_hours),1) AS avg_lead_hours,
            ROUND(AVG(IF(final_route='offer',1,0)),3) AS filled_by_offer_rate, ROUND(AVG(IF(final_route='adjusted',1,0)),3) AS adjusted_rate
            FROM `{{p}}.care_ml.fact_vacancies` WHERE facility_id=@f AND date >= {_SINCE}
            GROUP BY weekday, shift, EXTRACT(DAYOFWEEK FROM date) ORDER BY vacancies DESC LIMIT 20"""),
    "vacancy_reasons": (
        "欠員の理由（区分）ごとの件数・平均の余裕時間・打診で埋まった割合・平均の打診数",
        f"""SELECT reason, COUNT(*) AS vacancies, ROUND(AVG(lead_hours),1) AS avg_lead_hours,
            ROUND(AVG(IF(final_route='offer',1,0)),3) AS filled_by_offer_rate, ROUND(AVG(n_offers),2) AS avg_offers
            FROM `{{p}}.care_ml.fact_vacancies` WHERE facility_id=@f AND date >= {_SINCE} GROUP BY reason ORDER BY vacancies DESC"""),
    "vacancy_monthly_trend": (
        "月ごとの欠員数と、埋まるまでの時間（中央値・時間）・平均の打診数の推移",
        f"""SELECT FORMAT_DATE('%Y-%m', date) AS month, COUNT(*) AS vacancies, ROUND(AVG(lead_hours),1) AS avg_lead_hours,
            ROUND(APPROX_QUANTILES(TIMESTAMP_DIFF(filled_at, discovered_at, MINUTE) / 60, 2)[OFFSET(1)],1) AS median_hours_to_fill,
            ROUND(AVG(n_offers),2) AS avg_offers, COUNTIF(final_route='adjusted') AS adjusted_by_leader
            FROM `{{p}}.care_ml.fact_vacancies` WHERE facility_id=@f AND date >= {_SINCE} GROUP BY month ORDER BY month"""),
    "staff_acceptance": (
        "職員（仮名 ID）ごとの打診数・応諾率・辞退・期限切れ・応答までの時間の中央値（分）・夜勤の応諾率。staff_id で1人に絞れる",
        f"""SELECT staff_id, COUNT(*) AS offers, COUNTIF(status='accepted') AS accepted, COUNTIF(status='declined') AS declined,
            COUNTIF(status='expired') AS expired, ROUND(AVG(IF(status='accepted',1,0)),3) AS accept_rate,
            ROUND(APPROX_QUANTILES(response_min, 2)[OFFSET(1)],1) AS median_response_min,
            ROUND(SAFE_DIVIDE(COUNTIF(shift='夜勤' AND status='accepted'), COUNTIF(shift='夜勤')),3) AS night_accept_rate,
            CAST(MAX(DATE(offered_at, 'Asia/Tokyo')) AS STRING) AS last_offer_date
            FROM `{{p}}.care_ml.fact_offers` WHERE facility_id=@f AND (@s IS NULL OR staff_id=@s) AND DATE(offered_at, 'Asia/Tokyo') >= {_SINCE}
            GROUP BY staff_id ORDER BY offers DESC, staff_id LIMIT 20"""),
    "model_accuracy_trend": (
        "応諾予測モデルの学習ごとの精度の推移（AUC・logloss・基準の logloss・ゲート通過・採用）。新しい順",
        """SELECT FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', run_at, 'Asia/Tokyo') AS run_at, version, kind, `rows`, ROUND(auc,4) AS auc,
           ROUND(logloss,4) AS logloss, ROUND(baseline_logloss,4) AS baseline_logloss, gate_passed, promoted, gate_reasons
           FROM `{p}.care_ml.model_runs` WHERE facility_id=@f ORDER BY run_at DESC LIMIT 10"""),
    "model_calibration": (
        "最新の応諾予測モデルの較正（予測した応諾確率の帯ごとに、予測の平均と実際の応諾率・件数）",
        """WITH latest AS (SELECT model_version FROM `{p}.care_ml.offer_scores` WHERE facility_id=@f ORDER BY scored_at DESC LIMIT 1)
           SELECT CONCAT(CAST(b*20 AS STRING), '〜', CAST(b*20+20 AS STRING), '%') AS predicted_band, n, avg_predicted, actual_rate, model_version FROM (
             SELECT LEAST(CAST(FLOOR(p_accept*5) AS INT64), 4) AS b, COUNT(*) AS n, ROUND(AVG(p_accept),3) AS avg_predicted,
                    ROUND(AVG(label),3) AS actual_rate, ANY_VALUE(s.model_version) AS model_version
             FROM `{p}.care_ml.offer_scores` s JOIN latest USING (model_version) WHERE s.facility_id=@f AND label IS NOT NULL GROUP BY b)
           ORDER BY predicted_band"""),
}

STAFF_ID = re.compile(r"^[A-Z]{2,5}-\d{2,4}$")


def check_args(kind: str, staff_id: str | None, months: int | None) -> tuple[str | None, int]:
    """道具の引数を検査する。不正なら ValueError（モデルに返して言い直させる）。"""
    if kind not in QUERIES:
        raise ValueError(f"kind は {sorted(QUERIES)} のいずれか")
    if staff_id is not None and staff_id != "" and not STAFF_ID.match(staff_id):
        raise ValueError(f"staff_id は従業員ID（例 HDM-007）: {staff_id}")
    m = 12 if months in (None, "") else int(months)
    if not 1 <= m <= 36:
        raise ValueError("months は 1〜36")
    return (staff_id or None), m


class BQInsights:
    def __init__(self, project: str | None = None) -> None:
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT")
        self._bq = None

    def kinds(self) -> dict[str, str]:
        return {k: v[0] for k, v in QUERIES.items()}

    def run(self, kind: str, fid: str, *, staff_id: str | None = None, months: int | None = None) -> list[dict]:
        from google.cloud import bigquery

        sid, m = check_args(kind, staff_id, months)
        if self._bq is None:
            self._bq = bigquery.Client(project=self.project)
        cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("f", "STRING", fid),
                                                        bigquery.ScalarQueryParameter("s", "STRING", sid),
                                                        bigquery.ScalarQueryParameter("m", "INT64", m)],
                                      maximum_bytes_billed=50 * 1024 * 1024, use_query_cache=True)
        rows = self._bq.query(QUERIES[kind][1].format(p=self.project), job_config=cfg).result(timeout=15)
        return [{k: (v if isinstance(v, (int, float, str, bool, type(None))) else str(v)) for k, v in dict(r).items()} for r in rows][:20]


class FakeInsights:
    """BigQuery が無い環境・テスト用。固定の架空の値を返す（fake=True）。"""

    fake = True

    def __init__(self, data: dict | None = None) -> None:
        self.data, self.calls = data, []

    def kinds(self):
        return {k: v[0] for k, v in QUERIES.items()}

    def run(self, kind, fid, *, staff_id=None, months=None):
        sid, m = check_args(kind, staff_id, months)
        self.calls.append((kind, fid, sid, m))
        if self.data is not None:
            return list(self.data.get(kind, []))
        pre = fid.split("-")[-1][:3].upper() if fid else "XXX"
        demo = {
            "vacancy_by_weekday_shift": [{"weekday": "土", "shift": "夜勤", "vacancies": 9, "avg_lead_hours": 14.2, "filled_by_offer_rate": 0.667, "adjusted_rate": 0.222},
                                         {"weekday": "月", "shift": "早番", "vacancies": 6, "avg_lead_hours": 20.5, "filled_by_offer_rate": 0.833, "adjusted_rate": 0.167}],
            "vacancy_reasons": [{"reason": "体調不良", "vacancies": 20, "avg_lead_hours": 11.3, "filled_by_offer_rate": 0.7, "avg_offers": 2.1}],
            "vacancy_monthly_trend": [{"month": "2026-09", "vacancies": 12, "avg_lead_hours": 18.0, "median_hours_to_fill": 3.5, "avg_offers": 1.9, "adjusted_by_leader": 2},
                                      {"month": "2026-10", "vacancies": 15, "avg_lead_hours": 16.4, "median_hours_to_fill": 4.1, "avg_offers": 2.2, "adjusted_by_leader": 3}],
            "staff_acceptance": [{"staff_id": f"{pre}-004", "offers": 21, "accepted": 11, "declined": 8, "expired": 2, "accept_rate": 0.524,
                                  "median_response_min": 35.0, "night_accept_rate": 0.4, "last_offer_date": "2026-10-28"}],
            "model_accuracy_trend": [{"run_at": "2026-11-09 17:11", "version": "fake-2", "kind": "logistic", "rows": 413, "auc": 0.77, "logloss": 0.57,
                                      "baseline_logloss": 0.69, "gate_passed": True, "promoted": True, "gate_reasons": ""}],
            "model_calibration": [{"predicted_band": "40〜60%", "n": 120, "avg_predicted": 0.51, "actual_rate": 0.49, "model_version": "fake-2"}],
        }[kind]
        return [r for r in demo if sid is None or r.get("staff_id") in (None, sid)]


def make_insights():
    """GOOGLE_CLOUD_PROJECT があれば BigQuery、無ければフェイク。"""
    return BQInsights() if os.getenv("GOOGLE_CLOUD_PROJECT") else FakeInsights()
