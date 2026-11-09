"""Firebase 匿名認証のIDトークン検証。トークン・メール等の個人情報はログに出さない。"""
from fastapi import HTTPException, Request

from . import config

_req = None


def verify(token: str) -> dict:
    global _req
    from google.auth.transport import requests as greq
    from google.oauth2 import id_token

    if _req is None:
        _req = greq.Request()
    claims = id_token.verify_firebase_token(token, _req, audience=config.PROJECT)
    if not claims or claims.get("aud") != config.PROJECT:
        raise ValueError("bad audience")
    return claims


def require_user(request: Request) -> str:
    """認証済みユーザーIDを返す。REQUIRE_AUTH=0（ローカル）では固定値。"""
    if not config.REQUIRE_AUTH:
        return "local-dev"
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        raise HTTPException(401, "認証が必要です。ページを再読み込みしてください。")
    try:
        claims = verify(h[7:].strip())
    except Exception:
        raise HTTPException(401, "認証の有効期限が切れました。ページを再読み込みしてください。")
    uid = str(claims.get("user_id") or claims.get("sub"))
    from . import guard

    guard.consume_request(uid)
    return uid
