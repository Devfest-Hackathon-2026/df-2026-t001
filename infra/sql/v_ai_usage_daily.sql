-- AI の利用状況（日 × 機能 × モデル）：回数・トークン・応答時間（平均・中央値・95 パーセンタイル）。
SELECT
  call_date,
  feature,
  model,
  COUNT(*)                                                    AS calls,
  SUM(input_tokens)                                           AS input_tokens,
  SUM(output_tokens)                                          AS output_tokens,
  SUM(thinking_tokens)                                        AS thinking_tokens,
  SUM(total_tokens)                                           AS total_tokens,
  ROUND(AVG(latency_ms))                                      AS avg_latency_ms,
  APPROX_QUANTILES(latency_ms, 100 IGNORE NULLS)[SAFE_OFFSET(50)] AS p50_latency_ms,
  APPROX_QUANTILES(latency_ms, 100 IGNORE NULLS)[SAFE_OFFSET(95)] AS p95_latency_ms
FROM `${project}.care_analytics.v_ai_usage`
GROUP BY call_date, feature, model
