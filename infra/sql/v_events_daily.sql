-- 業務イベントの日別件数（日 × 施設 × 種類）。合成データ（架空の履歴）かどうかも分ける。
SELECT
  DATE(publish_time, 'Asia/Tokyo')                      AS event_date,
  JSON_VALUE(data, '$.facility_id')                     AS facility_id,
  JSON_VALUE(data, '$.event_type')                      AS event_type,
  COALESCE(SAFE_CAST(JSON_VALUE(data, '$.synthetic') AS BOOL), FALSE) AS is_synthetic,
  COUNT(DISTINCT JSON_VALUE(data, '$.event_id'))        AS events
FROM `${project}.care_analytics.events_raw`
GROUP BY 1, 2, 3, 4
