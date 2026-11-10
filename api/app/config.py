import os

# プロジェクトIDは環境変数で差し替え可能（既定はデモ環境）
PROJECT = os.getenv("CARE_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or "gdgoc-514203"
# STORE_BACKEND=firestore で Firestore、未指定はメモリ（ローカル開発・テスト）
STORE_BACKEND = os.getenv("STORE_BACKEND", "memory")
FACILITY_ID = os.getenv("FACILITY_ID", "demo")
PUBSUB_TOPIC = os.getenv("PUBSUB_TOPIC", "")  # 例: care-events
# 公開デモ向けの簡易レート制限（IPあたり/分）。0で無効
# Cloudflare Worker 経由だと多数の利用者が同一の送信元IPになるため、IP上限は粗い防波堤にとどめ、実質の制限は利用者別(uid)で行う
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "900"))
REQ_PER_UID_PER_MIN = int(os.getenv("REQ_PER_UID_PER_MIN", "150"))
# 書き込み（PUT/POST）はIP単位でも絞る（匿名認証は作り直せるため uid 上限だけでは回避される）
WRITE_PER_IP_PER_MIN = int(os.getenv("WRITE_PER_IP_PER_MIN", "120"))

# --- セキュリティ ---
# 既定で認証必須（Firebase匿名認証のIDトークン）。ローカル開発のみ REQUIRE_AUTH=0
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "1") == "1"
MAX_STATE_BYTES = int(os.getenv("MAX_STATE_BYTES", "600000"))
# リクエスト本文の上限（チャンク転送でも読みながら打ち切る）。状態本体＋包みの余裕
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", str(MAX_STATE_BYTES + 32768)))
# 状態の初期化（運用・デモ用）。専用ヘッダー必須＋全体のクールダウン＋IPあたり/時の上限
RESET_HEADER = "x-care-reset"
RESET_HEADER_VALUE = "demo"
RESET_COOLDOWN_SEC = int(os.getenv("RESET_COOLDOWN_SEC", "30"))
RESET_PER_IP_PER_HOUR = int(os.getenv("RESET_PER_IP_PER_HOUR", "5"))
