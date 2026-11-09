"""Gemini（Vertex AI）への薄いアダプタ。認証は ADC（サービスアカウント）で、API キーは存在しない。

* structured: 出力の形を pydantic で縛る（response_schema）。形に合わないものは例外にする。
* text:       文章の言い換え。
* chat:       関数呼び出し（読み取り用のツール）のループ。

テストでは FakeLLM に差し替える。本物のモデル ID は環境変数で変えられる（preview 系は将来変わるため）。
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from pydantic import BaseModel

PRO_MODEL = os.getenv("GEMINI_PRO_MODEL", "gemini-3.1-pro-preview")
FAST_MODEL = os.getenv("GEMINI_FAST_MODEL", "gemini-3-flash-preview")
CHAT_BUDGET = float(os.getenv("CHAT_BUDGET_SEC", "28"))      # チャット全体の時間予算（秒）


class AIError(Exception):
    """モデル呼び出しの失敗・出力の不正。呼び出し側は 503 や 422 に変える。"""


@dataclass
class Usage:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    ms: int = 0


@dataclass
class ChatResult:
    text: str
    trace: list[dict] = field(default_factory=list)       # 呼んだツールと結果の要約
    usage: list[Usage] = field(default_factory=list)


class LLM(Protocol):
    def structured(self, *, model: str, system: str, prompt: str, schema: type[BaseModel], max_tokens: int = 2048,
                   thinking: str | None = "low") -> tuple[BaseModel, Usage]: ...

    def text(self, *, model: str, system: str, prompt: str, max_tokens: int = 1536, thinking: str | None = None) -> tuple[str, Usage]: ...

    def chat(self, *, model: str, system: str, history: list[dict], user_text: str, tools: dict[str, Callable[..., Any]],
             decls: list[dict], max_steps: int = 4, max_tokens: int = 2048) -> ChatResult: ...


def _retryable(e: Exception) -> bool:
    m = str(e)
    return "429" in m or "RESOURCE_EXHAUSTED" in m or "503" in m or "UNAVAILABLE" in m


class GeminiLLM:
    def __init__(self, project: str | None = None, location: str = "global", timeout_ms: int = 25000) -> None:
        from google import genai
        from google.genai import types

        self._genai = genai
        self.client = genai.Client(vertexai=True, project=project or os.getenv("GOOGLE_CLOUD_PROJECT"), location=location,
                                   http_options=types.HttpOptions(timeout=timeout_ms))

    def _call(self, deadline: float | None = None, **kw):
        """429/503 は短く待って最大3回まで再試行する。時間予算（deadline）を超えるなら待たずに失敗にする。"""
        for attempt in range(3):
            try:
                return self.client.models.generate_content(**kw)
            except Exception as e:  # noqa: BLE001
                wait = 1.5 * (2 ** attempt)
                if attempt == 2 or not _retryable(e) or (deadline and time.time() + wait > deadline):
                    raise
                time.sleep(wait)

    def _usage(self, model: str, r, t0: float) -> Usage:
        u = r.usage_metadata
        return Usage(model, getattr(u, "prompt_token_count", 0) or 0, getattr(u, "candidates_token_count", 0) or 0,
                     getattr(u, "thoughts_token_count", 0) or 0, int((time.time() - t0) * 1000))

    def _cfg(self, **kw):
        from google.genai import types

        thinking = kw.pop("thinking", None)
        if thinking:
            kw["thinking_config"] = types.ThinkingConfig(thinking_level=thinking)
        return types.GenerateContentConfig(**kw)

    def structured(self, *, model, system, prompt, schema, max_tokens=2048, thinking="low"):
        t0 = time.time()
        try:
            r = self._call(model=model, contents=prompt, config=self._cfg(
                system_instruction=system, response_mime_type="application/json", response_schema=schema, temperature=0,
                max_output_tokens=max_tokens, thinking=thinking))
            return schema.model_validate_json(r.text), self._usage(model, r, t0)
        except Exception as e:  # noqa: BLE001
            raise AIError(f"{model}: {str(e)[:200]}") from e

    def text(self, *, model, system, prompt, max_tokens=1536, thinking=None):
        t0 = time.time()
        try:
            r = self._call(model=model, contents=prompt, config=self._cfg(
                system_instruction=system, temperature=0.2, max_output_tokens=max_tokens, thinking=thinking))
            if not r.text:
                raise AIError("空の応答")
            return r.text.strip(), self._usage(model, r, t0)
        except AIError:
            raise
        except Exception as e:  # noqa: BLE001
            raise AIError(f"{model}: {str(e)[:200]}") from e

    def chat(self, *, model, system, history, user_text, tools, decls, max_steps=4, max_tokens=2048):
        from google.genai import types

        contents = [types.Content(role="user" if h["role"] == "user" else "model", parts=[types.Part(text=h["content"])])
                    for h in history]
        contents.append(types.Content(role="user", parts=[types.Part(text=user_text)]))
        tool = types.Tool(function_declarations=[types.FunctionDeclaration(name=d["name"], description=d["description"],
                                                                           parameters_json_schema=d["parameters"]) for d in decls])
        cfg = self._cfg(system_instruction=system, tools=[tool], temperature=0.2, max_output_tokens=max_tokens,
                        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True))
        res = ChatResult(text="")
        deadline = time.time() + CHAT_BUDGET
        for step in range(max_steps + 1):
            t0 = time.time()
            if step and t0 > deadline:                      # Cloud Run の 60 秒に収める。調べた範囲で打ち切る
                res.text = "時間がかかりすぎたため、ここまでに分かった範囲でお答えできませんでした。質問を絞ってもう一度お試しください。"
                return res
            try:
                r = self._call(deadline, model=model, contents=contents, config=cfg)
            except Exception as e:  # noqa: BLE001
                raise AIError(f"{model}: {str(e)[:200]}") from e
            res.usage.append(self._usage(model, r, t0))
            if not r.candidates or not r.candidates[0].content or not r.candidates[0].content.parts:
                raise AIError("空の応答")
            content = r.candidates[0].content
            calls = [p.function_call for p in content.parts if p.function_call]
            if not calls:
                res.text = "".join(p.text or "" for p in content.parts if not getattr(p, "thought", False)).strip()
                return res
            if step == max_steps:                         # 調べる回数の上限。ツール無しで、ここまでの結果だけで答えさせる
                res.text = self._finalize(model, system, contents, max_tokens, res)
                return res
            contents.append(content)                     # 思考の署名ごとそのまま戻す
            parts = []
            for fc in calls:
                args = dict(fc.args or {})
                try:
                    out = tools[fc.name](**args)
                    res.trace.append({"tool": fc.name, "args": args, "ok": True})
                    parts.append(types.Part.from_function_response(name=fc.name, response={"result": out}))
                except Exception as e:  # noqa: BLE001  ツールの失敗はモデルに返して、言い直させる
                    res.trace.append({"tool": fc.name, "args": args, "ok": False, "error": str(e)[:160]})
                    parts.append(types.Part.from_function_response(name=fc.name, response={"error": str(e)[:300]}))
            contents.append(types.Content(role="user", parts=parts))
        return res


def _finalize(self, model, system, contents, max_tokens, res):
    from google.genai import types

    contents = [*contents, types.Content(role="user", parts=[types.Part(text="調べる回数の上限に達しました。ここまでに分かった結果だけで答えてください。分からなかった点は、分からなかったと伝えてください。")])]
    try:
        r = self._call(model=model, contents=contents, config=self._cfg(system_instruction=system, temperature=0.2, max_output_tokens=max_tokens))
        return (r.text or "").strip() or "調べる回数の上限に達しました。質問を絞ってもう一度お試しください。"
    except Exception:  # noqa: BLE001
        return "調べる回数の上限に達しました。質問を絞ってもう一度お試しください。"


GeminiLLM._finalize = _finalize


class FakeLLM:
    """テスト用。呼び出しを記録し、用意した応答を順に返す。"""

    def __init__(self, structured: list | None = None, texts: list[str] | None = None, chat_script: list | None = None) -> None:
        self.structured_q = list(structured or [])
        self.text_q = list(texts or [])
        self.chat_script = list(chat_script or [])
        self.calls: list[dict] = []

    def structured(self, *, model, system, prompt, schema, max_tokens=2048, thinking="low"):
        self.calls.append({"kind": "structured", "model": model, "prompt": prompt})
        if not self.structured_q:
            raise AIError("fake: 応答なし")
        x = self.structured_q.pop(0)
        if isinstance(x, Exception):
            raise x
        return (x if isinstance(x, schema) else schema.model_validate(x)), Usage(model, 10, 5)

    def text(self, *, model, system, prompt, max_tokens=1536, thinking=None):
        self.calls.append({"kind": "text", "model": model, "prompt": prompt})
        if not self.text_q:
            raise AIError("fake: 応答なし")
        x = self.text_q.pop(0)
        if isinstance(x, Exception):
            raise x
        return x, Usage(model, 10, 5)

    def chat(self, *, model, system, history, user_text, tools, decls, max_steps=4, max_tokens=2048):
        self.calls.append({"kind": "chat", "model": model, "prompt": user_text, "history": history, "tools": sorted(tools)})
        res = ChatResult(text="")
        for step in self.chat_script:
            if step[0] == "call":
                try:
                    tools[step[1]](**step[2])
                    res.trace.append({"tool": step[1], "args": step[2], "ok": True})
                except Exception as e:  # noqa: BLE001
                    res.trace.append({"tool": step[1], "args": step[2], "ok": False, "error": str(e)})
            else:
                res.text = step[1]
        self.chat_script = []
        return res
