-- 施設 × 日ごとの欠員数（欠員が無い日も 0 で埋める）。時系列予測モデルの学習データ。
WITH span AS (
  SELECT facility_id, MIN(date) AS d0, MAX(date) AS d1 FROM `${project}.care_ml.fact_vacancies` GROUP BY facility_id
), cal AS (
  SELECT s.facility_id, d AS shift_date FROM span s, UNNEST(GENERATE_DATE_ARRAY(DATE_TRUNC(s.d0, MONTH), s.d1)) d
)
SELECT c.facility_id, c.shift_date, COUNT(v.vacancy_id) AS vacancies
FROM cal c
LEFT JOIN `${project}.care_ml.fact_vacancies` v ON v.facility_id = c.facility_id AND v.date = c.shift_date
GROUP BY c.facility_id, c.shift_date
