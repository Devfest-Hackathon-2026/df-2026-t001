# 助っ人ケア（介護夜勤欠員）アーキテクチャ設計 v0.1（歴史的な記録）

> **この文書は、2026-11-09 時点の初期設計の記録です。** 以降の v0.2・v0.3 と実装で、内容は大きく変わりました。現在の構成は [README](../README.md) と [ARCHITECTURE_v0.3_cpsat.md](ARCHITECTURE_v0.3_cpsat.md) を参照してください。本文の「現状」「未決事項」「段階計画」「リスク」は当時の記述で、実際の結果は末尾の「8. 実際の結果」にまとめています。

対象: GCP `gdgoc-514203`（#268178492831）/ リポジトリ: 提出用 `Devfest-Hackathon-2026/df-2026-t001`（開発用 `32Lwk/gdgoc-care-connect`）
前提: デモ用の架空データのみ・一般公開・予算上限なし（ユーザー確認済み）。当時、このドキュメントは設計のみで、GCP 側は未変更だった。

## 1. 当時の現状（調査結果）

| 項目 | 内容 |
|---|---|
| プロダクト | 介護施設の夜勤欠員1件を `vacancyId` で「打診→掲載→充足」まで閉じる。画面は リーダー(`index.html`) と 従業員スマホ(`employee.html`) |
| 実装 | 静的HTML/JS（`assets/js/app.js` 約1.6k行、`data.js` 架空35名、`flow-state.js`）。状態は `localStorage` のみ＝**サーバーもDBも無い** |
| 当時の配信 | Cloudflare Workers（`care.yutok.dev`）。`firebase.json` は準備済みだが未デプロイだった（のちに Cloudflare を廃止し、Firebase Hosting に移した。末尾「ドメイン」） |
| GCP | Cloud Run `nurse-shift`（別メンバー作成、IAM空=非公開）、Artifact Registry、Cloud Storage(ソースzip)。Firestore/Compute/Cloud SQL は有効化されておらず、Vertex AI(`aiplatform`)も当時は無効だった（のちに必要なものを有効化。§8） |
| 期限 | **コードフリーズ・提出 2026-11-10 19:00 JST**（今日は11-09）。必須: Firebase Hosting または Cloud Run 等でデモ公開 |
| 注意 | `nurse-shift` は看護師向けの別物の可能性。本製品は介護士が主眼 |

## 2. 目標アーキテクチャ

```
 ブラウザ（リーダーPC / 従業員スマホ）
        │ HTTPS（単一オリジン）
        ▼
 Firebase Hosting ──(静的: index.html, employee.html, assets)
        │ /api/** を rewrite
        ▼
 Cloud Run  care-api (FastAPI, Python)   ← SA: care-api-sa（最小権限）
   ├─ Firestore (Native, asia-northeast1)  ← 業務データ（正本）
   │     employees / shifts / vacancies / offers / healthChecks / chats / preferences
   │     ※ ブラウザは onSnapshot で購読 → 打診・充足が即時に画面反映（動的化）
   ├─ Vertex AI Gemini (global endpoint) ← 生成・分析
   │     ① 月次シフト自動割当（構造化JSON出力＋ルール検証）
   │     ② 過去希望ベースの優先打診候補＋理由1文
   │     ③ 健康チェック傾向の要約（診断・就業可否の自動判断はしない）
   │     ④ 自然言語チャット（function calling で Firestore/BigQuery を検索、希望の構造化）
   │     ⑤ BigQuery分析の要約インサイト
   └─ Pub/Sub topic `care-events` ──(BigQuery subscription)──▶ BigQuery `care_analytics.events`
                                                      └─ ビュー: 欠員リードタイム, 充足率, 夜勤偏り, 健康傾向
 GitHub Actions ──(Workload Identity Federation, 鍵なし)──▶ Cloud Build / Cloud Run / Hosting デプロイ
```

### 設計判断と理由
- **Hosting + Cloud Run の単一オリジン**: 既存静的UIをほぼ無改修で配信しつつ、`/api/**` をCloud Runへ。CORS不要で提出要件（Firebase Hosting）も満たす。
- **Firestore を正本、BigQuery は分析専用**: 欠員フローは小さなトランザクションが中心（Firestore向き）。分析・Gemini根拠データはBQ。役割が明確でピッチで説明しやすい。
- **Firestore→BQ は Pub/Sub の BigQuery subscription**: API がイベントを1回 publish するだけで、拡張機能や Dataflow 不要。ほぼ無運用。
- **Gemini は Vertex AI（IAM認証、キー不要）**: 最新 Pro 系を global endpoint で、軽い処理は Flash を併用。モデルID・旧称（現 Gemini Enterprise Agent Platform）は実装時に公式ドキュメントで再確認。
- **AIは「提案」まで**: 候補順位・割当案は理由付き提案。確定は人（リーダー/本人）。割当はルールエンジンで必須制約（人数・スキル・退勤上限・休憩）を決定的に検証して二重チェック。
- **認証**: デモ用固定ログイン（役割: リーダー/従業員）。公開＋AIは対策なしの方針なので、APIにIPあたりの簡易レート制限だけは入れることを推奨（任意）。

## 3. GCPリソース一覧（新規／既存）

