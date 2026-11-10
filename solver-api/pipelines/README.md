# 学習パイプライン（Vertex AI Pipelines）

施設ごとに「欠員の打診を受けてもらえるか（応諾確率）」を学習し、リーダーの手修正のくり返しからルール候補を見つける。

```
extract ─┬─ train(施設A) ─┐
         ├─ train(施設B) ─┼─ compare（BigQuery ML と同じ評価データで比較）─ promote（champion / challenger・Model Registry・Experiments・BigQuery）
         └─ train(施設C) ─┘
detect（手修正のくり返し → ルール候補）は並行
```

| ステップ | 内容 |
|---|---|
| extract | BigQuery の打診の履歴（`care_ml.fact_offers`）と、実運用の打診の結果（`events_raw` の `offer_sent` の特徴量＋`offer_responded`）を GCS に |
| train | 施設ごとに、ロジスティック回帰・XGBoost・プール学習（他施設の打診も使う）を交差検証（5分割×2回）で比べる。基準（件数に依らない基本確率）に勝てなければ昇格しない（gate） |
| compare | 欠員 ID のハッシュで 1/5 を評価データに取り置き、BigQuery ML（`care_ml.acc_logistic_reg_<施設>`・`acc_boosted_tree_<施設>`）を残りで学習。いまのモデル（train が選んだ種類）も同じ学習側で作り直し、同じ評価データの対数損失・AUC で比べる。BigQuery ML が勝ち、評価データでも基準を満たし、重み・木を JSON に移した採点が ML.PREDICT と一致（差 ≤ 0.001）したときだけ champion にする。次点で基準を満たすものは challenger（A/B 用） |
| promote | 通ったものを `models/<施設>/champion.json` に（API が読む）。Model Registry に登録（エイリアス `champion`）。履歴を `models/<施設>/history.json` と BigQuery `care_ml.model_runs` に。out-of-fold 予測を `care_ml.offer_scores` に |
| detect | 手修正のくり返しを検出（閾値は観測量から計算）。`learned/<施設>.json` と `care_ml.learned_rule_candidates` に |

```bash
# トレーナーイメージ（コンポーネントの中身）
gcloud builds submit solver-api --config solver-api/pipelines/cloudbuild-trainer.yaml --project gdgoc-514203 --region asia-northeast1
# 定義のコンパイル（infra/pipelines/care-learn.json）/ 1回実行 / 旧: Vertex の週次スケジュール
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py compile
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py run
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py schedule
```

- promote は、基準を満たさなかった施設のモデルも Model Registry に版として残す（エイリアス `candidate`・既定の版にしない。API は使わない）。`champion` のエイリアスは基準を満たした版だけ。
- 指標は Vertex AI Experiments（`care-acceptance`。施設ごとに 1 実行: 件数・交差検証と評価データの AUC / 対数損失）と `care_ml.model_runs`（比較の列 `champion_source`・`eval_*`・`bqml_*_eval_logloss`・`compare_json`）に残る。
- 毎日 04:00 JST に Cloud Scheduler（`care-learn-daily`、起動役 `care-learn-scheduler`。`infra/ml_boost.tf`）が実行する。パイプラインの定義は `infra/pipelines/care-learn.json`（`pipeline.py compile` で更新し、terraform apply で反映）。
- A/B: API の環境変数 `AB_CHALLENGER_SHARE`（0〜1、未設定は 0＝従来どおり）。欠員 ID のハッシュで腕を決め、challenger.json で並べた打診は `offer_sent` の `payload.ab` に腕・モデルの版が残る。腕ごとの応諾率は `care_analytics.ab_offer_outcomes`。
- 実行は `pipeline-sa`（最小権限）。公開 API から起動する経路は無い（課金の悪用を防ぐため）。
- 版名は実行ごとのジョブ ID。週次スケジュールでも成果物を上書きしない。
- 成果物の置き場は `gs://gdgoc-514203-vertex-pipelines`（`runs/` は 30 日で自動削除。`models/` と `learned/` は残る）。
- 学習データは合成データ（架空）が中心。実運用の打診は、API が打診の時点の特徴量を `offer_sent` イベントに残し、次回以降の学習に使われる。
