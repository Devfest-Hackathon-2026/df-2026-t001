"""シフト作成チャットの「意図の解釈」。Gemini が出るのは、リーダーの言葉を1つの操作に分類するところだけ。

* 勤務表は変えない。返すのは操作の種類・人・日付・勤務帯だけ（画面側が検証して、承認つきの提案にする）。
* 人は画面から渡された一覧のIDだけ、日付は対象の月の中だけ、勤務帯は決まった4つだけ。範囲外は捨てる（unknown に倒す）。
* 氏名・ID は画面のデモデータ（架空）。言葉は個人情報のマスクを通してから渡す。
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field

SHIFTS = ["早番", "日勤", "遅番", "夜勤"]
INTENTS = ["off", "assign", "candidates", "swap", "request_work", "request_paid", "request_dayoff", "paid_lacking",
           "create_plan", "remind", "answer", "unknown"]


class PlanOp(BaseModel):
    """2つ目以降の操作（1つの言葉に複数の人・日があるとき）。形は PlanIntent の一部"""
    intent: Literal["off", "assign", "request_work", "request_paid", "request_dayoff"]
    staff_ids: list[str] = Field(default_factory=list)
    date: str | None = None
    shift: Literal["早番", "日勤", "遅番", "夜勤"] | None = None
    unit_id: str | None = None


class PlanIntent(BaseModel):
    intent: Literal["off", "assign", "candidates", "swap", "request_work", "request_paid", "request_dayoff", "paid_lacking",
                    "create_plan", "remind", "answer", "unknown"] = Field(
        description="off=その人のその日を休みにする。assign=その人をその日のその勤務帯に入れる。candidates=その日のその勤務帯に入れる人を知りたい。"
                    "swap=2人のその日の勤務を入れ替える。request_work=その人に出勤をお願いする。request_paid=その人に有給休暇を打診する。"
                    "request_dayoff=その人に希望休の見直しをお願いする。paid_lacking=有休が足りない人にまとめて打診する。"
                    "create_plan=シフト案を作る・作り直す。remind=希望休の未提出者に催促する。answer=質問への短い返答だけ。unknown=分からない・関係ない")
    staff_ids: list[str] = Field(default_factory=list, description="対象の人のID（一覧のIDだけ。swap は2人、それ以外は1人まで）")
    date: str | None = Field(default=None, description="対象の日 YYYY-MM-DD。言葉に日付が無ければ null（推測しない）")
    shift: Literal["早番", "日勤", "遅番", "夜勤"] | None = Field(default=None, description="勤務帯。言葉に無ければ null")
    unit_id: str | None = Field(default=None, description="ユニットID（一覧のIDだけ）。言葉に無ければ null")
    night_max: int | None = Field(default=None, description="create_plan のとき、夜勤を減らしたい場合の月の上限回数。言葉に無ければ null")
    extra: list[PlanOp] = Field(default_factory=list, max_length=5, description="1つの言葉に複数の人・日があるとき、2つ目以降の操作（最大5つ）。例：「山田さんと佐藤さんの12/5を休みに」→ 1つ目は山田さん、extra に佐藤さん。1つだけなら空")
    reply: str = Field(default="", max_length=200, description="answer / unknown のときの、リーダー向けの短い返答（1〜2文）。操作は実行しない")


SYSTEM = """あなたは介護施設のシフト作成アシスタント。リーダーの短い言葉を、次の操作の1つに分類するだけで、勤務表は変えない。
- 人は一覧のIDだけ、ユニットは一覧のIDだけ、日付は「対象の月」の中だけを使う。
- 言葉に無い人・日付・勤務帯を足さない。分からなければ null にし、intent は unknown にする。
- 「休みに」「外して」→ off。「入れて」「お願い」で人と勤務帯があれば assign。誰が入れるかを聞かれたら candidates。
- 本人に「お願いする・依頼・打診」するなら request_work / request_paid / request_dayoff（勝手に勤務表を変えない）。
- 法令や給与の判断は答えない（unknown）。"""


def build_prompt(text: str, month: str, today: str, staff: list[dict], units: list[dict]) -> str:
    st = "\n".join(f"{s['id']}={s['name']}" for s in staff)
    un = ", ".join(f"{u['id']}={u['name']}" for u in units)
    return (f"対象の月: {month}（今日は {today}）\n人の一覧（ID=名前）:\n{st}\nユニット: {un}\n勤務帯: {', '.join(SHIFTS)}\n"
            f"リーダーの言葉: 「{text}」\n\nこの言葉を1つの操作に分類する。")


def sanitize(i: PlanIntent, month: str, ids: set[str], unit_ids: set[str]) -> PlanIntent:
    """範囲外の値を捨てる。必要な項目が欠けた操作は unknown にする。"""
    i.staff_ids = [s for s in i.staff_ids if s in ids][:2]
    if i.date and not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", i.date) and i.date.startswith(month)):
        i.date = None
    if i.unit_id and i.unit_id not in unit_ids:
        i.unit_id = None
    if i.night_max is not None and not (0 <= i.night_max <= 12):
        i.night_max = None
    need = {"off": (1, True, False), "assign": (1, True, True), "candidates": (0, True, True), "swap": (2, True, False),
            "request_work": (1, True, False), "request_dayoff": (1, True, False)}.get(i.intent)
    if need:
        n, d, s = need
        if len(i.staff_ids) < n or (d and not i.date) or (s and not i.shift):
            i.intent = "unknown"
            i.reply = i.reply or "人・日付・勤務帯が分かるように、もう少し具体的に話しかけてください。"
    if i.intent == "request_paid" and not i.staff_ids:
        i.intent = "unknown"
    keep = []
    for op in i.extra:
        op.staff_ids = [s for s in op.staff_ids if s in ids][:1]
        if op.date and not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", op.date) and op.date.startswith(month)):
            op.date = None
        if op.unit_id and op.unit_id not in unit_ids:
            op.unit_id = None
        if op.staff_ids and (op.date or op.intent == "request_paid") and (op.intent != "assign" or op.shift):
            keep.append(op)
    i.extra = keep[:5]
    i.reply = i.reply[:200]
    return i


# ---------------------------------------------------------------- リーダー画面のチャット・職員画面の申請（同じ考え方：分類だけ）

class LeaderIntent(BaseModel):
    intent: Literal["status", "vacancies", "candidates", "delegate", "remind", "approve", "create_plan", "publish_plan", "health", "answer", "unknown"] = Field(
        description="status=今日の状況のまとめ。vacancies=欠員の確認。candidates=その日その勤務帯に入れる人。delegate=欠員をシフト作成君に任せる。"
                    "remind=希望休の未提出者に催促。approve=承認待ちの申請を承認して任せる。create_plan=シフト案を作る。publish_plan=シフトを公開する。"
                    "health=体調の確認。answer=操作ではない質問への短い返答。unknown=分からない・関係ない")
    date: str | None = Field(default=None, description="対象の日 YYYY-MM-DD。言葉に日付（今日・明日・曜日を含む）が無ければ null")
    shift: Literal["早番", "日勤", "遅番", "夜勤"] | None = Field(default=None, description="勤務帯。言葉に無ければ null")
    night_max: int | None = Field(default=None, description="create_plan で夜勤を減らしたいときの月の上限回数")
    reply: str = Field(default="", max_length=200, description="answer / unknown のときの短い返答（1〜2文）")


LEADER_SYSTEM = """あなたは介護施設のリーダーを支えるアシスタント。リーダーの短い言葉を、次の操作の1つに分類するだけで、何も実行しない。
- 日付は「今日」を基準にして YYYY-MM-DD にする。言葉に無い日付・勤務帯を足さない。
- 法令・給与・医療の判断は答えない（unknown）。"""


class EmployeeIntent(BaseModel):
    kind: Literal["off", "dayoff_hope", "late", "early", "change", "avail", "pref", "unknown"] = Field(
        description="off=その日の勤務を休む（欠勤・休暇）。dayoff_hope=来月などの希望休。late=遅刻・遅れて出勤。early=早退・早く帰る。"
                    "change=勤務の変更・交代。avail=その日なら入れる・出られる（欠員のとき優先して声をかけてほしい）。"
                    "pref=毎回の希望（休憩の時間・退勤の上限・勤務帯の希望）。unknown=分からない")
    dates: list[str] = Field(default_factory=list, description="対象の日 YYYY-MM-DD（今日・明日・曜日も日付にする）。言葉に無ければ空")
    shift: Literal["早番", "日勤", "遅番", "夜勤"] | None = Field(default=None, description="勤務帯。言葉に無ければ null")
    time: str | None = Field(default=None, description="late=出勤する時刻、early=帰る時刻 HH:MM。言葉に無ければ null")
    minutes_late: int | None = Field(default=None, description="late で「○分遅れる」と言われたときの分")
    reason: str | None = Field(default=None, max_length=30, description="理由（言葉にあるものだけ。例：体調不良・通院・子どもの用事）")
    break_at: str | None = Field(default=None, description="pref：いつも休憩したい時刻 HH:MM")
    leave_by: str | None = Field(default=None, description="pref：いつも遅くとも帰りたい時刻 HH:MM")
    shift_hope: list[Literal["早番", "日勤", "遅番", "夜勤"]] = Field(default_factory=list, description="pref：希望する勤務帯")
    reply: str = Field(default="", max_length=200, description="unknown のときの短い返答（1〜2文）")


EMPLOYEE_SYSTEM = """あなたは介護施設の職員の申請を聞き取るアシスタント。職員の言葉を、休み・遅刻・早退・変更・入れる日・毎回の希望のどれかに分類するだけで、勤務表は変えない。
- 日付は「今日」を基準にして YYYY-MM-DD にする。言葉に無い日付・時刻・理由を足さない。診断や病名は書かない（理由は言葉にあるものだけ）。"""

_HM = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")


def _date_ok(d: str | None, today: str, span: int = 400) -> bool:
    if not d or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
        return False
    from datetime import date as _d
    try:
        return abs((_d.fromisoformat(d) - _d.fromisoformat(today)).days) <= span
    except ValueError:
        return False


def sanitize_leader(i: LeaderIntent, today: str) -> LeaderIntent:
    if i.date and not _date_ok(i.date, today):
        i.date = None
    if i.night_max is not None and not (0 <= i.night_max <= 12):
        i.night_max = None
    if i.intent == "candidates" and not (i.date and i.shift):
        i.intent, i.reply = "unknown", i.reply or "日付と勤務帯が分かるように、もう少し具体的に話しかけてください。"
    i.reply = i.reply[:200]
    return i


def sanitize_employee(i: EmployeeIntent, today: str) -> EmployeeIntent:
    i.dates = [d for d in i.dates if _date_ok(d, today)][:7]
    i.time = i.time if i.time and _HM.match(i.time) else None
    i.break_at = i.break_at if i.break_at and _HM.match(i.break_at) else None
    i.leave_by = i.leave_by if i.leave_by and _HM.match(i.leave_by) else None
    if i.minutes_late is not None and not (1 <= i.minutes_late <= 480):
        i.minutes_late = None
    if i.kind in ("off", "dayoff_hope", "late", "early", "change", "avail") and not i.dates:
        i.kind, i.reply = "unknown", i.reply or "日付が分かるように、もう少し具体的に話しかけてください。"
    if i.kind == "pref" and not (i.break_at or i.leave_by or i.shift_hope):
        i.kind, i.reply = "unknown", i.reply or "毎回の希望（休憩の時間・帰る時刻・勤務帯）が分かるように話しかけてください。"
    i.reply = i.reply[:200]
    return i
