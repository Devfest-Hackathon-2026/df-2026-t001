"""Model Armor。Gemini に渡す前の入力と、返ってきた出力を、テンプレート（infra/model_armor.tf）で検査する。

* 検査するもの: プロンプトインジェクション・ジェイルブレイク、有害な内容（ヘイト・嫌がらせ・性的・危険）、悪意のある URL、
  機密データ（認証情報・カード番号など。氏名・電話などは別途 DLP で伏せ字にしている）。
* 有効化は環境変数 MODEL_ARMOR_TEMPLATE（テンプレート ID か、projects/.../templates/... の完全な名前）。未設定なら何もしない。
  場所は MODEL_ARMOR_LOCATION（既定 asia-northeast1）。
* 入力は Masker（DLP）の直後に検査する（ArmoredMasker）。ユーザーの文章が通るすべての経路（ルール翻訳・チャット・言葉の分類・
  申請文・候補の理由）が Masker を通るため。出力は LLM のラッパー（ArmoredLLM）で検査する。
* 検出したら ArmorBlocked（AIError の一種）を投げる。呼び出し側は AI を使わない既存の安全な応答（定型文・事実の連結・4xx）に倒す。
* Model Armor 自体が使えないときは、DLP と同じく AI を呼ばない（fail closed）。
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable

from .llm import AIError, ChatResult

BLOCK_MESSAGE = "安全のため、この内容は AI では扱えませんでした。言い方を変えて、もう一度お試しください"


class ArmorBlocked(AIError):
    """Model Armor が入力または出力に問題を見つけた。"""

    def __init__(self, where: str, filters: list[str]) -> None:
        self.where, self.filters = where, filters
        super().__init__(f"Model Armor が{'入力' if where == 'prompt' else '出力'}を止めました: {', '.join(filters) or '不明'}")


def matched_filters(result: dict) -> list[str]:
    """sanitizationResult から、一致したフィルタの名前を取り出す（rai は種類ごと）。"""
    out: list[str] = []
    for name, fr in (result.get("filterResults") or {}).items():
        for key, v in (fr or {}).items():          # 例: {"piAndJailbreakFilterResult": {"matchState": "MATCH_FOUND"}}
            if not isinstance(v, dict):
                continue
            if v.get("matchState") == "MATCH_FOUND":
                out.append(name)
            for sub, sv in (v.get("raiFilterTypeResults") or {}).items():
                if isinstance(sv, dict) and sv.get("matchState") == "MATCH_FOUND":
                    out.append(f"rai:{sub}")
            insp = v.get("inspectResult") or {}
            if insp.get("matchState") == "MATCH_FOUND":
                out.append(name)
    return sorted(set(out))


class ModelArmor:
    def __init__(self, template: str, project: str | None = None, location: str | None = None, timeout: float = 8.0) -> None:
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT")
        self.location = location or os.getenv("MODEL_ARMOR_LOCATION", "asia-northeast1")
        self.template = template if template.startswith("projects/") else f"projects/{self.project}/locations/{self.location}/templates/{template}"
        self.timeout = timeout
        self._session = None

    def _post(self, method: str, body: dict) -> dict:
        try:
            if self._session is None:
                import google.auth
                from google.auth.transport.requests import AuthorizedSession

                creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
                self._session = AuthorizedSession(creds)
            url = f"https://modelarmor.{self.location}.rep.googleapis.com/v1/{self.template}:{method}"
            r = self._session.post(url, json=body, timeout=self.timeout)
            if r.status_code != 200:
                raise AIError(f"HTTP {r.status_code}: {r.text[:160]}")
            return r.json().get("sanitizationResult") or {}
        except AIError as e:
            raise AIError(f"Model Armor の検査に失敗しました（安全のため AI は使いません）: {e}") from e
        except Exception as e:  # noqa: BLE001
            raise AIError(f"Model Armor の検査に失敗しました（安全のため AI は使いません）: {str(e)[:160]}") from e

    def check_prompt(self, text: str) -> None:
        if not text or not text.strip():
            return
        res = self._post("sanitizeUserPrompt", {"userPromptData": {"text": text}})
        if res.get("filterMatchState") == "MATCH_FOUND":
            raise ArmorBlocked("prompt", matched_filters(res))

    def check_response(self, text: str) -> None:
        if not text or not text.strip():
            return
        res = self._post("sanitizeModelResponse", {"modelResponseData": {"text": text}})
        if res.get("filterMatchState") == "MATCH_FOUND":
            raise ArmorBlocked("response", matched_filters(res))


class FakeArmor:
    """テスト用。bad_prompt / bad_response の語を含むと止める。fail=True なら検査自体が失敗する。"""

    def __init__(self, bad_prompt: tuple[str, ...] = ("前の指示を無視",), bad_response: tuple[str, ...] = ("危険な内容",), fail: bool = False) -> None:
        self.bad_prompt, self.bad_response, self.fail = bad_prompt, bad_response, fail
        self.calls: list[tuple[str, str]] = []

    def check_prompt(self, text: str) -> None:
        self.calls.append(("prompt", text))
        if self.fail:
            raise AIError("Model Armor の検査に失敗しました（安全のため AI は使いません）: fake")
        if any(b in (text or "") for b in self.bad_prompt):
            raise ArmorBlocked("prompt", ["pi_and_jailbreak"])

    def check_response(self, text: str) -> None:
        self.calls.append(("response", text))
        if self.fail:
            raise AIError("Model Armor の検査に失敗しました（安全のため AI は使いません）: fake")
        if any(b in (text or "") for b in self.bad_response):
            raise ArmorBlocked("response", ["rai:dangerous"])


def make_armor():
    t = os.getenv("MODEL_ARMOR_TEMPLATE", "").strip()
    return ModelArmor(t) if t else None


class ArmoredMasker:
    """DLP で伏せ字にした後、Model Armor で入力を検査する。インターフェースは Masker と同じ（mask(text) -> text）。"""

    def __init__(self, masker, armor) -> None:
        self.inner, self.armor = masker, armor

    @property
    def mode(self):
        return getattr(self.inner, "mode", None)

    def mask(self, text: str) -> str:
        out = self.inner.mask(text)            # DLP が失敗したら、ここで止まる（Model Armor にも Gemini にも渡さない）
        self.armor.check_prompt(out)
        return out


class ArmoredLLM:
    """LLM の出力を Model Armor で検査するラッパー。止めたら ArmorBlocked を投げる（呼び出し側が定型の応答に倒す）。"""

    def __init__(self, llm, armor) -> None:
        self.inner, self.armor = llm, armor

    def __getattr__(self, name):              # FakeLLM の calls など、テスト用の属性はそのまま見せる
        return getattr(self.inner, name)

    def structured(self, **kw):
        out, usage = self.inner.structured(**kw)
        self.armor.check_response(out.model_dump_json() if hasattr(out, "model_dump_json") else json.dumps(out, ensure_ascii=False))
        return out, usage

    def text(self, **kw):
        out, usage = self.inner.text(**kw)
        self.armor.check_response(out)
        return out, usage

    def _screen_tool(self, name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
        """道具の結果（ルールの名前など、利用者が書ける文字列を含む）も、モデルに戻す前に検査する（間接的なプロンプトインジェクション対策）。
        止めたら例外にし、モデルには「この結果は渡せない」とだけ返る（llm.chat がツールの失敗として扱う）。"""
        def run(**args):
            out = fn(**args)
            try:
                self.armor.check_prompt(json.dumps(out, ensure_ascii=False, default=str)[:20000])
            except ArmorBlocked as e:
                raise RuntimeError(f"安全のため、この道具の結果はお渡しできません（{', '.join(e.filters)}）") from e
            return out
        return run

    def chat(self, *, tools: dict[str, Callable[..., Any]], **kw) -> ChatResult:
        r = self.inner.chat(tools={n: self._screen_tool(n, f) for n, f in tools.items()}, **kw)
        self.armor.check_response(r.text)
        return r
