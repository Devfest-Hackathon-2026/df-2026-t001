# care-solver-api（助っ人ケアの最適化ソルバー）

「助っ人ケア」の中心にある API（FastAPI、Cloud Run で稼働）。1 か月分のシフトと日次の時間帯別の業務割当を CP-SAT で一度に組み、欠員が出たときは次を担います。

| 動画の場面 | この API の役割 |
|---|---|
| 月次のシフトを、シフト作成君に任せる | リーダー画面の「シフト作成君に作ってもらう」が、画面の職員・希望休・行事をそのまま送って CP-SAT で解く（`POST /api/v1/solve-inline`、`care/inline_solve.py`）。保存しない |
| 条件を満たすシフトを、自動で | 法令（仮値）・スキル・希望・公平性の必須ルールを守る月次＋日次の案を求解する（`care/solver/`、`care/dsl.py`） |
| 足りない時間が見える／埋める | 時間ごとの必要人数と配置人数を比べ、不足を特定する（`care/coverage_view.py`） |
| 変更が最小になるように、組み直す | 欠員の日だけを動かし、変わる勤務が最小になる組み直しを CP-SAT で解く（`POST /api/v1/replan-inline`、`care/inline_replan.py`）。画面の時間調整案と比べ、変更の少ない方を提案する |
| 代わりに入れる人は、ルールを破らない候補に限る | 打診の候補が引き受けたとき、必須ルール（夜勤明けの休み、連続勤務の上限など）を破るかをソルバーと同じルールで検証し、破る人を除く（`care/inline_verify.py`、`POST /api/v1/rank-candidates`） |
| 代わりになれる人を探して打診する | 候補を、学習した応諾の見込み（%）で並べ替える（`care/inline_rank.py`、`care/learn/`） |
| 候補の理由を言葉にする | ルールが作った事実だけを材料に、Gemini が候補ごとの理由を 1 文にする（`POST /api/v1/candidate-reasons`、`care/ai/reasons.py`）。事実にない内容が混ざれば、その候補は元の文に戻す |
| 文章はAIが整える | 休み連絡の選択（種類・日付・勤務・理由）から、Gemini が依頼文を作る（`POST /api/v1/employee-compose`、`care/ai/compose.py`）。検証に落ちれば定型文 |
| Gemini が言葉をルールに翻訳し、理由を説明 | ルール翻訳・説明の言い換え・チャット（`care/ai/`）。渡す前に Sensitive Data Protection で伏せ字にする |
| 毎週、記録を学習する | Vertex AI Pipelines（毎週月曜 03:00 JST）で応諾予測を学習し、基準に勝ったモデルだけを昇格する（`pipelines/`） |

設計は `docs/ARCHITECTURE_v0.3_cpsat.md`。

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q tests                                  # 157件（Firestore 不要）
STORE=memory SYNTH_DIR=../scripts/synth/out .venv/bin/uvicorn care.server:app --port 8080   # ローカル（メモリ）
.venv/bin/python -m care.cli --facility fac-sakura --day 12          # 月次＋日次を解いて要約
python scripts/smoke.py https://care-solver-api-h5p5nqo3qa-an.a.run.app fac-hidamari    # 通し確認（Firestore に追記される）
.venv/bin/python scripts/reset_demo.py fac-hidamari                  # デモ状態に戻す
```

合成データの生成は `../scripts/synth/`。ルールの数値はすべてデモ用の仮値で、法令・施設基準の数値ではない。
参考: ben1san/df-hack26（チームメンバーの作品）の設計の考え方（コードは複製していない）。

## AI（Gemini）

`care/ai/` に、ルール翻訳（`POST …/rules/translate`）・説明の言い換え（`POST …/explain`）・チャット（`POST …/chat`）。
Vertex AI を ADC で呼ぶ（API キー無し）。入力は仮名化＋ Sensitive Data Protection でマスク。利用上限は全体 300回/日・IP ごと 20回/日。

```bash
.venv/bin/python scripts/eval_ai.py ../scripts/synth/out report.json     # 本物の Gemini で評価（Vertex AI を数十〜百数十回呼ぶ）
```

## 学習（応諾予測・反復検出）

`care/learn/` と `pipelines/`（Vertex AI Pipelines。README あり）。champion モデルは GCS から読み込み、候補の順位に応諾確率を反映する。

```bash
.venv/bin/python -m pytest -q tests/test_learn.py          # 学習・採点・検出・API への反映
.venv/bin/python pipelines/pipeline.py run                 # パイプラインを1回実行（Vertex AI）
```
