"""マニュアルの根拠付き回答（ask-manual）と音声入力（voice）。検索・Gemini・DLP はフェイク。"""
import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.ai import grounding, voice
from care.ai.grounding import NOT_FOUND, Hit
from care.ai.llm import AIError, FakeLLM, Usage
from care.ai.privacy import Masker
from care.ai.service import AIService
from care.service import Svc
from care.store import MemoryRepo

FID = "fac-sakura"
ASK = f"/api/v1/facilities/{FID}/ask-manual"
HITS = [
    Hit("fac-sakura--vacancy-emergency", FID, "さくら苑 欠員・急変対応マニュアル", "2. 欠員時の連絡順",
        "前の人に10分つながらなければ、次の人へ進む。当日のリーダー、ユニットリーダー、介護主任、施設長の順。"),
    Hit("fac-sakura--vacancy-emergency", FID, "さくら苑 欠員・急変対応マニュアル", "3. 打診のルール",
        "1人への返答の待ち時間は30分とする（デモ用の仮値）。"),
]


class FakeSearch:
    def __init__(self, hits=None, error=None):
        self.hits, self.error, self.queries = list(hits or []), error, []

    def search(self, query, facility_id, k=6, hint=""):
        self.queries.append((query, facility_id))
        if self.error:
            raise self.error
        return [h for h in self.hits if h.facility_id == facility_id]


class FakeTr:
    def __init__(self, text="", error=None):
        self.text, self.error, self.calls = text, error, []

    def transcribe(self, audio, mime):
        self.calls.append((len(audio), mime))
        if self.error:
            raise self.error
        return self.text, Usage("fake-flash", 10, 5)


def make(synth, llm=None, masker=None):
    guard.reset()
    svc = Svc(MemoryRepo.from_synth(synth))
    server.set_service(svc)
    a = AIService(svc, llm or FakeLLM(), masker or Masker(mode="off"))
    server.set_ai(a)
    return a, TestClient(server.app)


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setenv("GROUNDING_DATASTORE", "projects/x/locations/global/collections/default_collection/engines/e/servingConfigs/default_search")
    monkeypatch.setenv("VOICE_ENABLED", "1")
    yield
    server.set_service(None)
    grounding.set_search(None)
    voice.set_transcriber(None)


# ---------------------------------------------------------------- ask-manual

