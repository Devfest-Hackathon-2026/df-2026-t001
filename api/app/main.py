import time
from collections import defaultdict, deque

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import ai, analytics, auth, config, events, guard, rules
from .store import make_store

app = FastAPI(title="care-api", docs_url=None, redoc_url=None, openapi_url=None)
store = make_store()

# 簡易レート制限（インスタンス単位・IPあたり/分）。公開デモの暴走対策の最低限。
_hits: dict[str, deque] = defaultdict(deque)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if config.RATE_LIMIT_PER_MIN and request.url.path.startswith("/api/") and request.url.path != "/api/healthz":
        # 末尾はGoogleのフロントエンドが付与した値（クライアントが偽装できない）
        ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[-1].strip()
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


def _bounded(*objs) -> None:
    """AI入力のサイズ・内容の上限（プロンプト肥大化と不正入力の防止）。"""
    import json as _j

    for o in objs:
        if len(_j.dumps(o, ensure_ascii=False)) > 12000:
            raise HTTPException(413, "入力が大きすぎます")
        guard._walk(o, 0, strict=False)


@app.get("/api/healthz")
def healthz():
    return {"ok": True, "store": config.STORE_BACKEND, "ai": config.AI_ENABLED, "pubsub": bool(config.PUBSUB_TOPIC)}


# 状態同期（リーダー画面と従業員画面が同じ vacancyId を共有する）
class StatePatch(BaseModel):
    patch: dict = Field(default_factory=dict)  # 例: {"flow": {...}, "monthlySchedule": {...}}


def _tracked_changes(old: dict, new: dict) -> list[tuple[str, dict, str | None]]:
    """業務上意味のある変化をイベント化する。"""
    out = []
    of, nf = old.get("flow", {}), new.get("flow", {})
    vid = (nf.get("vacancy") or {}).get("id")
    ov, nv = of.get("vacancy", {}), nf.get("vacancy", {})
    if ov.get("status") != nv.get("status") and nv.get("status"):
        out.append(("vacancy_status_changed", {"from": ov.get("status"), "to": nv.get("status")}, vid))
    for key, name in (("offer", "offer"), ("posting", "posting")):
        o, n = of.get(key, {}), nf.get(key, {})
        for k, v in n.items():
            if isinstance(v, bool) and v and not o.get(k):
                out.append((f"{name}_{k}", {}, vid))
    ov_map = {v.get("id"): v.get("state") for v in old.get("app", {}).get("vacancies", [])}
    for v in new.get("app", {}).get("vacancies", []):
        if v.get("id") in ov_map and ov_map[v["id"]] != v.get("state"):
            out.append(("vacancy_status_changed", {"from": ov_map[v["id"]], "to": v.get("state")}, v.get("id")))
        elif v.get("id") not in ov_map and old.get("app"):
            out.append(("vacancy_created", {"state": v.get("state")}, v.get("id")))
    oh, nh = of.get("health", {}), nf.get("health", {})
    if nh.get("submitted") and not oh.get("submitted"):
        out.append(("health_submitted", {"status": nh.get("status")}, None))
    return out


@app.get("/api/state")
def get_state(since: int = -1, uid: str = Depends(auth.require_user)):
    data, ver = store.get()
    if since == ver:
        return Response(status_code=304)
    return {"version": ver, "data": data}


@app.put("/api/state")
def put_state(body: StatePatch, uid: str = Depends(auth.require_user)):
    guard.validate_patch(body.patch)
    old, new, ver = store.patch(body.patch)
    for et, payload, vid in _tracked_changes(old, new):
        events.emit(et, payload, vid)
    return {"version": ver}


@app.post("/api/state/reset")
def reset_state(uid: str = Depends(auth.require_user)):
    events.clear_local()
    return {"version": store.reset()}


# AI
class MonthlyReq(BaseModel):
    year: int = Field(2026, ge=2024, le=2035)
    month: int = 11


class CandidatesReq(BaseModel):
    absentEmpId: str | None = Field(None, max_length=20)
    requiredSkills: list[str] = Field(default_factory=lambda: [rules.NIGHT_REQUIRED_SKILL], max_length=5)
    top: int = 5


class HealthReq(BaseModel):
    checks: list[dict] = Field(default_factory=list)


class ChatReq(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    staff: dict[str, str] = Field(default_factory=dict, max_length=80)  # 職員ID→表示名（架空名）


class ExplainReq(BaseModel):
    vacancy: dict = Field(default_factory=dict)
    candidates: list[dict] = Field(default_factory=list, max_length=8)


class PlanReq(BaseModel):
    plan: dict = Field(default_factory=dict)


@app.post("/api/ai/monthly-plan")
def ai_monthly(body: MonthlyReq, uid: str = Depends(auth.require_user)):
    guard.consume_ai(uid)
    if not (1 <= body.month <= 12):
        raise HTTPException(422, "month は1〜12")
    return ai.monthly_plan(body.year, body.month)


@app.post("/api/ai/candidates")
def ai_candidates(body: CandidatesReq, uid: str = Depends(auth.require_user)):
    guard.consume_ai(uid)
    return ai.priority_candidates(body.absentEmpId, body.requiredSkills, min(max(body.top, 1), 10))


@app.post("/api/ai/explain-candidates")
def ai_explain(body: ExplainReq, uid: str = Depends(auth.require_user)):
    _bounded(body.vacancy, body.candidates)
    guard.consume_ai(uid)
    return ai.explain_candidates(body.vacancy, body.candidates)


@app.post("/api/ai/plan-review")
def ai_plan(body: PlanReq, uid: str = Depends(auth.require_user)):
    _bounded(body.plan)
    guard.consume_ai(uid)
    return ai.plan_review(body.plan)


@app.post("/api/ai/health-insight")
def ai_health(body: HealthReq, uid: str = Depends(auth.require_user)):
    guard.consume_ai(uid)
    return ai.health_insight(body.checks[:200])


@app.post("/api/ai/chat")
def ai_chat(body: ChatReq, uid: str = Depends(auth.require_user)):
    guard.consume_ai(uid)
    data, _ = store.get()
    staff = {k[:20]: v[:30] for k, v in body.staff.items() if isinstance(k, str) and isinstance(v, str)}
    return ai.chat(body.message, data, staff)


@app.get("/api/analytics/summary")
def analytics_summary(uid: str = Depends(auth.require_user)):
    guard.consume_ai(uid)
    return ai.analytics_summary()


@app.get("/api/analytics/stats")
def analytics_stats(uid: str = Depends(auth.require_user)):
    return analytics.stats()


@app.get("/api/seed/{name}")
def seed(name: str, uid: str = Depends(auth.require_user)):
    if name not in {"employees", "residents", "facilityConfig", "candidates", "residentCoverage"}:
        raise HTTPException(404)
    return rules.load_seed(name)


# ローカル開発用: SERVE_STATIC=.. で静的画面も同一オリジンで配信（本番はFirebase Hosting）
import os  # noqa: E402

if os.getenv("SERVE_STATIC"):
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/", StaticFiles(directory=os.environ["SERVE_STATIC"], html=True), name="static")
