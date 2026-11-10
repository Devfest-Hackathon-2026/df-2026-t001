"""打診候補の「理由」を Gemini が1文にする（POST /api/v1/candidate-reasons）。

並び順は画面のルール＋学習済みモデルが決める。ここは理由の言い換えだけで、順番も候補も変えない。
入力は匿名の事実（ルールが作った理由の文）だけ。氏名・職員IDは受け取らない。
Gemini の出力は候補ごとに機械的に検証し、外れた候補だけ事実を「、」でつないだ文（source="template"）にする。
AI の失敗・上限（429）でも HTTP 200 を返す。
"""
from __future__ import annotations

import re
from datetime import date as _date
from typing import Callable, Literal

from fastapi import FastAPI, Request
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from .llm import FAST_MODEL

Shift = Literal["早番", "日勤", "遅番", "夜勤"]
MAX_CANDS = 6
MAX_LEN = 45

SYSTEM = (
    "あなたは介護施設のシフト調整を手伝う係です。代わりに入れそうな候補者が選ばれた理由を、リーダーが一目で分かる短い文にします。\n"
    "- 候補ごとに、与えられた「事実」だけを使って、やさしい日本語で1文（45文字以内）を書く。\n"
    "- 事実にない情報（数字・資格・経験・性格・人名・施設名）を足さない。事実を言い換えて、短くまとめるだけにする。\n"
    "- 人の名前は書かない。『この方』なども不要で、理由だけを書く。\n"
    "- 口調は中立で丁寧に。評価・断定・順位づけ（最適・おすすめ・必ず）はしない。絵文字・記号・改行は使わない。\n"
    "- 出力は、与えられた ref ごとに {ref, reason} を1つずつ。"
)


class VacancyIn(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    shift: Shift
    unit_label: str = Field(max_length=20)
    need_skills_labels: list[str] = Field(default_factory=list, max_length=6)

    @field_validator("date")
    @classmethod
    def _date(cls, v: str) -> str:
        _date.fromisoformat(v)
        return v

    @field_validator("need_skills_labels")
    @classmethod
    def _skills(cls, v: list[str]) -> list[str]:
        if any(len(x) > 20 for x in v):
            raise ValueError("スキル名は20文字までです")
        return v


class CandIn(BaseModel):
    ref: str = Field(pattern=r"^c[1-6]$")
    facts: list[str] = Field(min_length=1, max_length=6)
    prob: float | None = Field(default=None, ge=0, le=1)

    @field_validator("facts")
    @classmethod
    def _facts(cls, v: list[str]) -> list[str]:
        if any(not x.strip() or len(x) > 30 for x in v):
            raise ValueError("事実は1〜30文字です")
        return v


class ReasonsIn(BaseModel):
    vacancy: VacancyIn
    candidates: list[CandIn] = Field(min_length=1, max_length=MAX_CANDS)

    @field_validator("candidates")
    @classmethod
    def _uniq(cls, v: list[CandIn]) -> list[CandIn]:
        if len({c.ref for c in v}) != len(v):
            raise ValueError("ref が重複しています")
        return v


class _Item(BaseModel):
    ref: str
    reason: str


class _Out(BaseModel):
    items: list[_Item]


def template(c: CandIn) -> str:
    return "、".join(f.strip() for f in c.facts)


_DIGITS = str.maketrans("０１２３４５６７８９％／", "0123456789%/")
_EMOJI = re.compile("[\U0001F000-\U0001FFFF☀-➿️]")
_KATA = re.compile(r"[ァ-ヶー]{2,}")
_NAME_SUFFIX = re.compile(r"(さん|様|君|くん|氏|ちゃん|先輩|主任)")
_NUM = re.compile(r"\d+")


def validate(text: str, c: CandIn, b: VacancyIn) -> str | None:
    """候補ごとの検証。使える文（整形済み）か None。"""
    t = (text or "").strip().strip("「」\"'").strip()
    if not t or "\n" in t or len(t) > MAX_LEN or len(t) < 4 or _EMOJI.search(t):
        return None
    if t.rstrip("。").count("。") or "!" in t or "！" in t or "？" in t:   # 1文だけ
        return None
    t = t.translate(_DIGITS)
    if _NAME_SUFFIX.search(t):
        return None
    src = " ".join([*c.facts, b.unit_label, b.shift, *b.need_skills_labels]).translate(_DIGITS)
    # 事実に無いカタカナ語（人名・施設名の疑い）は不可
    if any(k not in src for k in _KATA.findall(t)):
        return None
    allowed = set(_NUM.findall(src)) | set(_NUM.findall(b.date))
    if c.prob is not None:
        allowed.add(str(round(c.prob * 100)))
    if any(n not in allowed for n in _NUM.findall(t)):
        return None
    return t


def _prompt(b: ReasonsIn) -> str:
    v = b.vacancy
    lines = [f"欠員: {int(v.date[5:7])}/{int(v.date[8:10])} {v.shift} {v.unit_label}", f"必要なスキル: {'・'.join(v.need_skills_labels) or 'なし'}", "", "候補（事実だけ）:"]
    for c in b.candidates:
        p = f"／応諾の見込み{round(c.prob * 100)}%" if c.prob is not None else ""
        lines.append(f"- {c.ref}: " + " / ".join(c.facts) + p)
    return "\n".join(lines) + "\n\n各候補の理由を1文にしてください。"


def _fallback(b: ReasonsIn) -> dict:
    return {"items": [{"ref": c.ref, "reason": template(c), "source": "template"} for c in b.candidates]}


def reasons(ai, b: ReasonsIn, ip: str) -> dict:
    fb = _fallback(b)
    try:
        ai.guard(ip, "intent")
        out, usage = ai.llm.structured(model=FAST_MODEL, system=SYSTEM, prompt=ai.masker.mask(_prompt(b)), schema=_Out, max_tokens=800, thinking="minimal")
    except Exception:  # noqa: BLE001  上限（429）・DLP・Gemini の失敗は、どれも事実の連結
        return fb
    try:
        ai.svc.events.emit("plan", "ai_call", {"feature": "candidate_reasons", "models": [usage.model], "input_tokens": usage.input_tokens,
                                               "output_tokens": usage.output_tokens, "thinking_tokens": usage.thinking_tokens, "ms": usage.ms})
    except Exception:  # noqa: BLE001
        pass
    got: dict[str, str] = {}
    for it in getattr(out, "items", []) or []:
        got.setdefault(it.ref, it.reason)
    res = []
    for c, f in zip(b.candidates, fb["items"]):
        ok = validate(got.get(c.ref, ""), c, b.vacancy)
        res.append({"ref": c.ref, "reason": ok, "source": "gemini"} if ok else f)
    return {"items": res}


def register(app: FastAPI, get_ai: Callable, get_ip: Callable[[Request], str]) -> None:
    @app.post("/api/v1/candidate-reasons")
    async def candidate_reasons(body: ReasonsIn, req: Request):
        """打診候補の理由（ルールが作った事実）を、Gemini が1文にする。順番は変えない。失敗は事実の連結。"""
        try:
            ai = get_ai()
        except Exception:  # noqa: BLE001
            return _fallback(body)
        return await run_in_threadpool(reasons, ai, body, get_ip(req))
