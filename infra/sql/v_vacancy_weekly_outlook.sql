-- 週ごと（日曜始まり）の欠員数：実績（直近 12 週）と予測（今後 8 週）を 1 本の時系列にしたもの。Looker Studio の折れ線にそのまま使える。
WITH actual AS (
  SELECT facility_id, week_start, vacancies,
         ROW_NUMBER() OVER (PARTITION BY facility_id ORDER BY week_start DESC) AS back
  FROM `${project}.care_ml.v_vacancy_weekly`
)
SELECT a.facility_id, f.name AS facility_name, a.week_start, '実績' AS series,
       CAST(a.vacancies AS FLOAT64) AS vacancies, CAST(NULL AS FLOAT64) AS lower_80, CAST(NULL AS FLOAT64) AS upper_80
FROM actual a LEFT JOIN `${project}.care_ml.dim_facility` f USING (facility_id)
WHERE a.back <= 12
UNION ALL
SELECT facility_id, facility_name, week_start, '予測', forecast_vacancies, lower_80, upper_80
FROM `${project}.care_ml.v_vacancy_forecast`
