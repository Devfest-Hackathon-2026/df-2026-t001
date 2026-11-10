import time
from collections import defaultdict, deque

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import auth, config, events, guard
from .store import make_store

app = FastAPI(title="care-api", docs_url=None, redoc_url=None, openapi_url=None)
store = make_store()


def client_ip(request: Request) -> str:
    # 末尾はGoogleのフロントエンドが付与した値（クライアントが偽装できない）
    return (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[-1].strip()


# 簡易レート制限（インスタンス単位・IPあたり/分）。公開デモの暴走対策の最低限。
_hits: dict[str, deque] = defaultdict(deque)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if config.RATE_LIMIT_PER_MIN and request.url.path.startswith("/api/") and request.url.path != "/api/healthz":
        ip = client_ip(request)
        now = time.time()
        q = _hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= config.RATE_LIMIT_PER_MIN:
            return Response('{"detail":"リクエストが多すぎます。少し待ってからもう一度お試しください。"}', 429, media_type="application/json")
        q.append(now)
    return await call_next(request)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


class BodyLimit:
    """本文サイズの上限。Content-Length を先に見て、無い（チャンク転送）場合も読みながら上限で打ち切る（413）。
    解析前に止めるので、巨大な本文でメモリ・CPUを消費させられない。"""

    def __init__(self, app, limit: int | None = None) -> None:
        self.app = app
        self.limit = limit

    async def _too_large(self, send) -> None:
        body = '{"detail":"データが大きすぎます"}'.encode()
        await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = self.limit if self.limit is not None else config.MAX_BODY_BYTES
        for k, v in scope.get("headers", []):
            if k == b"content-length":
                try:
                    if int(v) > limit:
                        return await self._too_large(send)
                except ValueError:
                    return await self._too_large(send)
        chunks, total, more = [], 0, True
        while more:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                return
            b = msg.get("body", b"")
            total += len(b)
            if total > limit:
                return await self._too_large(send)
            chunks.append(b)
            more = msg.get("more_body", False)
        body, sent = b"".join(chunks), False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


app.add_middleware(BodyLimit)


@app.get("/api/healthz")
def healthz():
    return {"ok": True, "store": config.STORE_BACKEND, "pubsub": bool(config.PUBSUB_TOPIC)}


# 状態同期（リーダー画面と従業員画面が同じ状態を共有する）
class StatePut(BaseModel):
    base: int = Field(ge=0)  # クライアントが最後に同期したサーバーのバージョン
    app: dict


def _health_status(h: dict) -> str:
    temp = h.get("temp")
    hot = isinstance(temp, (int, float)) and not isinstance(temp, bool) and temp >= 37.5
    return "consult" if h.get("consult") or h.get("symptoms") or hot else "normal"


def _by_id(items) -> dict:
    return {x["id"]: x for x in (items or []) if isinstance(x, dict) and isinstance(x.get("id"), str)}


def _tracked_changes(old: dict, new: dict) -> list[tuple[str, dict, str | None]]:
    """業務上意味のある変化をイベント化する。old は保存済みの現在の状態、new は排他制御を通って確定した状態。
    （古い状態の再送はバージョン不一致で弾かれ、クライアント側でマージされるため、ここに来る差分は新しい遷移のみ）"""
    oa, na = old.get("app") or {}, new.get("app") or {}
    if not oa:
        return []  # 初回の登録・初期化直後の初期状態はイベントにしない
    on, nn = oa.get("now"), na.get("now")
    if isinstance(on, str) and isinstance(nn, str) and nn < on:
        return [("demo_reset", {}, None)]  # デモの「最初からやり直す」（模擬時計が巻き戻る）。個別の遷移は記録しない
    out = []
    ov = _by_id(oa.get("vacancies"))
    for vid, v in _by_id(na.get("vacancies")).items():
        if vid not in ov:
            out.append(("vacancy_created", {"state": v.get("state")}, vid))
        elif ov[vid].get("state") != v.get("state") and v.get("state"):
            out.append(("vacancy_status_changed", {"from": ov[vid].get("state"), "to": v.get("state")}, vid))
    oh = _by_id(oa.get("health"))
    for hid, h in _by_id(na.get("health")).items():
        if hid not in oh:  # 体調チェックは提出ごとに新しい id（store.ts submitHealth）
            out.append(("health_submitted", {"status": _health_status(h)}, None))
    return out


@app.get("/api/state")
def get_state(since: int = -1, uid: str = Depends(auth.require_user)):
    data, ver = store.get()
    if since == ver:
        return Response(status_code=304)
    return {"version": ver, "data": data}


@app.put("/api/state")
def put_state(body: StatePut, request: Request, uid: str = Depends(auth.require_user)):
    guard.consume_write(client_ip(request))
    app_state = guard.validate_app(body.app)
    res = store.put_app(app_state, body.base)
    if not res.ok:
        # 他の端末が先に更新した。現在の状態を返し、クライアントが3方向マージして再送する
        return JSONResponse({"detail": "conflict", "version": res.version, "data": res.old}, status_code=409)
    for et, payload, vid in _tracked_changes(res.old, res.new):
        events.emit(et, payload, vid)
    return {"version": res.version}


@app.post("/api/state/reset")
def reset_state(request: Request, uid: str = Depends(auth.require_user)):
    """運用・デモ用の初期化。専用ヘッダー必須＋全体クールダウン＋IPごとの上限。"""
    if request.headers.get(config.RESET_HEADER) != config.RESET_HEADER_VALUE:
        raise HTTPException(403, "初期化はデモメニューからのみ実行できます")
    guard.consume_reset(client_ip(request))
    events.clear_local()
    return {"version": store.reset()}


# ローカル開発用: SERVE_STATIC=.. で静的画面も同一オリジンで配信（本番はFirebase Hosting）
import os  # noqa: E402

if os.getenv("SERVE_STATIC"):
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/", StaticFiles(directory=os.environ["SERVE_STATIC"], html=True), name="static")
