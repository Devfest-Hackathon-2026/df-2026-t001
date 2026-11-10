-- 施設 × 月ごとの欠員数と充足までの時間（分）の推移。
SELECT
  facility_id,
  ANY_VALUE(facility_name)                          AS facility_name,
  month,
  COUNT(*)                                          AS vacancies,
  COUNTIF(is_filled)                                AS filled,
  ROUND(AVG(minutes_to_fill), 1)                    AS avg_minutes_to_fill,
  ROUND(APPROX_QUANTILES(minutes_to_fill, 2 IGNORE NULLS)[SAFE_OFFSET(1)], 1) AS median_minutes_to_fill,
  COUNTIF(final_route = 'offer')                    AS filled_by_offer,
  COUNTIF(final_route = 'applicant')                AS filled_by_applicant,
  COUNTIF(final_route = 'adjusted')                 AS adjusted_by_leader
FROM `${project}.care_ml.v_vacancies`
GROUP BY facility_id, month
