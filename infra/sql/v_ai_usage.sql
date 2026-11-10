-- AI（Gemini）呼び出し 1 回ごとのトークン数と応答時間。ai_call イベントを展開したもの。Pub/Sub の重複配信は event_id で 1 件にする。
WITH e AS (
  SELECT JSON_VALUE(data, '$.event_id') AS event_id, JSON_VALUE(data, '$.facility_id') AS facility_id, publish_time,
         SAFE.PARSE_JSON(JSON_VALUE(data, '$.payload')) AS p
  FROM `${project}.care_analytics.events_raw`
  WHERE JSON_VALUE(data, '$.event_type') = 'ai_call'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY publish_time) = 1
)
SELECT
  event_id,
  publish_time                                   AS called_at,
  DATE(publish_time, 'Asia/Tokyo')               AS call_date,
  facility_id,
  JSON_VALUE(p, '$.feature')                     AS feature,
  JSON_VALUE(p, '$.models[0]')                   AS model,
  JSON_VALUE(p, '$.route')                       AS route,
  CAST(JSON_VALUE(p, '$.input_tokens') AS INT64)    AS input_tokens,
  CAST(JSON_VALUE(p, '$.output_tokens') AS INT64)   AS output_tokens,
  CAST(JSON_VALUE(p, '$.thinking_tokens') AS INT64) AS thinking_tokens,
  COALESCE(CAST(JSON_VALUE(p, '$.input_tokens') AS INT64), 0) + COALESCE(CAST(JSON_VALUE(p, '$.output_tokens') AS INT64), 0)
    + COALESCE(CAST(JSON_VALUE(p, '$.thinking_tokens') AS INT64), 0) AS total_tokens,
  CAST(JSON_VALUE(p, '$.ms') AS INT64)           AS latency_ms
FROM e
