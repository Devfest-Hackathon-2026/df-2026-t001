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
| extract | BigQuery の打診の履歴（`care_ml.fact_offers`）を GCS に。実運用の打診の結果（`events_raw` の `offer_sent` の特徴量＋`offer_responded`）は、パラメータ `live_sources` で明示したときだけ、上限つきで足す（下記） |
| train | 施設ごとに、ロジスティック回帰・XGBoost・プール学習（他施設の打診も使う）を交差検証（5分割×2回）で比べる。基準（件数に依らない基本確率）に勝てなければ昇格しない（gate） |
| promote | 通ったものを `models/<施設>/champion.json` に（API が読む）。Model Registry に登録（エイリアス `champion`。ロジスティックは `model.joblib`＋sklearn コンテナ、XGBoost は `model.bst`＋xgboost コンテナ）。登録に失敗したら、champion・履歴・BigQuery を書き終えたあとでステップを失敗にする（黙って飛ばさない）。履歴を `models/<施設>/history.json` と BigQuery `care_ml.model_runs` に。out-of-fold 予測を `care_ml.offer_scores` に |
| detect | 手修正のくり返しを検出（閾値は観測量から計算）。既定は合成の手修正（`care_ml.fact_roster_edits`）だけ。実運用の `roster_edit` イベントは `live_sources` を明示したときだけ。`learned/<施設>.json` と `care_ml.learned_rule_candidates` に |

```bash
# トレーナーイメージ（コンポーネントの中身）
gcloud builds submit solver-api --config solver-api/pipelines/cloudbuild-trainer.yaml --project gdgoc-514203 --region asia-northeast1   # イメージ名は $PROJECT_ID から
# 1回実行 / 週次スケジュール（月曜 03:00 JST）を作る
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py run
solver-api/.venv/bin/python solver-api/pipelines/pipeline.py schedule
# 別プロジェクトでは環境変数で: GOOGLE_CLOUD_PROJECT / PIPELINE_ROOT / TRAINER_IMAGE / PIPELINE_SA / PIPELINE_LOCATION / PIPELINE_FACILITIES
# 実運用イベントを使う実行: LIVE_SOURCES=trusted solver-api/.venv/bin/python solver-api/pipelines/pipeline.py run
```

## 実運用イベントと学習データの汚染対策

`events_raw` の実運用イベント（`offer_sent` / `offer_responded` / `roster_edit`）は、認証の無い公開デモ API から誰でも書ける。
そのまま学習・検出に使うと、応諾予測やルール候補を外から操作できてしまう。そこで:

- **既定では使わない**。パイプラインのパラメータ `live_sources`（既定 `""`）が空なら、学習は合成データ（`care_ml.fact_offers`）だけ、検出は `care_ml.fact_roster_edits` だけ。
- 使うときは、出どころ（イベントの `data.source`）をカンマ区切りで明示する。例 `trusted`（認証つきの運用だけ）、`trusted,public_api`（公開 API も）。
  `data.source` が無いイベントは `public_api` とみなす。
- 上限: 1人（施設×職員）あたり `cap_per_staff`（既定 20 件）、1つの送信元 IP（`data.ip_hash`）あたり `cap_per_ip`（既定 50 件）。新しいものから数える。
  `ip_hash` が無いイベントはまとめて1つの IP（`unknown`）として数える（安全側）。
- 出どころの印は API（`care/service.py` の `Events.emit`）が付ける: `"source": os.getenv("EVENT_SOURCE", "public_api")`。公開デモの Cloud Run は既定のまま（`public_api`）、認証つきの運用環境だけ `EVENT_SOURCE=trusted` にする。

- 実行は `pipeline-sa`（最小権限）。公開 API から起動する経路は無い（課金の悪用を防ぐため）。
- 版名は実行ごとのジョブ ID。週次スケジュールでも成果物を上書きしない。
- 成果物の置き場は `gs://gdgoc-514203-vertex-pipelines`（`runs/` は 30 日で自動削除。`models/` と `learned/` は残る）。
- 学習データは合成データ（架空）が中心。実運用の打診は、API が打診の時点の特徴量を `offer_sent` イベントに残す。学習に使うのは `live_sources` で出どころを明示したときだけ（上記）。
- 依存の版は `Dockerfile.trainer` で固定（`kfp`・`google-cloud-aiplatform`・`pyarrow`・`db-dtypes` は下限のみ）。
