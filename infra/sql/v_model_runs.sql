-- 応諾予測モデルの学習ごとの精度（AUC・対数損失）と、昇格したか。
SELECT
  r.facility_id,
  f.name                                                AS facility_name,
  r.run_at,
  DATE(r.run_at, 'Asia/Tokyo')                          AS run_date,
  r.version,
  r.kind                                                AS model_kind,
  r.rows                                                AS train_rows,
  r.live_rows,
  r.auc,
  r.logloss,
  r.baseline_logloss,
  ROUND(SAFE_DIVIDE(r.baseline_logloss - r.logloss, r.baseline_logloss), 4) AS logloss_gain,
  r.gate_passed,
  r.promoted,
  NULLIF(r.gate_reasons, '')                            AS gate_reasons
FROM `${project}.care_ml.model_runs` r
LEFT JOIN `${project}.care_ml.dim_facility` f USING (facility_id)