| リソース | 状態 | 備考 |
|---|---|---|
| API: `aiplatform`, `firestore`, `firebase`, `firebasehosting`, `secretmanager`, `pubsub`(有効), `bigquery`(有効), `iamcredentials`(有効) | 要有効化 | 変更のため承認後に実施 |
| Firestore DB `(default)` | 新規 | Native / asia-northeast1 |
| BigQuery dataset `care_analytics`（asia-northeast1） | 新規 | `events`、分析ビュー |
| Pub/Sub topic `care-events` + BQ subscription | 新規 | |
| Cloud Run `care-api` | 新規 | asia-northeast1、min 0 / max 10、同時実行80（計画。実際は max 3・同時実行 40。§8） |
| Service Account `care-api-sa` | 新規 | `datastore.user`, `aiplatform.user`, `pubsub.publisher`, `bigquery.dataViewer/jobUser`（データセット限定） |
| Service Account `gh-deployer` + WIF Pool | 新規 | GitHubの `32Lwk/gdgoc-care-connect` のみ許可 |
| Artifact Registry `cloud-run-source-deploy` | 既存 | 流用 |
| Cloud Run `nurse-shift` | 既存 | 扱い要判断（§6） |
| Budget alert | 新規(任意) | 通知のみ・上限なし |

IaC は Terraform（`infra/`）。既存リソースは `import` し、状態は GCS バケット `gdgoc-514203-tfstate` に置く。

## 4. 動的化の方針（フロント）
1. `flow-state.js` の `localStorage` を **API＋Firestore購読** に置換（同じ状態形を保ち、UI改修を最小化）。
2. リーダー画面と従業員画面が**同じ `vacancyId` を共有**し、片方で打診→もう片方に即反映（デモの見せ場）。
3. ハードコードの `data.js` を Firestore のシードに変換（`scripts/seed.py`）。
4. AI呼び出しは `/api/ai/*`。待ち時間はスケルトン/理由1文のストリーミング表示。

## 5. 段階計画（締切 11-10 19:00 逆算）

| Phase | 内容 | 完了の定義 |
|---|---|---|
| P0 基盤 | API有効化、Firestore/BQ/Pub/Sub/SA、Terraform骨格、Firebase連携 | `terraform plan` が差分ゼロ |
| P1 API骨格 | FastAPI + Firestore、欠員フロー(D01-D09)をAPI化、シード投入、Hosting rewrite | 2画面でvacancyIdが同期 |
| P2 Gemini | ①月次割当 ②優先候補 ④チャット ③健康要約 | 4機能がデモ動線で動く |
| P3 BigQuery | イベント流入、ビュー、⑤インサイト | ダッシュボード/要約が実データで表示 |
| P4 CI/CD | GitHub Actions + WIF、Hosting/Run自動デプロイ | main push で反映 |
| P5 提出 | `t001` 向けクリーン化（LFSメディア・内部メモ除外、シークレット検査）、README | 公開リポジトリで再現可能 |

優先順位: **P1 → P2(①②) → P4簡易 → P3 → P2残り**。時間が足りなければP3のインサイトとP2③を縮小。

## 6. 当時の未決事項（回答済み。§8 の表）
1. `nurse-shift`（別メンバー作成・非公開）を削除/置換/残置どれにするか
2. API言語（Python FastAPI 推奨 / Node）
3. Firebaseを既存GCPプロジェクトに追加してよいか（Hosting用、課金プロジェクトに紐付く）
4. 今夜からのGCP変更（API有効化・リソース作成）を段階承認で進めるか
5. Cloudflare（`care.yutok.dev`）は残す/止める

## 7. 当時のリスク
- 期限まで約1日。範囲が広いため、P1完了までは機能追加を止める。
- 公開エンドポイントでGemini/BQが叩ける設計は課金増・悪用の余地あり（ユーザー方針で上限なし）。最低限のレート制限と予算通知は低コストで推奨。
- `data.js` に `EMP-021` の重複IDがある（シード時に修正が必要）。
- 公開リポジトリ(t001)へ移す際、LFSメディア・内部メモ・内部台帳は除外する（提出用リポジトリには含めていない）。

## 8. 実際の結果（2026-11-10 時点）

| 当時の記述 | 実際 |
|---|---|
| Firestore を正本にし、ブラウザは onSnapshot で購読 | 画面の状態は `care-api`（`PUT/GET /api/state`）経由で Firestore に同期する（`public/sync.js`）。ブラウザから Firestore へは直接つながない（`firestore.rules` は全拒否） |
| Cloud Run `care-api`：max 10・同時実行 80 | max 3・同時実行 40（`infra/main.tf`） |
| 月次割当を Gemini が構造化 JSON で出す | 割当は OR-Tools CP-SAT が行い、Gemini はルールの翻訳・説明・チャット・文面の作成だけを担う（v0.2 以降） |
| Hosting の `/api/**` を Cloud Run `care-api` に rewrite | そのとおり（状態の同期用）。最適化ソルバー `care-solver-api` は、画面から CORS で直接呼ぶ |
| 未決 1: `nurse-shift` の扱い | 触らず残置 |
| 未決 2: API 言語 | Python FastAPI |
| 未決 3: Firebase の追加 | `gdgoc-514203` に追加済み（Hosting サイト `gdgoc-514203`） |
| 未決 4: GCP 変更の進め方 | フェーズごとに承認を得て実施 |
| 未決 5: Cloudflare | 廃止（次の「ドメイン」） |
| 段階計画 P0〜P5 | 基盤・API・Gemini・BigQuery・CI/CD は、v0.2・v0.3 の段階計画に組み替えて完了した（実際の分割と結果は `ARCHITECTURE_v0.3_cpsat.md`）。提出（P5）は、このリポジトリへの書き出しで行った |

## ドメイン
`care.yutok.dev` は Cloudflare の DNS（プロキシOFF・CNAME）で Firebase Hosting に直結する。配信・API・CI は GCP のみで、Cloudflare Worker / Workers CI は使わない（廃止済み）。Web APIキーのリファラ制限は `care.yutok.dev` と `*.web.app` を許可。
