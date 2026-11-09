"""チャット用の BigQuery 集計。決まった問い合わせ（パラメータは施設 ID だけ）だけを実行する。自由な SQL は受け付けない。

対象は care_ml（学習・分析用のデータセット）。API のサービスアカウントは読み取り専用。履歴には合成データ（架空）を含む。
"""
from __future__ import annotations

import os

QUERIES: dict[str, tuple[str, str]] = {
    "offer_acceptance_by_shift": ("勤務区分ごとの打診数・応諾率・応答までの時間の中央値（分）",
                                  """SELECT shift, COUNT(*) AS offers, ROUND(AVG(IF(status='accepted',1,0)),3) AS accept_rate,
                                     ROUND(APPROX_QUANTILES(response_min, 2)[OFFSET(1)],1) AS median_response_min
                                     FROM `{p}.care_ml.fact_offers` WHERE facility_id=@f GROUP BY shift ORDER BY shift"""),
    "offer_acceptance_by_lead": ("依頼までの余裕（時間）ごとの応諾率",
                                 """SELECT CASE WHEN lead_hours<8 THEN '1:8時間未満' WHEN lead_hours<30 THEN '2:8〜30時間' ELSE '3:30時間以上' END AS lead,
                                    COUNT(*) AS offers, ROUND(AVG(IF(status='accepted',1,0)),3) AS accept_rate
                                    FROM `{p}.care_ml.fact_offers` WHERE facility_id=@f GROUP BY lead ORDER BY lead"""),
    "vacancies_by_month": ("月ごとの欠員数・平均の余裕時間・どう埋まったか",
                           """SELECT FORMAT_DATE('%Y-%m', date) AS month, COUNT(*) AS vacancies, ROUND(AVG(lead_hours),1) AS avg_lead_hours,
                              COUNTIF(final_route='offer') AS filled_by_offer, COUNTIF(final_route='applicant') AS filled_by_applicant,
                              COUNTIF(final_route='adjusted') AS adjusted_by_leader
                              FROM `{p}.care_ml.fact_vacancies` WHERE facility_id=@f GROUP BY month ORDER BY month"""),
    "removal_hotspots": ("リーダーが勤務を外した回数が多い『人×曜日×勤務』の上位（手修正のくり返し）",
                         """SELECT staff_id, weekday, from_shift AS shift, COUNT(*) AS removals, COUNT(DISTINCT month) AS months
                            FROM `{p}.care_ml.fact_roster_edits` WHERE facility_id=@f AND to_shift IN ('', '休') AND from_shift NOT IN ('', '休')
                            GROUP BY staff_id, weekday, shift ORDER BY months DESC, removals DESC LIMIT 10"""),
    "night_counts_by_staff": ("これまでの夜勤回数が多い人の上位（偏りの確認）",
                              """SELECT staff_id, COUNT(*) AS nights FROM `{p}.care_ml.fact_assignments`
                                 WHERE facility_id=@f AND shift='夜勤' AND status!='absent' GROUP BY staff_id ORDER BY nights DESC LIMIT 10"""),
}


class BQAnalytics:
    def __init__(self, project: str | None = None) -> None:
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT")
        self._bq = None

    def kinds(self) -> dict[str, str]:
        return {k: v[0] for k, v in QUERIES.items()}

    def run(self, kind: str, fid: str) -> list[dict]:
        from google.cloud import bigquery

        if kind not in QUERIES:
            raise ValueError(f"kind は {sorted(QUERIES)} のいずれか")
        if self._bq is None:
            self._bq = bigquery.Client(project=self.project)
        cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("f", "STRING", fid)], maximum_bytes_billed=50 * 1024 * 1024)
        rows = self._bq.query(QUERIES[kind][1].format(p=self.project), job_config=cfg).result()
        return [{k: (v if isinstance(v, (int, float, str, type(None))) else str(v)) for k, v in dict(r).items()} for r in rows][:20]


class FakeAnalytics:
    """テスト用。"""

    def __init__(self, data: dict | None = None) -> None:
        self.data, self.calls = data or {}, []

    def kinds(self):
        return {k: v[0] for k, v in QUERIES.items()}

    def run(self, kind, fid):
        self.calls.append((kind, fid))
        if kind not in QUERIES:
            raise ValueError("unknown kind")
        return self.data.get(kind, [])
