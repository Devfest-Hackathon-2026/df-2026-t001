-- 施設ごとの週別の欠員数を ARIMA_PLUS で学習する（施設ごとに別の時系列）。週次のスケジュールドクエリでも同じ文を実行する。
-- 日別では件数が少なく（1 日 0〜3 件）ばらつきが大きいため、週別にまとめて学習する。
CREATE OR REPLACE MODEL `${project}.care_ml.m_vacancy_forecast`
OPTIONS (
  model_type = 'ARIMA_PLUS',
  time_series_timestamp_col = 'week_start',
  time_series_data_col = 'vacancies',
  time_series_id_col = 'facility_id',
  data_frequency = 'WEEKLY',
  auto_arima = TRUE,
  horizon = 12
) AS
SELECT facility_id, week_start, vacancies FROM `${project}.care_ml.v_vacancy_weekly`
