-- 打診の応諾率の推移（月 × 雇用形態 × 勤続年数の帯）。応答までの分は応答があった打診だけ。
SELECT
  o.facility_id,
  f.name                                                AS facility_name,
  DATE_TRUNC(DATE(o.offered_at, 'Asia/Tokyo'), MONTH)   AS month,
  o.employment,
  CASE WHEN o.tenure_years < 3 THEN '1:3年未満' WHEN o.tenure_years < 10 THEN '2:3〜9年' ELSE '3:10年以上' END AS tenure_band,
  COUNT(*)                                              AS offers,
  COUNTIF(o.status = 'accepted')                        AS accepted,
  COUNTIF(o.status = 'declined')                        AS declined,
  COUNTIF(o.status = 'expired')                         AS expired,
  ROUND(SAFE_DIVIDE(COUNTIF(o.status = 'accepted'), COUNT(*)), 3) AS accept_rate,
  ROUND(APPROX_QUANTILES(o.response_min, 2 IGNORE NULLS)[SAFE_OFFSET(1)], 1) AS median_response_min
FROM `${project}.care_ml.fact_offers` o
LEFT JOIN `${project}.care_ml.dim_facility` f USING (facility_id)
GROUP BY o.facility_id, facility_name, month, o.employment, tenure_band
