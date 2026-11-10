-- 施設 × 週（日曜始まり）ごとの欠員数。7 日そろった週だけ。時系列予測モデル（m_vacancy_forecast）の学習データ。
SELECT facility_id, DATE_TRUNC(shift_date, WEEK(SUNDAY)) AS week_start, SUM(vacancies) AS vacancies
FROM `${project}.care_ml.v_vacancy_daily`
GROUP BY facility_id, week_start
HAVING COUNT(*) = 7
