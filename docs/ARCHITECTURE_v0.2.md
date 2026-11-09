# 仮名（介護夜勤欠員）アーキテクチャ設計 v0.2 — 学習する施設特化シフト

対象: GCP `gdgoc-514203` / リポジトリ `32Lwk/gdgoc-care-connect`
v0.1（`ARCHITECTURE.md`）からの差分: **施設・個人ごとに学習が進み、精度と効率が上がる**構成へ拡張。
**このドキュメントは設計のみで、GCP側は未変更。** GCP変更はフェーズごとに承認を得てから実施する。

## 1. 確定した方針（ユーザー回答）

| 論点 | 決定 |
|---|---|
| 学習の深さ | BQML ＋ Vertex AI カスタム学習 ＋ Pipelines ＋ Gemini記憶（全力でGoogle活用） |
| 割当エンジン | OR-Tools CP-SAT ＋ Gemini（制約は決定的に保証、Geminiは翻訳と説明） |
| 学習データ | スクリプトで合成（架空のみ、実データは使わない） |
| 施設数 | 3施設（マルチテナント） |
| 基礎コード | `gdgoc-care-connect`（Vite/TS） |
| GCP変更 | フェーズごとに承認 |
| Geminiの階層 | 重い処理は Pro、軽い処理は Flash |
| 乱用対策 | IPレート制限 ＋ 予算アラート（通知のみ） |
| 推論方式 | Pipelinesでカスタム学習 → **バッチ予測**（常時Endpointは持たない） |
| ベクトル検索 | BigQuery `VECTOR_SEARCH`（text-embedding） |
| API言語 | Python FastAPI |
| `nurse-shift` | 触らず残置 |
| Firebase | `gdgoc-514203` に追加してよい（P0で実施） |
| Cloudflare | 残す（保険） |
| 可視化 | アプリ内ダッシュボード ＋ Looker Studio 埋込 |
| 安全対策 | 適度（Sensitive Data Protection、Geminiセーフティ設定、Gen AI評価） |

## 2. 全体像

```
ブラウザ（リーダーPC / 従業員スマホ）
   │ HTTPS 単一オリジン
   ▼
Firebase Hosting ──(静的UI + Looker Studio埋込)
   │ /api/** rewrite
   ▼
Cloud Run care-api (FastAPI)  ── SA: care-api-sa（最小権限）
   ├─ Firestore: 業務の正本（施設ごとに分離: facilities/{fid}/...）
   ├─ CP-SAT ソルバー: 必須制約＋施設別の目的関数で月次割当を最適化
   ├─ Vertex AI Gemini（Pro/Flash）
   │     ルール翻訳（自然言語→制約JSON）/ 理由説明 / チャット(function calling) / 要約
   │     文脈キャッシュ: 施設プロフィール・ルールを再利用
   ├─ BigQuery: 予測結果の参照、VECTOR_SEARCHで類似ケース取得
   └─ Pub/Sub care-events ─(BQ subscription)─▶ BigQuery care_analytics

学習ループ（週次, Cloud Scheduler）
   Vertex AI Pipelines
     ① BQから特徴量抽出（施設・個人・曜日・夜勤間隔・過去の応諾）
     ② 施設別にカスタム学習（XGBoost: 応諾確率 / 欠員需要）＋BQMLのベースライン比較
     ③ 評価ゲート（AUC・較正が基準未満なら昇格しない）
     ④ Model Registry 登録
     ⑤ バッチ予測 → BigQuery `predictions.*`
     ⑥ 施設プロフィール・個人プロフィールをGeminiで再生成 → Firestore
```

## 3. 「学習が進む」仕組み

1. **フィードバックの記録**: リーダーがAI案を採用・却下・修正した事実、打診への応諾/辞退と理由を、イベントとしてBigQueryへ。
2. **個人の応諾確率**: 個人×曜日×連勤状況×打診時間帯などから予測。優先打診の順位に使用。
3. **施設別の欠員需要**: 曜日・季節・過去の欠勤パターンから予測し、予備人員の配置に反映。
4. **施設プロフィール（Gemini記憶）**: 「この施設は夜勤明けの翌日休を重視」などの傾向を要約し、文脈キャッシュで毎回の推論に注入。
5. **類似ケース検索**: 欠員の状況を埋め込み、BigQuery `VECTOR_SEARCH` で過去の類似ケースと有効だった対応を取得し、Geminiの根拠にする。
6. **精度の見せ方**: 学習前後の「充足までの時間」「辞退率」「リーダー修正率」を、施設別に比較表示。

## 4. 精度の担保（ハルシネーション対策）

- 人数・スキル・退勤上限・休憩などの**必須制約はCP-SATで決定的に満たす**。違反ゼロを保証。
- Geminiは「自然言語ルール → 制約JSON」の翻訳、結果の理由説明、チャットを担当。**AIは提案、確定は人**。
- 健康データは傾向の要約のみ。診断・就業可否の自動判断はしない。
- Vertex AI の Gen AI 評価サービスで、理由説明・要約の品質を回帰テストとして計測。

