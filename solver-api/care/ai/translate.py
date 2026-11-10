"""リーダーの言葉 → ルールの候補。LLM が出るのは「下書き1本」を作るところだけ。

方針（参考: ben1san/df-hack26（チームメンバーの作品） の設計の考え方。コードは複製していない）:
* LLM は DSL の型を満たす下書きしか出せない（response_schema）。意味境界は dsl.py。
* 範囲（この日だけ／この人のこの曜日／この人の毎日／全員のこの曜日）と期限は LLM に当てさせない。候補を並べ、リーダーが選ぶ。
* ラベル（リーダーが読む1行）は LLM に書かせず、下書きの項目から決定的に作る。モデルが言っていないことを足せないようにするため。
* 下書きは検証する（勤務区分・業務・時間・人数）。通らなければ 422 で返し、推測で補わない。
* 初回の求解の前には使わない。指したセル（または明示された人）についての制約を1本だけ作る。
* 保存はしない。候補は POST /rules でリーダーが選んだ1本だけを保存する。
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from .. import vocab
from ..dsl import (OFF, WORK_SHIFTS, Count, DaySel, Facility, Month, Origin, PeopleSel, ShiftSel, Succession, TaskRequest,
                   Lifecycle, Request)
from ..service import ServiceError
from ..verify import verify_monthly
from .llm import FAST_MODEL, PRO_MODEL, LLM, AIError

WD = ["日", "月", "火", "水", "木", "金", "土"]
TASK_JA = {k: v for k, v in vocab.TASK_JA.items() if k not in ("nap", "break")}


class RuleDraft(BaseModel):
    """LLM が埋められる唯一の形。これ以外は構造上出せない。"""
    type: Literal["request", "succession", "count", "taskRequest"] = Field(
        description="request=その人がその勤務に入る/入らない、休みにする/しない。succession=勤務の連なり（Aのあとにbを置かない）や連続勤務の上限。"
                    "count=人ごとの回数・時間の上下限。taskRequest=1日の中の業務（食事・入浴など）を担当する/しない")
    shift_ids: list[str] = Field(default_factory=list, description="対象の勤務区分のID（早番・日勤・遅番・夜勤・休）")
    want: bool | None = Field(default=None, description="request / taskRequest のとき True=希望（入る・担当する）、False=回避（入らない・担当しない）")
    after_shift_ids: list[str] = Field(default_factory=list, description="succession のとき、shift_ids の直後に置かせない勤務区分")
    max_run: int | None = Field(default=None, description="succession のとき、休みを挟まない連続勤務の上限日数")
    at_least: int | None = Field(default=None, description="count のとき下限（回または時間）")
    at_most: int | None = Field(default=None, description="count のとき上限（回または時間）")
    unit: Literal["回", "時間"] = Field(default="回", description="count の単位")
    task: str | None = Field(default=None, description="taskRequest のとき、業務の種類のキー")
    from_hour: float | None = Field(default=None, description="taskRequest のとき、時間帯の開始（0〜24）。言葉に無ければ null")
    to_hour: float | None = Field(default=None, description="taskRequest のとき、時間帯の終了（0〜24）。言葉に無ければ null")
    weekdays: list[int] = Field(default_factory=list, description="言葉に曜日が明示されたときだけ（0=日,1=月,2=火,3=水,4=木,5=金,6=土）。「毎日」「平日」など曜日の指定が無ければ空")
    strength_hint: Literal["絶対", "強く", "できれば"] | None = Field(
        default=None, description="言葉に「絶対」「必ず」「どうしても」（=絶対）や「できれば」「なるべく」（=できれば）が明示されているときだけ。「無理」「嫌」「きつい」などは該当しない。無ければ null")


SYSTEM = """あなたは介護施設の勤務表のルールを書き起こす。勤務表そのものは作らない。
- リーダーの言葉から、制約を1本だけ書き起こす。
- 範囲を広げない。言葉に無い条件・人・曜日・期限を足さない。
- 勤務区分は一覧のIDだけ、業務は一覧のキーだけを使う。
- 人の名前や ID は出力に含めない（誰についてかは別に決まる）。
- 言葉が勤務表のルールに関係なければ、最も近い型で空に近い下書きを返さず、type=request・shift_ids=[]・want=null とする。"""


def _vocab(fac: Facility) -> tuple[list[str], dict[str, str]]:
    tasks = sorted({t.task for t in fac.templates if t.task in TASK_JA})
    return list(WORK_SHIFTS) + [OFF], {k: TASK_JA[k] for k in tasks}


def draft(llm: LLM, fac: Facility, text: str, *, who: str | None, cell: str | None, model: str = PRO_MODEL):
    shifts, tasks = _vocab(fac)
    text = text.strip()
    prompt = (f"勤務区分のID: {', '.join(shifts)}（休=公休）\n業務のキー: {', '.join(f'{k}={v}' for k, v in tasks.items())}\n"
              f"{('指したセル: ' + cell) if cell else '指したセル: なし'}\n{('対象の人: ' + who) if who else '対象の人: 指定なし'}\n"
              f"リーダーの言葉: 「{text}」\n\nこの言葉から制約を1本だけ書き起こす。")
    d, usage = llm.structured(model=model, system=SYSTEM, prompt=prompt, schema=RuleDraft, max_tokens=2048, thinking="low")
    d.shift_ids = [x for x in d.shift_ids if x and x.strip()]             # 空文字は「無い」として扱う
    d.after_shift_ids = [x for x in d.after_shift_ids if x and x.strip()]
    return d, usage


# ---------------------------------------------------------------- 検証

def validate(d: RuleDraft, fac: Facility) -> list[str]:
    """下書きの不備を日本語で返す。空なら通る。"""
    errs, shifts, tasks = [], set(WORK_SHIFTS) | {OFF}, _vocab(fac)[1]
    bad = [x for x in (*d.shift_ids, *d.after_shift_ids) if x not in shifts]
    if bad:
        errs.append(f"勤務区分が不正です: {bad}")
    if d.type == "request" and (not d.shift_ids or d.want is None):
        errs.append("どの勤務に入る／入らないのかが読み取れませんでした")
    if any(not 0 <= w <= 6 for w in d.weekdays):
        errs.append("曜日が不正です")
    if d.type == "succession":
        if d.max_run is not None:
            if not 1 <= d.max_run <= 14:
                errs.append("連続勤務の日数が不正です")
        elif not d.shift_ids or not d.after_shift_ids:
            errs.append("勤務の連なり（Aのあとにbを置かない）が読み取れませんでした")
    elif d.type == "count":
        if not d.shift_ids or (d.at_least is None and d.at_most is None):
            errs.append("どの勤務を何回（何時間）にするのかが読み取れませんでした")
        for v in (d.at_least, d.at_most):
            if v is not None and not 0 <= v <= 400:
                errs.append("回数・時間が不正です")
    elif d.type == "taskRequest":
        if d.task not in tasks or d.want is None:
            errs.append(f"業務を特定できませんでした（{', '.join(tasks.values())} のいずれか）")
        for v in (d.from_hour, d.to_hour):
            if v is not None and not 0 <= v <= 24:
                errs.append("時間帯が不正です")
        if d.from_hour is not None and d.to_hour is not None and d.from_hour >= d.to_hour:
            errs.append("時間帯の開始が終了より後です")
    return errs


# ---------------------------------------------------------------- 候補

def _what(d: RuleDraft) -> str:
    ids = "・".join(d.shift_ids)
    if d.type == "request":
        if d.shift_ids == [OFF]:
            return "休みにする" if d.want else "休みにしない"
        return f"{ids}に入る" if d.want else f"{ids}に入らない"
    if d.type == "succession":
        return f"連続勤務は{d.max_run}日まで" if d.max_run is not None else f"{ids}のあとに{'・'.join(d.after_shift_ids)}を置かない"
    if d.type == "count":
        u = d.unit or ""
        lo, hi = d.at_least, d.at_most
        rng = f"{lo}〜{hi}{u}" if lo is not None and hi is not None else (f"{lo}{u}以上" if lo is not None else f"{hi}{u}以下")
        return f"{ids}は月{rng}"
    hrs = ""
    if d.from_hour is not None or d.to_hour is not None:
        hrs = f"{d.from_hour if d.from_hour is not None else 0:g}時〜{d.to_hour if d.to_hour is not None else 24:g}時の"
    return f"{hrs}{TASK_JA.get(d.task or '', d.task)}を担当{'する' if d.want else 'しない'}"


def _label(subject: str, when: str, d: RuleDraft) -> str:
    what = _what(d)
    if d.type == "succession" or d.type == "count":
        return f"{subject}は{what}" if d.type == "succession" else f"{subject}の{what}"
    return f"{subject}は{when}{what}"


def candidates(d: RuleDraft, fac: Facility, month: Month, current: dict[str, list[str]] | None, *, staff_id: str | None,
               day: int | None, text: str, carry_in: dict[str, str] | None = None) -> list[dict]:
    names = {s.staff_id: s.name for s in fac.staff}
    person = names.get(staff_id) if staff_id else None
    y, m = map(int, month.month.split("-"))
    wdn = month.weekday(day) if day else None
    origin = Origin(kind="リーダーの言葉", evidence=text[:200])
    strength = d.strength_hint or "強く"
    scopes: list[tuple[str, str, str, dict]] = []          # (scope, 主語, いつ, {people, days})
    ex = sorted(set(d.weekdays))                            # 言葉で明示された曜日（あればセルの曜日より優先）
    ex_ja = "・".join(WD[w] for w in ex) + "曜の" if ex else ""
    if d.type == "request":
        if person and day and (not ex or wdn in ex):
            scopes.append(("day", person, f"{m}/{day}（{WD[wdn]}）の", {"ids": [staff_id], "days": {"dates": [day]}, "expire": date(y, m, day)}))
        if person and (ex or wdn is not None):
            w = ex or [wdn]
            scopes.append(("person_weekday", person, ex_ja or f"{WD[wdn]}曜の", {"ids": [staff_id], "days": {"weekdays": w}}))
        if person:
            scopes.append(("person_always", person, "", {"ids": [staff_id], "days": {}}))
        if ex or wdn is not None:
            w = ex or [wdn]
            scopes.append(("everyone_weekday", "全員", ex_ja or f"{WD[wdn]}曜の", {"ids": None, "days": {"weekdays": w}}))
        else:
            scopes.append(("everyone", "全員", "", {"ids": None, "days": {}}))
    else:
        if person:
            scopes.append(("person", person, "", {"ids": [staff_id], "days": {}}))
        scopes.append(("everyone", "全員", "", {"ids": None, "days": {}}))

    out = []
    for scope, subject, when, sel in scopes:
        base = dict(id=f"r-ai-{uuid.uuid4().hex[:8]}", label=_label(subject, when, d), strength=strength, origin=origin)
        if sel.get("expire"):
            base["lifecycle"] = Lifecycle(expires_on=sel["expire"])
        people = PeopleSel(ids=sel["ids"]) if sel.get("ids") else PeopleSel()
        if d.type == "request":
            rule = Request(**base, people=people, days=DaySel(**sel["days"]), shifts=ShiftSel(ids=d.shift_ids), want=bool(d.want))
        elif d.type == "succession":
            rule = Succession(**base, people=people, max_run=d.max_run) if d.max_run is not None else Succession(
                **base, people=people, pattern=[ShiftSel(ids=d.shift_ids), ShiftSel(ids=d.after_shift_ids)], forbid=True)
        elif d.type == "count":
            rule = Count(**base, people=people, shifts=ShiftSel(ids=d.shift_ids), unit=d.unit,
                         at_least=d.at_least, at_most=d.at_most)
        else:
            rule = TaskRequest(**base, people=people, task=d.task or "", from_hour=d.from_hour if d.from_hour is not None else 0.0,
                               to_hour=d.to_hour if d.to_hour is not None else 24.0, want=bool(d.want))
        impact = None
        if d.type != "taskRequest" and current:
            broken = verify_monthly(fac, month, current, [rule], carry_in)
            impact = {"broken_now": sum(broken.values()), "note": "今の勤務表でこのルールを破っているセル・組の数"}
        out.append({"scope": scope, "label": rule.label, "strength": strength, "impact": impact, "rule": rule.model_dump(mode="json")})
    return out


def parse_day(month: str, day: int | None) -> int | None:
    if day is None:
        return None
    y, m = map(int, month.split("-"))
    import calendar

    if not 1 <= day <= calendar.monthrange(y, m)[1]:
        raise ServiceError(400, f"{month} に {day} 日はありません")
    return day


STAFF_ID = re.compile(r"(?<![A-Za-z0-9])[A-Z]{3}-\d{3}(?!\d)")        # 日本語の直前・直後でも拾う（\b は使えない）


def mentioned_staff(text: str, fac: Facility) -> list[str]:
    ids = {s.staff_id for s in fac.staff}
    return [x for x in dict.fromkeys(STAFF_ID.findall(text)) if x in ids]


__all__ = ["RuleDraft", "draft", "validate", "candidates", "mentioned_staff", "FAST_MODEL", "AIError"]