def test_ask_manual_returns_answer_with_citations(synth):
    s = FakeSearch(HITS)
    grounding.set_search(s)
    llm = FakeLLM(structured=[{"found": True, "answer": "当日のリーダーから順に連絡し、10分つながらなければ次の人へ進みます。", "citations": [1]}])
    _, c = make(synth, llm)
    r = c.post(ASK, json={"question": "欠員が出たら誰に連絡する？"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["found"] is True and "10分" in j["answer"]
    assert j["citations"] == [{"document": "さくら苑 欠員・急変対応マニュアル", "section": "2. 欠員時の連絡順", "excerpt": HITS[0].text,
                               "doc_id": "fac-sakura--vacancy-emergency", "uri": ""}]
    assert s.queries == [("欠員が出たら誰に連絡する？", FID)]
    assert "[1] 文書: さくら苑" in llm.calls[0]["prompt"]


def test_no_hits_says_not_in_manual_without_calling_gemini(synth):
    grounding.set_search(FakeSearch([]))
    llm = FakeLLM()
    _, c = make(synth, llm)
    j = c.post(ASK, json={"question": "駐車場の場所は？"}).json()
    assert j["found"] is False and j["answer"] == NOT_FOUND and j["citations"] == []
    assert llm.calls == []


@pytest.mark.parametrize("out", [
    {"found": False, "answer": "", "citations": []},                                   # モデルが記載なしと判断
    {"found": True, "answer": "施設長に連絡します。", "citations": []},                    # 引用なし
    {"found": True, "answer": "施設長に連絡します。", "citations": [9]},                   # 存在しない番号
    {"found": True, "answer": "返答は45分待ちます。", "citations": [2]},                   # 根拠に無い数字
])
def test_ungrounded_answers_become_not_found(synth, out):
    grounding.set_search(FakeSearch(HITS))
    _, c = make(synth, FakeLLM(structured=[out]))
    j = c.post(ASK, json={"question": "打診の返事はどれくらい待つ？"}).json()
    assert j["found"] is False and j["answer"] == NOT_FOUND and j["citations"] == []


def test_numbered_steps_are_not_treated_as_invented_numbers(synth):
    grounding.set_search(FakeSearch(HITS))
    ans = "1. 当日のリーダー\n2. ユニットリーダー\n3. 介護主任\n4. 施設長（10分つながらなければ次へ）"
    _, c = make(synth, FakeLLM(structured=[{"found": True, "answer": ans, "citations": [1]}]))
    assert c.post(ASK, json={"question": "連絡順は？"}).json()["found"] is True


def test_question_is_pseudonymized_and_masked_before_search(synth):
    a, c = make(synth, FakeLLM(structured=[{"found": False, "answer": "", "citations": []}]))
    s = FakeSearch(HITS)
    grounding.set_search(s)
    name = a.svc.facility(FID).staff[0]
    a.masker = Masker(mode="required")
    a.masker.mask = lambda t: t.replace("090-1234-5678", "[PHONE_NUMBER]")
    c.post(ASK, json={"question": f"{name.name}が休むとき 090-1234-5678 に連絡する？"})
    q = s.queries[0][0]
    assert name.name not in q and name.staff_id in q and "[PHONE_NUMBER]" in q


def test_dlp_failure_calls_neither_search_nor_gemini(synth, monkeypatch):
    s = FakeSearch(HITS)
    grounding.set_search(s)
    llm = FakeLLM()
    a, c = make(synth, llm, Masker(mode="required"))
    monkeypatch.setattr(Masker, "mask", lambda self, t: (_ for _ in ()).throw(AIError("dlp down")))
    r = c.post(ASK, json={"question": "連絡順は？"})
    assert r.status_code == 503 and s.queries == [] and llm.calls == []


def test_disabled_without_env_is_404(synth, monkeypatch):
    monkeypatch.delenv("GROUNDING_DATASTORE")
    _, c = make(synth)
    assert c.post(ASK, json={"question": "連絡順は？"}).status_code == 404


def test_unknown_facility_and_search_failure(synth):
    grounding.set_search(FakeSearch(error=AIError("search down")))
    _, c = make(synth)
    assert c.post("/api/v1/facilities/nope/ask-manual", json={"question": "連絡順は？"}).status_code == 404
    assert c.post(ASK, json={"question": "連絡順は？"}).status_code == 503


def test_ask_manual_uses_daily_cap(synth):
    grounding.set_search(FakeSearch([]))
    a, c = make(synth)
    a.ip_limit = 1
    assert c.post(ASK, json={"question": "a"}).status_code == 200
    assert c.post(ASK, json={"question": "b"}).status_code == 429


def test_chat_tool_registration(synth, monkeypatch):
    a, _ = make(synth)
    s = FakeSearch(HITS)
    reg, decls = grounding.extend_chat(a, FID, {"x": 1}, [{"name": "x"}])
    assert set(reg) == {"x", "search_manual"} and decls[-1]["name"] == "search_manual"
    out = grounding.chat_tool(a, FID, search=s)(question="連絡順")
    assert out["found"] and out["excerpts"][0]["document"].startswith("さくら苑")
    assert grounding.chat_tool(a, FID, search=FakeSearch([]))(question="駐車場")["message"] == NOT_FOUND
    monkeypatch.delenv("GROUNDING_DATASTORE")
    assert grounding.extend_chat(a, FID, {"x": 1}, []) == ({"x": 1}, [])


def test_chunk_is_split_into_sections():
    t = "# さくら苑 欠員・急変対応マニュアル\n\n前書きの文。\n\n## 2. 欠員時の連絡順\n\n* 当日のリーダー\n* 施設長\n\n## 3. 打診のルール\n\n返答の待ち時間は30分。"
    assert grounding.split_sections(t) == [("はじめに", "前書きの文。"), ("2. 欠員時の連絡順", "* 当日のリーダー\n* 施設長"), ("3. 打診のルール", "返答の待ち時間は30分。")]
    assert grounding._section(t) == "3. 打診のルール"


class _Resp:
    def __init__(self, code, j=None, text=""):
        self.status_code, self._j, self.text = code, j or {}, text

    def json(self):
        return self._j


def test_vertex_search_falls_back_when_filter_unsupported_and_keeps_only_the_facility():
    chunk = lambda doc, content: {"chunk": {"name": f"projects/p/x/documents/{doc}/chunks/c1", "content": content,
                                            "documentMetadata": {"title": doc, "uri": f"gs://b/{doc}", "structData": {"facility_id": doc.split("--")[0], "title": doc}}}}
    calls = []

    def post(body):
        calls.append(body)
        if "filter" in body:
            return _Resp(400, text='Invalid filter syntax ... Unsupported field "facility_id"')
        return _Resp(200, {"results": [chunk("fac-midori--vacancy-emergency", "# m\n## 2. 連絡順\n管理者"),
                                       chunk("fac-sakura--vacancy-emergency", "# s\n## 2. 欠員時の連絡順\n当日のリーダー\n## 3. 打診のルール\n30分")]})

    vs = grounding.VertexSearch.__new__(grounding.VertexSearch)
    vs._post = post
    hits = vs.search("連絡順", FID, hint="さくら苑")
    assert [(h.doc_id, h.section) for h in hits] == [("fac-sakura--vacancy-emergency", "2. 欠員時の連絡順"), ("fac-sakura--vacancy-emergency", "3. 打診のルール")]
    assert calls[0]["query"] == "さくら苑 連絡順" and "filter" not in calls[1]


# ---------------------------------------------------------------- voice

AUDIO = b"\x1a\x45\xdf\xa3" + b"0" * 2000


def test_voice_status(synth, monkeypatch):
    _, c = make(synth)
    assert c.get("/api/v1/voice").json()["enabled"] is True
    monkeypatch.delenv("VOICE_ENABLED")
    assert c.get("/api/v1/voice").json()["enabled"] is False


def test_voice_transcribes_and_masks(synth):
    tr = FakeTr("  11/20の夜勤を\n休みたいです。 090-1234-5678 ")
    voice.set_transcriber(tr)
    a, c = make(synth)
    a.masker = Masker(mode="required")
    a.masker.mask = lambda t: t.replace("090-1234-5678", "[PHONE_NUMBER]")
    r = c.post("/api/v1/voice?target=employee&duration_ms=4000", content=AUDIO, headers={"Content-Type": "audio/webm;codecs=opus"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["text"] == "11/20の夜勤を 休みたいです。 [PHONE_NUMBER]" and j["intent_path"] == "/api/v1/employee-intent"
    assert tr.calls == [(len(AUDIO), "audio/webm")]


def test_voice_text_fits_intent_endpoint(synth):
    voice.set_transcriber(FakeTr("夜勤を減らしてシフトを作って" * 40))
    _, c = make(synth, FakeLLM(structured=[{"intent": "create_plan", "date": None, "shift": None, "night_max": 4, "reply": "作ります"}]))
    t = c.post("/api/v1/voice?target=leader", content=AUDIO, headers={"Content-Type": "audio/mp4"}).json()["text"]
    assert len(t) == 300
    r = c.post("/api/v1/leader-intent", json={"text": t, "today": "2026-11-10"})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("q,body,ctype,code", [
    ("", AUDIO, "text/plain", 415),
    ("", b"", "audio/webm", 400),
    ("?duration_ms=45000", AUDIO, "audio/webm", 413),
    ("?target=other", AUDIO, "audio/webm", 400),
    ("", b"0" * (voice.MAX_BYTES + 1), "audio/webm", 413),
])
def test_voice_rejects_bad_input(synth, q, body, ctype, code):
    tr = FakeTr("こんにちは")
    voice.set_transcriber(tr)
    _, c = make(synth)
    assert c.post(f"/api/v1/voice{q}", content=body, headers={"Content-Type": ctype}).status_code == code
    assert tr.calls == []


def test_voice_dlp_failure_returns_no_text(synth, monkeypatch):
    voice.set_transcriber(FakeTr("11/20の夜勤を休みたい"))
    _, c = make(synth, masker=Masker(mode="required"))
    monkeypatch.setattr(Masker, "mask", lambda self, t: (_ for _ in ()).throw(AIError("dlp down")))
    r = c.post("/api/v1/voice", content=AUDIO, headers={"Content-Type": "audio/webm"})
    assert r.status_code == 503 and "text" not in r.json()


def test_voice_empty_transcript_and_gemini_failure(synth):
    voice.set_transcriber(FakeTr("   "))
    _, c = make(synth)
    assert c.post("/api/v1/voice", content=AUDIO, headers={"Content-Type": "audio/webm"}).status_code == 422
    voice.set_transcriber(FakeTr(error=AIError("boom")))
    assert c.post("/api/v1/voice", content=AUDIO, headers={"Content-Type": "audio/webm"}).status_code == 503


def test_voice_disabled_is_404(synth, monkeypatch):
    monkeypatch.delenv("VOICE_ENABLED")
    _, c = make(synth)
    assert c.post("/api/v1/voice", content=AUDIO, headers={"Content-Type": "audio/webm"}).status_code == 404


def test_voice_and_ask_manual_are_rate_limited_as_ai():
    assert guard.is_ai("POST", "/api/v1/voice") and guard.is_ai("POST", f"/api/v1/facilities/{FID}/ask-manual")
    assert guard.max_body("/api/v1/voice") > guard.MAX_BODY and guard.max_body("/api/v1/plan-intent") == guard.MAX_BODY
