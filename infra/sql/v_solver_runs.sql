-- ソルバー（CP-SAT、月次＋日次の反復）の実行 1 回ごとの所要時間と結果。roster_proposed イベントを展開したもの。
WITH e AS (
  SELECT JSON_VALUE(data, '$.event_id') AS event_id, JSON_VALUE(data, '$.facility_id') AS facility_id, publish_time,
         SAFE.PARSE_JSON(JSON_VALUE(data, '$.payload')) AS p
  FROM `${project}.care_analytics.events_raw`
  WHERE JSON_VALUE(data, '$.event_type') = 'roster_proposed'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY publish_time) = 1
)
SELECT
  event_id,
  publish_time                          AS solved_at,
  DATE(publish_time, 'Asia/Tokyo')      AS solve_date,
  facility_id,
  JSON_VALUE(p, '$.month')              AS roster_month,
  JSON_VALUE(p, '$.status')             AS status,
  CAST(JSON_VALUE(p, '$.wall_ms') AS INT64) AS wall_ms
FROM e
