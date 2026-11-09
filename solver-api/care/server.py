"""FastAPI。/api/v1 の下に、求解・手修正（追記）・欠員フロー・ルールを置く。表を上書きする API は無い。"""
from __future__ import annotations

import os
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import guard
from .ai.compose import register as register_compose
from .ai.llm import GeminiLLM
from .ai.service import AIService
from .inline_solve import InlineSolveIn, solve_inline as _solve_inline
from .learn.analytics import BQAnalytics
from .learn.store import ModelStore
from .service import ServiceError, Svc
from .store import make_repo

app = FastAPI(title="care-solver-api", version="0.3", docs_url="/api/docs", openapi_url="/api/openapi.json")
_svc: Svc | None = None
_ai: AIService | None = None


def svc() -> Svc:
    global _svc
    if _svc is None:
        root = os.getenv("MODEL_ROOT")
        _svc = Svc(make_repo(), models=ModelStore(root) if root else None)
    return _svc


def ai() -> AIService:
    global _ai
    if os.getenv("AI_ENABLED", "1") == "0":
        raise ServiceError(503, "AI は無効に設定されています")
    if _ai is None:
        _ai = AIService(svc(), GeminiLLM(), analytics=BQAnalytics())
    return _ai


def set_service(s: Svc | None) -> None:            # テスト用
    global _svc, _ai
    _svc, _ai = s, None


def set_ai(a: AIService | None) -> None:           # テスト用
    global _ai
    _ai = a


def _ip(req: Request) -> str:
    return guard.client_ip(req.headers, req.client.host if req.client else None)


@app.exception_handler(ServiceError)
async def _svc_err(_: Request, e: ServiceError):
    return JSONResponse({"error": e.message}, status_code=e.status)


@app.middleware("http")
async def protect(req: Request, call_next):
    if req.url.path.startswith("/api/v1"):
        ip = guard.client_ip(req.headers, req.client.host if req.client else None)
        kind = "ai" if guard.is_ai(req.method, req.url.path) else ("heavy" if guard.is_heavy(req.method, req.url.path) else "light")
        ok, wait = guard.allow(ip, kind)
        if not ok:
            return JSONResponse({"error": "リクエストが多すぎます。しばらく待ってから再実行してください"}, 429, headers={"Retry-After": str(wait)})
        if int(req.headers.get("content-length") or 0) > guard.MAX_BODY:
            return JSONResponse({"error": "リクエストが大きすぎます"}, 413)
    return await call_next(req)


# ブラウザ（Firebase Hosting の画面）から直接呼ぶための CORS。protect（レート制限）より後に足し、最も外側にする
# （429・413 の応答にも CORS ヘッダーが付き、画面が『混み合っています』を読める）。許可するのは、公開サイト・プレビューチャンネル・ローカル開発だけ。
# 環境変数 CORS_ORIGINS（カンマ区切り）で追加できる。Cookie は使わないので allow_credentials は付けない。
_ORIGINS = ["https://care.yutok.dev", "https://gdgoc-514203.web.app", "https://gdgoc-514203.firebaseapp.com",
            "http://localhost:5173", "http://localhost:4173", *[o for o in os.getenv("CORS_ORIGINS", "").split(",") if o]]
