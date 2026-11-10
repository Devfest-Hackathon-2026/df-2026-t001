# infra（Terraform）

GCP プロジェクト `gdgoc-514203` のうち、本製品が使うリソースを Terraform で管理している。**適用済み**（2026-11-09 に P0 の `main.tf`・`ml.tf` を、その後 `solver.tf` を、2026-11-10 に `monitoring.tf`・`edge.tf`・`realtime.tf` を `-target` で適用）。状態は GCS バケット `gdgoc-514203-tfstate`（prefix `care`）に置く。

| ファイル | 内容 |
|---|---|
| `main.tf` | API の有効化、Firestore、BigQuery `care_analytics`、Pub/Sub `care-events` と BigQuery subscription、`care-api` 用のサービスアカウント、WIF（GitHub Actions）、Cloud Run `care-api`（画面状態の同期用。最大 3 インスタンス・同時実行 40） |
| `ml.tf` | BigQuery `care_ml`、GCS `gdgoc-514203-vertex-pipelines`（30 日で自動削除）、`pipeline-sa` と最小権限（Vertex AI Pipelines の実行用） |
| `solver.tf` | Cloud Run `care-solver-api`（最適化ソルバー・AI・学習。4 vCPU・2GiB・最小 0/最大 3・同時実行 4・タイムアウト 60 秒）と `care-solver-sa` |
| `monitoring.tf` | 監視: `care-solver-api` の SLO（可用性 99%・応答時間 95% が 8 秒以内、いずれも 7 日間）、アラート（Uptime・5xx の割合・p95・インスタンス数の上限・AI の 429/503・DLP の失敗・Pub/Sub の未配信・BigQuery サブスクリプションの失敗・SLO の消費速度）、ログベースの指標（`care_solver_ai_rejected`・`care_solver_dlp_failures`・`care_solver_busy`）、ダッシュボード、`/api/healthz` の Uptime check。**通知チャネルは未設定**（コンソールのインシデントに出るだけ） |
| `edge.tf` | 並行の新しい入口: 外部 HTTPS ロードバランサ（サーバーレス NEG → `care-solver-api`）+ Cloud Armor `care-edge-armor`（OWASP 事前定義ルール 感度 1、IP ごとのレート制限、適応型保護）。ホスト名は LB の IP から作る `<IP をハイフン区切り>.sslip.io`（Google マネージド証明書）。**run.app の URL・公開設定はそのまま**で、画面はまだ切り替えていない |
| `realtime.tf` | リアルタイムの学習データ: Firestore の `facilities/{fid}/vacancies/{vid}` と `.../offers/{oid}` の書き込み → Eventarc（asia-northeast1）→ Cloud Run `care-ml-stream`（`functions/ml_stream/`）→ BigQuery `care_ml.fact_vacancies_stream` / `fact_offers_stream`（変更の履歴）と `*_latest` ビュー |
| `outputs.tf` / `variables.tf` | 出力（`wif_provider`、`deployer_sa`）と変数 |

```bash
cd infra && terraform init && terraform plan
# 新しいリソースだけを適用するときは -target を付ける（既存の care-api・nurse-shift には触れない）
# 例: terraform apply -target=google_cloud_run_v2_service.solver
```

- 既存の Artifact Registry（`cloud-run-source-deploy`）は管理対象外で、流用している。`nurse-shift`（別メンバーの Cloud Run）には触れない。
- `terraform output` の `wif_provider` と `deployer_sa` は、GitHub の Variables（`WIF_PROVIDER`、`DEPLOYER_SA`）に登録して使う（鍵ファイルなしのデプロイ）。
- 予算アラートは、課金アカウントの権限がないため Terraform では管理していない（課金は手動で確認している）。

## 監視・入口・リアルタイムの学習データ（monitoring.tf / edge.tf / realtime.tf）

- 既存のリソース（Cloud Run・サブスクリプション・データセット）は**名前で参照**している。resource を参照すると `-target` の適用で既存のサービスまで更新対象に入るため。
- 新しい入口の URL は `terraform output edge_url`。Cloud Armor の `throttle` は優先度が先の一致で評価が止まるので、OWASP（1000 番台）→ AI（2000）→ 求解（2100）→ 全体（9000）の順に置いている。
- **切り替える前に**: アプリ（`solver-api/care/guard.py` の `client_ip`）は `X-Forwarded-For` の末尾を利用者の IP とみなす。LB を通すと末尾に LB 側のアドレスが付くため、IP ごとのレート制限と AI の上限が全員で 1 つにまとまるおそれがある。切り替えるときはアプリ側の扱いを直す（または LB の IP を除く）こと。画面の CSP の `connect-src` にも新しいホスト名を足す必要がある。
- `*_stream` の `source` は `solver-api/care/learn/steps.py` と同じ区別（文書に `synthetic` があれば合成、無ければライブ）。既存の `fact_*`（合成）には書かない。学習に使うときは `*_latest` を `source = 'live'` で絞る。

```bash
# 関数のイメージ（タグを上げたら variables の ml_stream_image も合わせる）
gcloud builds submit functions/ml_stream --project gdgoc-514203 --region asia-northeast1 \
  --tag asia-northeast1-docker.pkg.dev/gdgoc-514203/cloud-run-source-deploy/care-ml-stream:v1
# 関数のテスト
cd functions/ml_stream && pip install -r requirements-dev.txt && python -m pytest -q tests
```
