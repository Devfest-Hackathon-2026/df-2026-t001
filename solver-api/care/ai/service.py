"""AI の3機能（ルール翻訳・説明の言い換え・チャット）をつなぐ。入力の仮名化と個人情報マスク、利用上限、イベント記録を担う。"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from ..service import ServiceError, Svc, month_obj
from . import chat as chat_mod
from . import explain as explain_mod
from . import translate as tr
from . import planintent as pi
from .llm import FAST_MODEL, PRO_MODEL, AIError, LLM
from .privacy import Masker, pseudonymize

JST = timezone(timedelta(hours=9))
MAX_TEXT = 2000
MAX_HISTORY = 10


class AIService:
    def __init__(self, svc: Svc, llm: LLM, masker: Masker | None = None, analytics=None) -> None:
        self.svc, self.llm, self.masker, self.analytics = svc, llm, masker or Masker(), analytics
        self.daily_limit = int(os.getenv("AI_DAILY_LIMIT", "300"))
        self.ip_limit = int(os.getenv("AI_IP_DAILY_LIMIT", "20"))
        self.intent_ip_limit = int(os.getenv("AI_INTENT_IP_DAILY_LIMIT", "150"))
        self.intent_daily_limit = int(os.getenv("AI_INTENT_DAILY_LIMIT", "2000"))

    # ---------------------------------------------------------------- 上限
    def guard(self, ip: str, kind: str = "ai") -> None:
        """全体・IP ごとの1日の上限。超えたら 429。カウンタは Firestore（aiUsage）で共有する。
        kind="intent" は短い言葉の分類（軽い呼び出し）で、説明・チャット・ルール翻訳とは別の、広い枠で数える。"""
        day = datetime.now(JST).strftime("%Y-%m-%d")
        import hashlib

        ipk = hashlib.sha256(ip.encode()).hexdigest()[:16]
        pre, ip_lim, all_lim = ("", self.ip_limit, self.daily_limit) if kind == "ai" else ("intent_", self.intent_ip_limit, self.intent_daily_limit)
        if not self.svc.repo.incr_usage(f"{day}_{pre}ip_{ipk}", ip_lim):
            raise ServiceError(429, f"AI の利用は1日{ip_lim}回までです。明日またお試しください")
        if not self.svc.repo.incr_usage(f"{day}{'_' + pre.rstrip('_') if pre else ''}", all_lim):
            raise ServiceError(429, "本日の AI の利用上限に達しました。明日またお試しください")

    def _input(self, text: str, fid: str) -> tuple[str, dict[str, str]]:
        text = (text or "").strip()
        if not text:
            raise ServiceError(400, "文章が空です")
        if len(text) > MAX_TEXT:
            raise ServiceError(400, f"文章が長すぎます（{MAX_TEXT}文字まで）")
        fac = self.svc.facility(fid)
        pseudo, seen = pseudonymize(text, fac.staff)          # 氏名 → ID
        try:
            return self.masker.mask(pseudo), seen              # 残りの個人情報を伏せ字に
        except AIError as e:
            raise ServiceError(503, str(e)) from e

    def _log(self, fid: str, feature: str, usage, **extra) -> None:
        us = usage if isinstance(usage, list) else ([usage] if usage else [])
        self.svc.events.emit(fid, "ai_call", {"feature": feature, "models": [u.model for u in us],
                                              "input_tokens": sum(u.input_tokens for u in us), "output_tokens": sum(u.output_tokens for u in us),
                                              "thinking_tokens": sum(u.thinking_tokens for u in us), "ms": sum(u.ms for u in us), **extra})

    # ---------------------------------------------------------------- ルール翻訳
    def translate(self, fid: str, text: str, *, month: str, staff_id: str | None, day: int | None, ip: str) -> dict:
        fac = self.svc.facility(fid)
        mo = month_obj(month)
        day = tr.parse_day(month, day)
        if staff_id and staff_id not in {s.staff_id for s in fac.staff}:
            raise ServiceError(404, f"従業員が見つかりません: {staff_id}")
        self.guard(ip)
        safe, _ = self._input(text, fid)
        sid = staff_id or next(iter(tr.mentioned_staff(safe, fac)), None)
        name = {s.staff_id: s.name for s in fac.staff}
        try:
            ro = self.svc.roster(fid, month)
            cur, ci = ro["cells"], self.svc.carry_in(fid, month)
        except ServiceError:
            cur, ci = None, None
        cell = None
        if sid and day and cur:
            cell = f"{name[sid]} / {month}-{day:02d}（{tr.WD[mo.weekday(day)]}）/ いま {cur[sid][day - 1] or '休'}"
        try:
            d, usage = tr.draft(self.llm, fac, safe, who=sid, cell=cell, model=PRO_MODEL)
        except AIError as e:
            raise ServiceError(503, f"AI で翻訳できませんでした: {e}") from e
        self._log(fid, "translate", usage)
        errs = tr.validate(d, fac)
        if errs:
            raise ServiceError(422, "ルールに翻訳できませんでした: " + "／".join(errs))
        cands = tr.candidates(d, fac, mo, cur, staff_id=sid, day=day, text=safe, carry_in=ci)
        return {"facility_id": fid, "model": usage.model, "input": safe, "draft": d.model_dump(), "candidates": cands,
                "note": "候補は保存されていません。範囲を選んで POST /rules で保存してください"}

    # ---------------------------------------------------------------- 説明の言い換え
    def explain(self, fid: str, kind: str, *, month: str | None, date: str | None, ip: str) -> dict:
        if kind == "verify":
            v = self.svc.verify(fid, month or "")
            lines = (["今の勤務表は、すべてのルールを満たしています。"] if v["ok"] else
                     ["今の勤務表で、次のルールが破れています。", *[f"・「{b['label']}」が{b['count']}件（{b['strength']}）" for b in v["broken"]]])
        elif kind == "daily":
            from ..solver.explain import explain_daily  # noqa: F401  (形式を揃えるため API の説明文を使う)

            d = self.svc.daily(fid, date or "")
            lines = d["explanation"]
        else:
            raise ServiceError(400, "kind は verify か daily")
        self.guard(ip)
        out = explain_mod.rephrase(self.llm, lines, model=FAST_MODEL)
        if out["usage"]:
            self._log(fid, "explain", out["usage"], route=out["route"])
        return {"facility_id": fid, "kind": kind, "text": out["text"], "route": out["route"], "reason": out["reason"], "facts": lines}

    # ---------------------------------------------------------------- チャット
    def chat(self, fid: str, text: str, *, month: str, history: list[dict], ip: str) -> dict:
        month_obj(month)
        self.guard(ip)
        safe, _ = self._input(text, fid)
        hist = [{"role": h["role"], "content": h["content"][:MAX_TEXT]} for h in history[-MAX_HISTORY:]
                if h.get("role") in ("user", "assistant") and h.get("content")]
        tools = chat_mod.ChatTools(self.svc, fid, month, self.analytics)
        try:
            r = self.llm.chat(model=FAST_MODEL, system=chat_mod.system_for(month), history=hist, user_text=safe, tools=tools.registry(),
                              decls=chat_mod.DECLS, max_steps=6)
        except AIError as e:
            raise ServiceError(503, f"AI が応答できませんでした: {e}") from e
        self._log(fid, "chat", r.usage, tools=[t["tool"] for t in r.trace])
        return {"facility_id": fid, "month": month, "model": FAST_MODEL, "reply": r.text, "proposals": tools.proposals,
                "tool_trace": r.trace, "note": "proposals は実行されていません。実行するかは人が決めます"}


def _classify(self: AIService, schema, system: str, prompt: str, *, ip: str, feature: str):
    self.guard(ip, "intent")
    try:
        out, usage = self.llm.structured(model=FAST_MODEL, system=system, prompt=prompt, schema=schema, max_tokens=1024, thinking="low")
    except AIError as e:
        raise ServiceError(503, f"AI で解釈できませんでした: {e}") from e
    self.svc.events.emit("plan", "ai_call", {"feature": feature, "models": [usage.model], "input_tokens": usage.input_tokens,
                                             "output_tokens": usage.output_tokens, "thinking_tokens": usage.thinking_tokens, "ms": usage.ms})
    return out, usage


def _clean(self: AIService, text: str) -> str:
    text = (text or "").strip()
    if not text:
        raise ServiceError(400, "文章が空です")
    if len(text) > 300:
        raise ServiceError(400, "文章が長すぎます（300文字まで）")
    try:
        return self.masker.mask(text)
    except AIError as e:
        raise ServiceError(503, str(e)) from e


def _plan_intent(self: AIService, text: str, *, month: str, today: str, staff: list[dict], units: list[dict], ip: str) -> dict:
    safe = _clean(self, text)
    intent, usage = _classify(self, pi.PlanIntent, pi.SYSTEM, pi.build_prompt(safe, month, today, staff, units), ip=ip, feature="plan_intent")
    intent = pi.sanitize(intent, month, {s["id"] for s in staff}, {u["id"] for u in units})
    return {"model": usage.model, "intent": intent.model_dump(), "note": "勤務表は変えていません。画面側で確認してから反映します"}


def _leader_intent(self: AIService, text: str, *, today: str, ip: str) -> dict:
    safe = _clean(self, text)
    intent, usage = _classify(self, pi.LeaderIntent, pi.LEADER_SYSTEM, f"今日: {today}\nリーダーの言葉: 「{safe}」\n\nこの言葉を1つの操作に分類する。", ip=ip, feature="leader_intent")
    return {"model": usage.model, "intent": pi.sanitize_leader(intent, today).model_dump(), "note": "何も実行していません。画面側で確認してから行います"}


def _employee_intent(self: AIService, text: str, *, today: str, ip: str) -> dict:
    safe = _clean(self, text)
    intent, usage = _classify(self, pi.EmployeeIntent, pi.EMPLOYEE_SYSTEM, f"今日: {today}\n職員の言葉: 「{safe}」\n\nこの言葉を分類する。", ip=ip, feature="employee_intent")
    return {"model": usage.model, "intent": pi.sanitize_employee(intent, today).model_dump(), "note": "勤務表は変えていません。提案として本人とリーダーが確認します"}


AIService.plan_intent = _plan_intent  # type: ignore[attr-defined]
AIService.leader_intent = _leader_intent  # type: ignore[attr-defined]
AIService.employee_intent = _employee_intent  # type: ignore[attr-defined]
