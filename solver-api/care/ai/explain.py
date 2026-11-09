"""決定的な説明（solver/explain.py の出力）を、リーダーが読みやすい文章に言い換える。

Gemini は「言い換え」だけをする。新しい事実を足せないように、出力を機械的に検査する（fact-lock）:
  * 元の説明に無い数字を含んでいたら不採用
  * 元の説明にある「ルール名」（「」で囲まれた部分）が欠けていたら不採用
  * 長すぎたら不採用
不採用・失敗のときは、元の決定的な説明をそのまま返す（route="template"）。
"""
from __future__ import annotations

import re

from .llm import FAST_MODEL, LLM, AIError

SYSTEM = """あなたは介護施設の勤務表づくりを支える担当者。次の「事実」だけを使って、リーダー向けに短く（3〜5文）わかりやすく説明する。
- 数字と「」で囲まれたルール名は、一字一句そのまま使う。事実に出てくる「」のルール名は、1つも省略せず全部含める（件数の多いものを先に）。
- 事実に無い数字・理由・原因・対策を足さない。推測しない。
- 箇条書きは使わず、やさしい文章で。最後に、次に確認するとよいことを1文だけ（事実の範囲で）。"""

NUM = re.compile(r"\d+")
QUOTED = re.compile(r"「([^」]+)」")


def fact_check(lines: list[str], out: str) -> tuple[bool, str]:
    src = "\n".join(lines)
    new_nums = set(NUM.findall(out)) - set(NUM.findall(src))
    if new_nums:
        return False, f"元に無い数字: {sorted(new_nums)}"
    missing = [q for q in QUOTED.findall(src) if q not in out]
    if missing:
        return False, f"ルール名が欠けています: {missing[:2]}"
    if len(out) > max(400, 4 * len(src)):
        return False, "長すぎます"
    return True, ""


def rephrase(llm: LLM, lines: list[str], *, model: str = FAST_MODEL) -> dict:
    template = "\n".join(lines)
    try:
        out, usage = llm.text(model=model, system=SYSTEM, prompt="事実:\n" + template)
    except AIError as e:
        return {"text": template, "route": "template", "reason": f"AI 失敗: {e}", "usage": None}
    ok, why = fact_check(lines, out)
    if not ok and why.startswith("ルール名が欠けています"):
        # 言い換えで省略されたルールは、元の事実の行をそのまま補う（モデルに書かせない）。数字の検査は先に通っている
        src_new = set(NUM.findall(out)) - set(NUM.findall(template))
        missing = [q for q in QUOTED.findall(template) if q not in out]
        if not src_new and missing:
            extra = [ln for ln in lines if any(f"「{q}」" in ln for q in missing)]
            return {"text": out.rstrip() + "\n\n省略した点もあわせてお知らせします。\n" + "\n".join(extra), "route": "gemini+facts",
                    "reason": f"省略されたルール名 {len(missing)} 件を事実の行から補った", "usage": usage}
    if not ok:
        return {"text": template, "route": "template", "reason": f"事実の検査で不採用: {why}", "usage": usage}
    return {"text": out, "route": "gemini", "reason": None, "usage": usage}
