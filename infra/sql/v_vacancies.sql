-- 欠員 1 件ごと（Looker Studio の明細・集計の元）。充足までの分 = 欠員を知ってから埋まるまで。合成データ（架空）を含む。
SELECT
  v.facility_id,
  f.name                                                   AS facility_name,
  v.vacancy_id,
  v.date                                                   AS shift_date,
  DATE_TRUNC(v.date, MONTH)                                AS month,
  EXTRACT(DAYOFWEEK FROM v.date)                           AS weekday_num,
  ['日', '月', '火', '水', '木', '金', '土'][OFFSET(EXTRACT(DAYOFWEEK FROM v.date) - 1)] AS weekday_label,
  v.shift,
  v.unit_id,
  v.reason,
  v.lead_hours,
  v.final_route,
  CASE v.final_route WHEN 'offer' THEN '打診で充足' WHEN 'applicant' THEN '応募者で充足' WHEN 'adjusted' THEN 'リーダーが調整' ELSE '未充足' END AS fill_route_label,
  v.filled_at IS NOT NULL                                  AS is_filled,
  ROUND(TIMESTAMP_DIFF(v.filled_at, v.discovered_at, SECOND) / 60, 1) AS minutes_to_fill,
  v.n_offers
FROM `${project}.care_ml.fact_vacancies` v
LEFT JOIN `${project}.care_ml.dim_facility` f USING (facility_id)