## 5. 安全・公開対策

- チャット入力の個人情報は Sensitive Data Protection でマスクしてからGeminiへ。
- Geminiのセーフティ設定を有効化。
- APIにIPごとの簡易レート制限、Budget alert（通知のみ）。
- 認証はデモ用固定ログイン（リーダー/従業員）。データはすべて架空。

## 6. GCPリソース（新規）

| リソース | 備考 |
|---|---|
| API有効化 | `aiplatform`, `firestore`, `firebase`, `firebasehosting`, `secretmanager`, `cloudscheduler`, `dlp`, `cloudbuild` ほか（承認後） |
| Firestore (default) | Native / asia-northeast1 |
| BigQuery | `care_analytics`（events, features, predictions, embeddings, ビュー） |
| Pub/Sub | `care-events` ＋ BigQuery subscription |
| Cloud Run `care-api` | asia-northeast1、min 0 / max 3、同時実行80 |
| Vertex AI Pipelines / Model Registry | 週次パイプライン、バッチ予測（Endpointなし） |
| Cloud Scheduler | 週次の学習ジョブ起動 |
| Artifact Registry | 既存 `cloud-run-source-deploy` を流用 |
| Service Account | `care-api-sa`, `pipeline-sa`, `gh-deployer`（WIF） |
| Looker Studio | BigQueryビューを接続、ダッシュボード埋込 |
| Budget alert | 通知のみ |

既存の `nurse-shift` は変更しない。Cloudflare（`care.yutok.dev`）は維持する。
IaC は Terraform、状態は GCS バケット `gdgoc-514203-tfstate`。

## 7. 合成データ（`scripts/synth/`）

- 3施設（例: 特養 / 有料老人ホーム / グループホーム）× 各施設の従業員 × 6〜12か月。
- 施設ごとの「癖」を埋め込む（夜勤の人数、辞退しやすい曜日、連勤への耐性など）。
- 希望・欠員・打診・応答・健康チェックを生成し、BigQuery に投入。乱数シード固定で再現可能。
- 既存 `data.js` の `EMP-021` 重複IDは、シード時に修正。

## 8. 段階計画（締切 2026-11-10 19:00 JST）

| Phase | 内容 | 完了の定義 |
|---|---|---|
| P0 基盤 | API有効化、Firebase追加、Firestore/BQ/Pub/Sub、SA、Terraform骨格 | `terraform plan` 差分なし |
| P1 データ | 合成データ生成、Firestoreシード、BQ投入 | 3施設のデータがBQに入る |
| P2 API | FastAPI、欠員フロー（D01-D09）、CP-SAT割当、Hosting rewrite | 2画面で vacancyId 同期 |
| P3 Gemini | ルール翻訳、理由説明、チャット、文脈キャッシュ | デモ動線で動作 |
| P4 学習 | Pipelines、カスタム学習、バッチ予測、類似ケース検索 | 予測が優先打診に反映 |
| P5 見せ場 | ダッシュボード、Looker Studio埋込、学習前後の比較 | 施設別の改善が見える |
| P6 提出 | クリーン化、README、CI/CD（WIF） | 公開リポジトリで再現可能 |

優先順位: **P0 → P1 → P2 → P3 → P4 → P5 → P6**。残り約1日のため、時間が足りなければ P5 の Looker Studio 埋込、次に評価サービス、次にオンライン学習の自動化を縮小する。P4 を完走できない場合は、BQML のベースラインを予測に使う。

## 9. コスト概算（月額・USD、v0.1への追加分）

| 項目 | 目安 | 備考 |
|---|---|---|
| Vertex AI Pipelines＋カスタム学習＋バッチ予測 | $2〜10 | 週次・小規模データ。Endpointなしなので常時課金なし |
| Embedding＋VECTOR_SEARCH | $0〜2 | データ量が小さい |
| Sensitive Data Protection | $0〜2 | 入力が少量 |
| Cloud Scheduler、Looker Studio | ほぼ$0 | 無料枠内 |
| Gemini（Pro/Flash併用） | v0.1の試算に準ずる | 文脈キャッシュで反復入力を削減 |

追加は合計およそ $5〜15。**単価は公式の価格表で再確認すること**（未検証の概算）。

## 10. リスク

- 期限まで約1日。範囲が広いため、P2完了までは機能追加を止める。
- カスタム学習は環境構築で詰まりやすい。評価ゲートとBQMLベースラインを退避先にする。
- 合成データで学習した効果は「デモ上の再現」であり、実運用の精度を示すものではない。説明資料にその旨を明記する。
- 公開エンドポイントのAI・BQ呼び出しは課金増の余地がある。レート制限と予算アラートで抑える。
- Vertex AI の名称・モデルID・機能は変わる可能性があるため、実装時に公式ドキュメントで確認する。
