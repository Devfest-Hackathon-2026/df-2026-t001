"""入力検証・利用上限。公開APIが悪用・保存型XSS・状態破壊の経路にならないための層。

公開デモ（ログインUIなし・匿名認証）のため「誰が書けるか」は絞れない。代わりに
- 状態の形（型・配列長・文字列長・総量）を厳密に検証し、壊れた状態を保存しない
- 書き込み・初期化を uid だけでなく IP 単位でも制限する（匿名アカウントは作り直せるため）
"""
import json
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException

from . import config

_FORBIDDEN_KEYS = {"__proto__", "constructor", "prototype"}
_MAX_DEPTH = 14
_MAX_NODES = 300_000
_MAX_STR = 5000
_MAX_KEY = 100

# 現行UIの状態（src/core/store.ts の State）。id を持つ要素の配列と上限件数
_ID_ARRAYS = {
    "assignments": 6000,
    "vacancies": 1000,
    "requests": 2000,
    "messages": 3000,
    "notices": 3000,
    "health": 3000,
    "events": 500,
    "planRequests": 2000,
}
_DICTS = {"autopilot", "prefs", "settings", "collection", "availability", "spareUse", "paidLeave", "plan"}
_SHORT_STR = {"today": 32, "now": 32}
_REQUIRED = {"v", "today", "now", "assignments", "vacancies"}
_MAX_TOP_KEYS = 48  # 将来の項目追加には耐えつつ、無制限なキー追加は拒否


def _bad(msg: str, code: int = 422):
    raise HTTPException(code, msg)


def _walk(v, depth: int, budget: list[int]) -> None:
    budget[0] -= 1
    if budget[0] < 0:
        _bad("データが大きすぎます", 413)
    if depth > _MAX_DEPTH:
        _bad("データの階層が深すぎます")
    if isinstance(v, dict):
        for k, x in v.items():
            if not isinstance(k, str) or k in _FORBIDDEN_KEYS or len(k) > _MAX_KEY:
                _bad("使用できないキーが含まれています")
            _walk(x, depth + 1, budget)
    elif isinstance(v, list):
        if len(v) > 6000:
            _bad("配列が大きすぎます")
        for x in v:
            _walk(x, depth + 1, budget)
    elif isinstance(v, str):
        # 現行UI(Preact)は常にエスケープして描画するため < > は許可。NUL文字は常に拒否。
        if "\x00" in v:
            _bad("使用できない文字が含まれています")
        if len(v) > _MAX_STR:
            _bad("文字列が長すぎます")
    elif v is None or isinstance(v, (bool, int, float)):
        if isinstance(v, float) and v != v:  # NaN
            _bad("数値が不正です")
    else:
        _bad("使用できない値が含まれています")


def validate_app(app) -> dict:
    """状態の形を検証し、保存してよい形（添付を除いたもの）を返す。不正なら 422/413。"""
    if not isinstance(app, dict):
        _bad("状態の形式が不正です")
    if len(app) > _MAX_TOP_KEYS:
        _bad("状態の項目が多すぎます")
    missing = _REQUIRED - set(app)
    if missing:
        _bad("状態に必要な項目がありません: " + ", ".join(sorted(missing)))
    ver = app.get("v")
    if not isinstance(ver, int) or isinstance(ver, bool) or not (1 <= ver <= 999):
        _bad("状態のバージョン(v)が不正です")
    for k, n in _SHORT_STR.items():
        if k in app and (not isinstance(app[k], str) or len(app[k]) > n):
            _bad(f"{k} の形式が不正です")
    for k, n in _ID_ARRAYS.items():
        if k not in app:
            continue
        arr = app[k]
        if not isinstance(arr, list) or len(arr) > n:
            _bad(f"{k} の形式が不正です（配列・最大{n}件）")
        for x in arr:
            if not isinstance(x, dict) or not isinstance(x.get("id"), str) or not (1 <= len(x["id"]) <= 120):
                _bad(f"{k} の要素には id（文字列）が必要です")
    for k in _DICTS:
        if k in app and app[k] is not None and not isinstance(app[k], dict):
            _bad(f"{k} の形式が不正です")
    # 写真などの添付（base64）は同期しない（クライアントでも除去済み。念のためサーバーでも除く）
    if any(isinstance(m, dict) and "attachments" in m for m in app.get("messages", [])):
        app = dict(app)
        app["messages"] = [{k: v for k, v in m.items() if k != "attachments"} for m in app["messages"]]
    _walk(app, 0, [_MAX_NODES])
    if len(json.dumps(app, ensure_ascii=False).encode()) > config.MAX_STATE_BYTES:
        _bad("データが大きすぎます", 413)
    return app


_lock = threading.Lock()
_req_hits: dict[str, deque] = defaultdict(deque)
_write_hits: dict[str, deque] = defaultdict(deque)
_reset_hits: dict[str, deque] = defaultdict(deque)
_last_reset = [0.0]


def _take(bucket: dict[str, deque], key: str, limit: int, window: float, msg: str) -> None:
    now = time.time()
    with _lock:
        q = bucket[key]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, msg)
        q.append(now)


def consume_request(uid: str) -> None:
    """認証済み利用者ごとの全API呼出し上限（/分）。"""
    _take(_req_hits, uid, config.REQ_PER_UID_PER_MIN, 60, "リクエストが多すぎます。少し待ってからもう一度お試しください。")


def consume_write(ip: str) -> None:
    """IPごとの書き込み上限（/分）。uid は匿名認証の作り直しで回避できるため併用する。"""
    if config.WRITE_PER_IP_PER_MIN:
        _take(_write_hits, ip, config.WRITE_PER_IP_PER_MIN, 60, "更新が多すぎます。少し待ってからもう一度お試しください。")


def consume_reset(ip: str) -> None:
    """初期化は全体のクールダウン＋IPごとの上限（/時）。"""
    now = time.time()
    with _lock:
        if now - _last_reset[0] < config.RESET_COOLDOWN_SEC:
            raise HTTPException(429, "初期化は少し時間をおいてから実行してください。")
    _take(_reset_hits, ip, config.RESET_PER_IP_PER_HOUR, 3600, "初期化の回数が多すぎます。")
    with _lock:
        _last_reset[0] = now
