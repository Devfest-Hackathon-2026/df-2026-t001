"""台本の答えを返す偽物の LLM と、それを差したローカル API（流れの不具合と、AI の読み違いを分けて測るため）。

* ScriptedLLM：プロンプトの中に台本の言葉（tests/fixtures/rule_sentences.yaml の utterance）があれば、その draft を返す。
  plan-intent（シフト作成チャットの分類）には、決まりの言葉なら add_rule を返す。台本に無い言葉は AIError。
* 翻訳・検証・候補・影響の計算は本物のコード（care/ai/translate.py）を通る。差し替えるのは LLM の答えだけ。

  STORE=memory SYNTH_DIR=../scripts/synth/out CORS_ORIGINS=http://localhost:5180 \\
    .venv/bin/python -m uvicorn bench.scripted_ai:app --port 8091
"""
from __future__ import annotations

from pathlib import Path

import yaml

from care.ai.llm import AIError, Usage

SENTENCES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "rule_sentences.yaml"


def _norm(t: str) -> str:
    return "".join(t.split())


class ScriptedLLM:
    def __init__(self, cases: list[dict] | None = None) -> None:
        self.cases = cases if cases is not None else yaml.safe_load(SENTENCES.read_text())
        self.calls: list[dict] = []

    def _find(self, prompt: str) -> dict | None:
        p = _norm(prompt)
        hits = [c for c in self.cases if _norm(c["utterance"]) in p]
        return max(hits, key=lambda c: len(c["utterance"])) if hits else None

    def structured(self, *, model, system, prompt, schema, max_tokens=2048, thinking="low"):
        self.calls.append({"model": model, "schema": schema.__name__, "prompt": prompt[-300:]})
        c = self._find(prompt)
        if c is None:
            raise AIError("scripted: 台本に無い言葉です")
        if schema.__name__.startswith("RuleDraft"):
            from care.ai.translate import RuleDraft
            return schema.model_validate(RuleDraft.model_validate(c["draft"])), Usage("scripted", 0, 0)
        if schema.__name__ == "PlanIntent":
            return schema.model_validate({"intent": "add_rule"}), Usage("scripted", 0, 0)
        raise AIError(f"scripted: {schema.__name__} には答えません")

    def text(self, **kw):
        raise AIError("scripted: text には答えません")

    def chat(self, **kw):
        raise AIError("scripted: chat には答えません")


def _app():
    from care import server
    from care.ai.privacy import Masker
    from care.ai.service import AIService

    server.set_ai(AIService(server.svc(), ScriptedLLM(), Masker(mode="off"), armor=None))
    return server.app


app = _app()
