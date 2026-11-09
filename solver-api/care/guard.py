"""公開 API の乱用対策。IP ごとのレート制限・同時求解の上限・入力サイズの上限。

メモリ上の制限なので、Cloud Run のインスタンスごとに別カウント（最大3インスタンス）。厳密な制限ではなく、
CPU を使う求解を叩き続けられて課金・遅延が増えるのを抑えるのが目的。
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

MAX_BODY = int(os.getenv("MAX_BODY_BYTES", "65536"))
HEAVY_LIMIT = int(os.getenv("HEAVY_PER_MIN", "6"))       # 求解など CPU を使う呼び出し / IP / 分
LIGHT_LIMIT = int(os.getenv("LIGHT_PER_MIN", "120"))     # それ以外 / IP / 分
AI_LIMIT = int(os.getenv("AI_PER_MIN", "10"))            # AI（翻訳・説明・チャット）/ IP / 分
CONCURRENCY = int(os.getenv("SOLVE_CONCURRENCY", "2"))
QUEUE_WAIT = float(os.getenv("SOLVE_QUEUE_WAIT", "3"))

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()
slots = threading.BoundedSemaphore(CONCURRENCY)


def client_ip(headers, peer: str | None) -> str:
    """Cloud Run は X-Forwarded-For の末尾に実際のクライアント IP を足す。先頭側は偽装できるので末尾を使う。"""
    xff = headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return peer or "unknown"


def is_heavy(method: str, path: str) -> bool:
    """CPU を使う呼び出し（求解・組み直し・欠員登録・日次・候補の順位付け）。"""
    if method == "POST":
        return path.endswith(("/solve", "/solve-inline", "/replan", "/vacancies"))
    return "/daily/" in path or path.endswith("/candidates")


def is_ai(method: str, path: str) -> bool:
    return method == "POST" and path.endswith(("/translate", "/explain", "/chat", "/plan-intent", "/leader-intent", "/employee-intent"))


def allow(ip: str, heavy: bool | str, now: float | None = None) -> tuple[bool, int]:
    """(許可するか, 待つべき秒数)"""
    now = time.time() if now is None else now
    kind = heavy if isinstance(heavy, str) else ("heavy" if heavy else "light")
    limit = {"heavy": HEAVY_LIMIT, "light": LIGHT_LIMIT, "ai": AI_LIMIT}[kind]
    with _lock:
        q = _hits[ip, kind]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return False, max(1, int(60 - (now - q[0])))
        q.append(now)
        if len(_hits) > 5000:           # 溜まりすぎたら古いキーを捨てる
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 60][:2500]:
                _hits.pop(k, None)
    return True, 0


def reset() -> None:
    with _lock:
        _hits.clear()
