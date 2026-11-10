-- 施設 × 曜日 × 勤務帯ごとの欠員の発生数と、充足までの時間（分）。全期間の集計。
SELECT
  facility_id,
  ANY_VALUE(facility_name)                          AS facility_name,
  weekday_num,
  ANY_VALUE(weekday_label)                          AS weekday_label,
  shift,
  COUNT(*)                                          AS vacancies,
  COUNTIF(is_filled)                                AS filled,
  ROUND(SAFE_DIVIDE(COUNTIF(is_filled), COUNT(*)), 3) AS fill_rate,
  ROUND(AVG(minutes_to_fill), 1)                    AS avg_minutes_to_fill,
  ROUND(APPROX_QUANTILES(minutes_to_fill, 2 IGNORE NULLS)[SAFE_OFFSET(1)], 1) AS median_minutes_to_fill,
  ROUND(AVG(lead_hours), 1)                         AS avg_lead_hours,
  COUNTIF(final_route = 'offer')                    AS filled_by_offer,
  COUNTIF(final_route = 'applicant')                AS filled_by_applicant,
  COUNTIF(final_route = 'adjusted')                 AS adjusted_by_leader
FROM `${project}.care_ml.v_vacancies`
GROUP BY facility_id, weekday_num, shift
