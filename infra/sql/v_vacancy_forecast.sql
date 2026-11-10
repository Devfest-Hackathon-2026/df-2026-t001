-- 施設ごとの今後 8 週の欠員数の予測（週別・80% 予測区間、ARIMA_PLUS）。負の値は 0 にそろえる。
SELECT
  f.facility_id,
  d.name                                                        AS facility_name,
  DATE(f.forecast_timestamp)                                    AS week_start,
  ROUND(GREATEST(f.forecast_value, 0), 2)                       AS forecast_vacancies,
  ROUND(GREATEST(f.prediction_interval_lower_bound, 0), 2)      AS lower_80,
  ROUND(GREATEST(f.prediction_interval_upper_bound, 0), 2)      AS upper_80
FROM ML.FORECAST(MODEL `${project}.care_ml.m_vacancy_forecast`, STRUCT(8 AS horizon, 0.8 AS confidence_level)) f
LEFT JOIN `${project}.care_ml.dim_facility` d USING (facility_id)