app.add_middleware(CORSMiddleware, allow_origins=_ORIGINS, allow_origin_regex=r"^https://gdgoc-514203--[a-z0-9-]+\.(web\.app|firebaseapp\.com)$",
                   allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"], expose_headers=["Retry-After"], max_age=600)


async def heavy(fn, *a, **kw):
    """求解は同時実行数を絞る。空きがなければ待たずに 503 を返す。"""
    if not await run_in_threadpool(guard.slots.acquire, True, guard.QUEUE_WAIT):
        raise ServiceError(503, "求解が混み合っています。少し待ってから再実行してください")
    try:
        return await run_in_threadpool(fn, *a, **kw)
    finally:
        guard.slots.release()


# ---------------------------------------------------------------- 入力

class SolveIn(BaseModel):
    time_limit: float = Field(15.0, ge=1, le=20)
    daily: bool = True


class EditIn(BaseModel):
    staff_id: str
    day: int = Field(ge=1, le=31)
    to: Literal["早番", "日勤", "遅番", "夜勤", "休", ""]
    reason: str | None = Field(None, max_length=200)


class VacancyIn(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    shift: Literal["早番", "日勤", "遅番", "夜勤"]
    absent_staff_id: str
    reason: str | None = Field(None, max_length=200)
    need_skills: list[str] = Field(default_factory=list, max_length=5)
    discovered_at: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$", description="欠員を知った時刻（UTC）。省略すると今。デモや過去の再現用")


class OfferIn(BaseModel):
    staff_id: str


class RespondIn(BaseModel):
    status: Literal["accepted", "declined", "expired"]


class ReplanIn(BaseModel):
    apply: bool = False
    time_limit: float = Field(10.0, ge=1, le=15)


class StopIn(BaseModel):
    reason: str = Field(max_length=200)


# ---------------------------------------------------------------- エンドポイント

@app.get("/api/healthz")
def healthz():
    return {"ok": True, "service": "care-solver-api", "version": app.version, "store": os.getenv("STORE", "firestore")}


@app.get("/api/v1/facilities")
def facilities():
    return {"facilities": svc().repo.list_facilities()}


@app.get("/api/v1/facilities/{fid}")
def facility(fid: str):
    f = svc().facility(fid)
    return {"facility_id": fid, "name": f.name, "need_per_shift": f.need_per_shift, "staff": [s.model_dump() for s in f.staff],
            "templates": [t.model_dump() for t in f.templates]}


@app.get("/api/v1/facilities/{fid}/rules")
def rules(fid: str, month: str | None = None):
    m, d, bad = svc().rules(fid, month, include_requests=bool(month))
    return {"rules": [r.model_dump(mode="json") for r in m], "daily_rules": [r.model_dump(mode="json") for r in d], "unreadable": bad}


@app.post("/api/v1/facilities/{fid}/rules", status_code=201)
def add_rule(fid: str, rule: dict):
    return svc().add_rule(fid, rule)


@app.post("/api/v1/facilities/{fid}/rules/{rid}/stop")
def stop_rule(fid: str, rid: str, body: StopIn):
    return svc().stop_rule(fid, rid, body.reason)


@app.get("/api/v1/facilities/{fid}/rosters/{month}")
def roster(fid: str, month: str):
    r = svc().roster(fid, month)
    return {"facility_id": fid, "month": month, "days": r["month"].days, "first_weekday": r["month"].first_weekday,
            "proposal_id": r["proposal_id"], "base": r["base"], "current": r["cells"], "edits": len(r["edits"])}


@app.post("/api/v1/facilities/{fid}/rosters/{month}/solve")
async def solve(fid: str, month: str, body: SolveIn | None = None):
    b = body or SolveIn()
    return await heavy(svc().solve, fid, month, time_limit=b.time_limit, with_daily=b.daily)


@app.get("/api/v1/facilities/{fid}/rosters/{month}/verify")
def verify(fid: str, month: str):
    return svc().verify(fid, month)


@app.post("/api/v1/facilities/{fid}/rosters/{month}/edits", status_code=201)
def edit(fid: str, month: str, body: EditIn):
    return svc().add_edit(fid, month, body.staff_id, body.day, body.to, reason=body.reason)


@app.get("/api/v1/facilities/{fid}/daily/{date}")
async def daily(fid: str, date: str):
    return await heavy(svc().daily, fid, date)


@app.post("/api/v1/facilities/{fid}/vacancies", status_code=201)
async def create_vacancy(fid: str, body: VacancyIn):
    return await heavy(svc().create_vacancy, fid, body.date, body.shift, body.absent_staff_id, reason=body.reason, need_skills=body.need_skills, discovered_at=body.discovered_at)


@app.get("/api/v1/facilities/{fid}/vacancies/{vid}/candidates")
async def candidates(fid: str, vid: str):
    return await heavy(svc().candidates, fid, vid)


@app.post("/api/v1/facilities/{fid}/vacancies/{vid}/offers", status_code=201)
def offer(fid: str, vid: str, body: OfferIn):
    return svc().offer(fid, vid, body.staff_id)


@app.post("/api/v1/facilities/{fid}/vacancies/{vid}/offers/{oid}/respond")
def respond(fid: str, vid: str, oid: str, body: RespondIn):
    return svc().respond(fid, vid, oid, body.status)


@app.post("/api/v1/facilities/{fid}/vacancies/{vid}/replan")
async def replan(fid: str, vid: str, body: ReplanIn | None = None):
    b = body or ReplanIn()
    return await heavy(svc().replan, fid, vid, apply=b.apply, time_limit=b.time_limit)


# ---------------------------------------------------------------- AI（Gemini）

class TranslateIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    staff_id: str | None = None
    day: int | None = Field(None, ge=1, le=31)


class ExplainIn(BaseModel):
    kind: Literal["verify", "daily"]
    month: str | None = Field(None, pattern=r"^\d{4}-\d{2}$")
    date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ChatMsg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=2000)


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    history: list[ChatMsg] = Field(default_factory=list, max_length=20)


@app.post("/api/v1/facilities/{fid}/rules/translate")
def translate_rule(fid: str, body: TranslateIn, req: Request):
    """リーダーの言葉 → ルールの候補（範囲ごと）。保存はしない。"""
    return ai().translate(fid, body.text, month=body.month, staff_id=body.staff_id, day=body.day, ip=_ip(req))


@app.post("/api/v1/facilities/{fid}/explain")
def explain(fid: str, body: ExplainIn, req: Request):
    """違反・日次の説明を読みやすく言い換える。事実の検査に通らなければ元の説明を返す。"""
    return ai().explain(fid, body.kind, month=body.month, date=body.date, ip=_ip(req))


class PlanRef(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(max_length=40)


class PlanIntentIn(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    today: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    staff: list[PlanRef] = Field(max_length=80)
    units: list[PlanRef] = Field(max_length=8)


@app.post("/api/v1/plan-intent")
def plan_intent(body: PlanIntentIn, req: Request):
    """シフト作成チャットの言葉を、1つの操作に分類する（Gemini）。勤務表は変えない。画面側が検証して承認つきで反映する。"""
    return ai().plan_intent(body.text, month=body.month, today=body.today, staff=[s.model_dump() for s in body.staff],
                            units=[u.model_dump() for u in body.units], ip=_ip(req))


class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    today: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


@app.post("/api/v1/leader-intent")
def leader_intent(body: TextIn, req: Request):
    """リーダー画面のチャットの言葉を、1つの操作に分類する（Gemini）。何も実行しない。"""
    return ai().leader_intent(body.text, today=body.today, ip=_ip(req))


@app.post("/api/v1/employee-intent")
def employee_intent(body: TextIn, req: Request):
    """職員の申請の言葉を、休み・遅刻・早退・変更・入れる日・毎回の希望に分類する（Gemini）。勤務表は変えない。"""
    return ai().employee_intent(body.text, today=body.today, ip=_ip(req))


register_compose(app, ai, _ip)   # POST /api/v1/employee-compose（care/ai/compose.py）


@app.post("/api/v1/facilities/{fid}/chat")
def chat(fid: str, body: ChatIn, req: Request):
    """施設のデータを調べて答える。表・欠員・ルールは変えない（提案だけ返す）。"""
    return ai().chat(fid, body.text, month=body.month, history=[m.model_dump() for m in body.history], ip=_ip(req))


# ---------------------------------------------------------------- 学習（応諾予測・反復検出）

class DismissIn(BaseModel):
    key: str = Field(max_length=200)
    reason: str = Field("作らない", max_length=200)


@app.get("/api/v1/facilities/{fid}/models/acceptance")
def acceptance_model(fid: str):
    """応諾予測モデルの状態と、学習のたびの記録（件数・AUC・昇格したか）。"""
    return svc().model_info(fid)


@app.get("/api/v1/facilities/{fid}/learned-rules")
def learned_rules(fid: str, month: str | None = None):
    """手修正のくり返しから見つけたルール候補（根拠つき）。採用は POST /rules、却下は POST /learned-rules/dismiss。"""
    return svc().learned_candidates(fid, month)


@app.post("/api/v1/facilities/{fid}/learned-rules/dismiss")
def dismiss_learned(fid: str, body: DismissIn):
    return svc().dismiss_learned(fid, body.key, body.reason)


from . import inline_rank  # noqa: E402  画面の職員を、学習済みの応諾予測で並べる（状態なし）。POST /api/v1/rank-candidates

inline_rank.register(app, lambda: _svc)

# ---------------------------------------------------------------- 画面の職員データで月次を解く（保存しない）

@app.post("/api/v1/solve-inline")
async def solve_inline(body: InlineSolveIn):
    """シフト作成君の『シフトを作る』。リクエストの職員・希望休・行事だけで CP-SAT を解いて表を返す。保存しない。"""
    return await heavy(_solve_inline, body)
