"""入力検証・利用上限。公開APIが悪用・課金暴走・保存型XSSの経路にならないための層。"""
import json
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException

from . import config

_FORBIDDEN_KEYS = {"__proto__", "constructor", "prototype"}
_ALLOWED_TOP = {"app", "flow", "monthlySchedule"}  # app=現行UI(kana-care-state-v7)、flow/monthlySchedule=旧UI(legacy)
_MAX_DEPTH = 14


def _walk(v, depth=0, strict=True):
    if depth > _MAX_DEPTH:
        raise HTTPException(422, "データの階層が深すぎます")
    if isinstance(v, dict):
        for k, x in v.items():
            if k in _FORBIDDEN_KEYS or not isinstance(k, str) or len(k) > 100:
                raise HTTPException(422, "使用できないキーが含まれています")
            _walk(x, depth + 1, strict)
    elif isinstance(v, list):
        if len(v) > 5000:
            raise HTTPException(422, "配列が大きすぎます")
        for x in v:
            _walk(x, depth + 1, strict)
    elif isinstance(v, str):
        # 旧UI(legacy)は一部 innerHTML で描画するため、マークアップ文字を含む保存を拒否（保存型XSS対策）。
        # 現行UI(app)はPreactが常にエスケープして描画するため < > は許可（チャット本文等）。NUL文字は常に拒否。
        if "\x00" in v or (strict and ("<" in v or ">" in v)):
            raise HTTPException(422, "使用できない文字が含まれています")
        if len(v) > 5000:
            raise HTTPException(422, "文字列が長すぎます")


def validate_patch(patch: dict) -> None:
    if not isinstance(patch, dict) or set(patch) - _ALLOWED_TOP:
        raise HTTPException(422, "更新できるのは flow / monthlySchedule のみです")
    if len(json.dumps(patch, ensure_ascii=False).encode()) > config.MAX_STATE_BYTES:
        raise HTTPException(413, "データが大きすぎます")
    for k, v in patch.items():
        _walk(v, 0, strict=(k != "app"))


_lock = threading.Lock()
_uid_hits: dict[str, deque] = defaultdict(deque)
_mem_daily: dict[str, int] = defaultdict(int)


def _today() -> str:
    return time.strftime("%Y%m%d", time.gmtime())


def consume_ai(uid: str) -> None:
    """AI呼出しの利用者別/分と全体/日の上限を消費。超過時は429。"""
    now = time.time()
    with _lock:
        q = _uid_hits[uid]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= config.AI_PER_UID_PER_MIN:
            raise HTTPException(429, "AIの利用が集中しています。少し待ってからもう一度お試しください。")
        q.append(now)
    if config.AI_DAILY_LIMIT <= 0:
        return
    if config.STORE_BACKEND == "firestore":
        from google.cloud import firestore

        db = firestore.Client(project=config.PROJECT)
        ref = db.collection("usage").document(_today())

        @firestore.transactional
        def inc(tx):
            snap = ref.get(transaction=tx)
            n = (snap.to_dict() or {}).get("ai_calls", 0) if snap.exists else 0
            if n >= config.AI_DAILY_LIMIT:
                return False
            tx.set(ref, {"ai_calls": n + 1, "updatedAt": now})
            return True

        ok = inc(db.transaction())
    else:
        with _lock:
            k = _today()
            ok = _mem_daily[k] < config.AI_DAILY_LIMIT
            if ok:
                _mem_daily[k] += 1
    if not ok:
        raise HTTPException(429, "本日のAI利用上限に達しました。明日またお試しください。")


_req_hits: dict[str, deque] = defaultdict(deque)


def consume_request(uid: str) -> None:
    """認証済み利用者ごとの全API呼出し上限（/分）。"""
    now = time.time()
    with _lock:
        q = _req_hits[uid]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= config.REQ_PER_UID_PER_MIN:
            raise HTTPException(429, "リクエストが多すぎます。少し待ってからもう一度お試しください。")
        q.append(now)
