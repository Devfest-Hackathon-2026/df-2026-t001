# 学習パイプライン（Vertex AI Pipelines）

施設ごとに「欠員の打診を受けてもらえるか（応諾確率）」を学習し、リーダーの手修正のくり返しからルール候補を見つける。

```
extract ─┬─ train(施設A) ─┐
         ├─ train(施設B) ─┼─ promote（基準を満たしたものを champion に・Model Registry・BigQuery）
         └─ train(施設C) ─┘
detect（手修正のくり返し → ルール候補）は並行
```

| ステップ | 内容 |
|---|---|
| extract | BigQuery の打診の履歴（`care_ml.fact_offers`）と、実運用の打診の結果（`events_raw` の `offer_sent` の特徴量＋`offer_responded`）を GCS に |
| train | 施設ごとに、ロジスティック回帰・XGBoost・プール学習（他施設の打診も使う）を交差検証（5分割×2回）で比べる。基準（件数に依らない基本確率）に勝てなければ昇格しない（gate） |
| promote | 通ったものを `models/<施設>/champion.json` に（API が読む）。Model Registry に登録（エイリアス `champion`）。履歴を `models/<施設>/history.json` と BigQuery `care_ml.model_runs` に。out-of-fold 予測を `care_ml.offer_scores` に |
| detect | 手修正のくり返しを検出（閾値は観測量から計算）。`learned/<施設>.json` と `care_ml.learned_rule_candidates` に |

```bash
# トレーナーイメージ（コンポーネントの中身）
gcloud builds submit solver-api --config solver-api/pipelines/cloudbuild-trainer.yaml --project gdgoc-514203 --region asia-northeast1
# 1回実行 / 週次スケジュール（月曜 03:00 JST）を作る
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py run
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py schedule
```

- 実行は `pipeline-sa`（最小権限）。公開 API から起動する経路は無い（課金の悪用を防ぐため）。
- 版名は実行ごとのジョブ ID。週次スケジュールでも成果物を上書きしない。
- 成果物の置き場は `gs://gdgoc-514203-vertex-pipelines`（`runs/` は 30 日で自動削除。`models/` と `learned/` は残る）。
- 学習データは合成データ（架空）が中心。実運用の打診は、API が打診の時点の特徴量を `offer_sent` イベントに残し、次回以降の学習に使われる。
