"""保存層。MemoryRepo（ローカル・テスト）と FirestoreRepo（本番）を同じ形で差し替える。

方針（参考: df-hack26 の「表を上書きしない」考え方を介護向けに独自に実装）:
* 表そのものを保存・上書きする API は無い。保存するのは「ソルバーの提案（不変）」と「手修正の追記ログ」だけ。
  現状の表は 提案 + 編集 から毎回導く。
* 編集・提案・申し出（offer）の履歴は create のみ。同じ ID の2回目は Conflict になる。
* ルールは設定なので、追加（create）と停止（stopped フラグ）だけを許す。停止は ruleEvents に追記して残す。

Firestore の構造:
  facilities/{fid}                         施設
  facilities/{fid}/staff/{sid}             従業員
  facilities/{fid}/taskTemplates/{tid}     日課テンプレート
  facilities/{fid}/rosters/{YYYY-MM}       P1 のシード（提案・carryIn）
  facilities/{fid}/requests/{YYYY-MM}      希望休 {byStaff: {sid: [日]}}
  facilities/{fid}/rules/{rid}             ルール（DSL）
  facilities/{fid}/ruleEvents/{id}         ルールの停止などの履歴
  facilities/{fid}/proposals/{pid}         ソルバーの提案（不変）
  facilities/{fid}/edits/{eid}             手修正（追記のみ）
  facilities/{fid}/vacancies/{vid}         欠員
  facilities/{fid}/vacancies/{vid}/offers/{oid}  打診
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Protocol


class Conflict(Exception):
    """create 済みの ID にもう一度 create しようとした。"""


class NotFound(Exception):
    pass


class Repo(Protocol):
    def list_facilities(self) -> list[dict]: ...
    def facility(self, fid: str) -> dict: ...                     # {facility, staff, templates}
    def rules(self, fid: str) -> list[dict]: ...
    def add_rule(self, fid: str, rule: dict) -> None: ...
    def stop_rule(self, fid: str, rid: str, event: dict) -> None: ...
    def requests(self, fid: str, month: str) -> dict[str, list[int]]: ...
    def seed_roster(self, fid: str, month: str) -> dict | None: ...
    def latest_proposal(self, fid: str, month: str) -> dict | None: ...
    def add_proposal(self, fid: str, doc: dict) -> None: ...
    def edits(self, fid: str, month: str, proposal_id: str | None) -> list[dict]: ...
    def add_edit(self, fid: str, doc: dict) -> None: ...
    def vacancy_count(self, fid: str, date: str) -> int: ...
    def add_vacancy(self, fid: str, doc: dict) -> None: ...
    def vacancy(self, fid: str, vid: str) -> dict: ...
    def update_vacancy(self, fid: str, vid: str, patch: dict) -> None: ...
    def vacancies(self, fid: str, month: str | None) -> list[dict]: ...
    def add_offer(self, fid: str, vid: str, doc: dict) -> None: ...
    def offer(self, fid: str, vid: str, oid: str) -> dict: ...
    def update_offer(self, fid: str, vid: str, oid: str, patch: dict) -> None: ...
    def offers(self, fid: str, vid: str) -> list[dict]: ...
    def incr_usage(self, key: str, limit: int) -> bool: ...        # 上限を超えなければ +1 して True
    def rule_events(self, fid: str) -> list[dict]: ...
    def add_rule_event(self, fid: str, doc: dict) -> None: ...


# ---------------------------------------------------------------- メモリ

class MemoryRepo:
    """テスト・ローカル用。合成データ（scripts/synth/out）から初期化できる。"""

    def __init__(self) -> None:
        self.fac: dict[str, dict] = {}
        self._rules: dict[str, dict[str, dict]] = {}
        self._rule_events: dict[str, list[dict]] = {}
        self._requests: dict[tuple[str, str], dict[str, list[int]]] = {}
        self._seed: dict[tuple[str, str], dict] = {}
        self._proposals: dict[str, list[dict]] = {}
        self._edits: dict[str, list[dict]] = {}
        self._vac: dict[str, dict[str, dict]] = {}
        self._offers: dict[tuple[str, str], dict[str, dict]] = {}
        self._usage: dict[str, int] = {}

    @classmethod
    def from_synth(cls, out: str | os.PathLike) -> "MemoryRepo":
        from .defaults import default_rules, request_rules
        from .dsl import Facility, Month, StaffMember, TaskTemplate
        from .synth_io import NEED, carry_in

        out = Path(out)
        r = cls()
        seed = json.load(open(out / "seed.json", encoding="utf-8"))
        reqs = [json.loads(line) for line in open(out / "fact_requests.ndjson", encoding="utf-8")]
        for f in seed["facilities"]:
            fid = f["facility"]["id"]
            r.fac[fid] = {"facility": {**f["facility"], "needPerShift": NEED[fid]}, "staff": f["staff"], "templates": f["templates"]}
            fac = Facility(facility_id=fid, name=f["facility"]["name"], need_per_shift=NEED[fid],
                           staff=[StaffMember(**{k: v for k, v in s.items() if k in StaffMember.model_fields}) for s in f["staff"]])
            for ym, m in f["rosters"].items():
                mo = Month(month=ym, days=m["days"], first_weekday=m["firstWeekday"])
                r._seed[fid, ym] = {"proposal": m["proposal"], "days": m["days"], "firstWeekday": m["firstWeekday"],
                                    "carryIn": carry_in(fid, ym, out) if ym == "2026-11" else {}}
                by: dict[str, list[int]] = {}
                for q in reqs:
                    if q["facility_id"] == fid and q["date"].startswith(ym) and q["kind"] == "off":
                        by.setdefault(q["staff_id"], []).append(int(q["date"][8:10]))
                r._requests[fid, ym] = by
            r._rules[fid] = {x.id: x.model_dump(mode="json") for x in default_rules(fac, mo)}
        return r

    # --- 参照
    def list_facilities(self):
        return [v["facility"] for v in self.fac.values()]

    def facility(self, fid):
        if fid not in self.fac:
            raise NotFound(fid)
        return copy.deepcopy(self.fac[fid])

    def rules(self, fid):
        return copy.deepcopy(list(self._rules.get(fid, {}).values()))

    def add_rule(self, fid, rule):
        if rule["id"] in self._rules.setdefault(fid, {}):
            raise Conflict(rule["id"])
        self._rules[fid][rule["id"]] = copy.deepcopy(rule)

    def stop_rule(self, fid, rid, event):
        if rid not in self._rules.get(fid, {}):
            raise NotFound(rid)
        self._rules[fid][rid].setdefault("lifecycle", {})["stopped"] = True
        self._rule_events.setdefault(fid, []).append(event)

    def requests(self, fid, month):
        return copy.deepcopy(self._requests.get((fid, month), {}))

    def seed_roster(self, fid, month):
        return copy.deepcopy(self._seed.get((fid, month)))

    def latest_proposal(self, fid, month):
        ps = [p for p in self._proposals.get(fid, []) if p["month"] == month]
        return copy.deepcopy(max(ps, key=lambda p: p["created_at"])) if ps else None

    def add_proposal(self, fid, doc):
        if any(p["id"] == doc["id"] for p in self._proposals.get(fid, [])):
            raise Conflict(doc["id"])
        self._proposals.setdefault(fid, []).append(copy.deepcopy(doc))

    def edits(self, fid, month, proposal_id):
        es = [e for e in self._edits.get(fid, []) if e["month"] == month and e.get("proposal_id") == proposal_id]
        return copy.deepcopy(sorted(es, key=lambda e: e["edited_at"]))

    def add_edit(self, fid, doc):
        if any(e["edit_id"] == doc["edit_id"] for e in self._edits.get(fid, [])):
            raise Conflict(doc["edit_id"])
        self._edits.setdefault(fid, []).append(copy.deepcopy(doc))

    def vacancy_count(self, fid, date):
        return sum(1 for v in self._vac.get(fid, {}).values() if v["date"] == date)

    def add_vacancy(self, fid, doc):
        if doc["vacancy_id"] in self._vac.setdefault(fid, {}):
            raise Conflict(doc["vacancy_id"])
        self._vac[fid][doc["vacancy_id"]] = copy.deepcopy(doc)

    def vacancy(self, fid, vid):
        if vid not in self._vac.get(fid, {}):
            raise NotFound(vid)
        return copy.deepcopy(self._vac[fid][vid])

    def update_vacancy(self, fid, vid, patch):
        self.vacancy(fid, vid)
        self._vac[fid][vid].update(copy.deepcopy(patch))

    def vacancies(self, fid, month):
        return copy.deepcopy([v for v in self._vac.get(fid, {}).values() if month is None or v["date"].startswith(month)])

    def add_offer(self, fid, vid, doc):
        if doc["offer_id"] in self._offers.setdefault((fid, vid), {}):
            raise Conflict(doc["offer_id"])
        self._offers[fid, vid][doc["offer_id"]] = copy.deepcopy(doc)

    def offer(self, fid, vid, oid):
        if oid not in self._offers.get((fid, vid), {}):
            raise NotFound(oid)
        return copy.deepcopy(self._offers[fid, vid][oid])

    def update_offer(self, fid, vid, oid, patch):
        self.offer(fid, vid, oid)
        self._offers[fid, vid][oid].update(copy.deepcopy(patch))

    def offers(self, fid, vid):
        return copy.deepcopy(sorted(self._offers.get((fid, vid), {}).values(), key=lambda o: o["rank"]))

    def rule_events(self, fid):
        return copy.deepcopy(self._rule_events.get(fid, []))

    def add_rule_event(self, fid, doc):
        self._rule_events.setdefault(fid, []).append(copy.deepcopy(doc))

    def incr_usage(self, key, limit):
        n = self._usage.get(key, 0)
        if n >= limit:
            return False
        self._usage[key] = n + 1
        return True


# ---------------------------------------------------------------- Firestore

class FirestoreRepo:
    def __init__(self, project: str | None = None) -> None:
        from google.cloud import firestore

        self._fs = firestore
        self.db = firestore.Client(project=project)

    def _f(self, fid: str):
        return self.db.collection("facilities").document(fid)

    def _create(self, ref, doc: dict) -> None:
        from google.api_core.exceptions import AlreadyExists

        try:
            ref.create(doc)
        except AlreadyExists as e:
            raise Conflict(ref.id) from e

    def list_facilities(self):
        out = []
        for d in self.db.collection("facilities").stream():
            x = d.to_dict() or {}
            if x.get("name"):
                out.append(x)
        return sorted(out, key=lambda x: x["id"])

    def facility(self, fid):
        d = self._f(fid).get()
        if not d.exists:
            raise NotFound(fid)
        return {"facility": d.to_dict(), "staff": [x.to_dict() for x in self._f(fid).collection("staff").stream()],
                "templates": [x.to_dict() for x in self._f(fid).collection("taskTemplates").stream()]}

    def rules(self, fid):
        return [x.to_dict() for x in self._f(fid).collection("rules").stream()]

    def add_rule(self, fid, rule):
        self._create(self._f(fid).collection("rules").document(rule["id"]), rule)

    def stop_rule(self, fid, rid, event):
        ref = self._f(fid).collection("rules").document(rid)
        if not ref.get().exists:
            raise NotFound(rid)
        ref.update({"lifecycle.stopped": True})
        self._f(fid).collection("ruleEvents").document(event["event_id"]).set(event)

    def requests(self, fid, month):
        d = self._f(fid).collection("requests").document(month).get()
        return {k: [int(x) for x in v] for k, v in ((d.to_dict() or {}).get("byStaff") or {}).items()}

    def seed_roster(self, fid, month):
        d = self._f(fid).collection("rosters").document(month).get()
        if not d.exists:
            return None
        x = d.to_dict()
        return {"proposal": x["proposal"], "days": x["days"], "firstWeekday": x["firstWeekday"], "carryIn": x.get("carryIn") or {}}

    def latest_proposal(self, fid, month):
        # 単一フィールドの等価条件だけにして複合インデックスを不要にする（件数は月に数件）
        ps = [d.to_dict() for d in self._f(fid).collection("proposals").where("month", "==", month).stream()]
        return max(ps, key=lambda p: p["created_at"]) if ps else None

    def add_proposal(self, fid, doc):
        self._create(self._f(fid).collection("proposals").document(doc["id"]), doc)

    def edits(self, fid, month, proposal_id):
        q = self._f(fid).collection("edits").where("month", "==", month).where("proposal_id", "==", proposal_id).stream()
        return sorted((d.to_dict() for d in q), key=lambda e: e["edited_at"])

    def add_edit(self, fid, doc):
        self._create(self._f(fid).collection("edits").document(doc["edit_id"]), doc)

    def vacancy_count(self, fid, date):
        return sum(1 for _ in self._f(fid).collection("vacancies").where("date", "==", date).stream())

    def add_vacancy(self, fid, doc):
        self._create(self._f(fid).collection("vacancies").document(doc["vacancy_id"]), doc)

    def vacancy(self, fid, vid):
        d = self._f(fid).collection("vacancies").document(vid).get()
        if not d.exists:
            raise NotFound(vid)
        return d.to_dict()

    def update_vacancy(self, fid, vid, patch):
        self._f(fid).collection("vacancies").document(vid).update(patch)

    def vacancies(self, fid, month):
        q = self._f(fid).collection("vacancies")
        if month:
            q = q.where("date", ">=", f"{month}-01").where("date", "<=", f"{month}-31")
        return [d.to_dict() for d in q.stream()]

    def _offers(self, fid, vid):
        return self._f(fid).collection("vacancies").document(vid).collection("offers")

    def add_offer(self, fid, vid, doc):
        self._create(self._offers(fid, vid).document(doc["offer_id"]), doc)

    def offer(self, fid, vid, oid):
        d = self._offers(fid, vid).document(oid).get()
        if not d.exists:
            raise NotFound(oid)
        return d.to_dict()

    def update_offer(self, fid, vid, oid, patch):
        self._offers(fid, vid).document(oid).update(patch)

    def offers(self, fid, vid):
        return sorted((d.to_dict() for d in self._offers(fid, vid).stream()), key=lambda o: o["rank"])

    def rule_events(self, fid):
        return [d.to_dict() for d in self._f(fid).collection("ruleEvents").stream()]

    def add_rule_event(self, fid, doc):
        self._f(fid).collection("ruleEvents").document(doc["event_id"]).set(doc)

    def incr_usage(self, key, limit):
        """AI 利用回数。トランザクションで『上限未満なら +1』。old care-api の usage/{日付} とは別コレクション。"""
        ref = self.db.collection("aiUsage").document(key)

        @self._fs.transactional
        def tx(t):
            n = (ref.get(transaction=t).to_dict() or {}).get("n", 0)
            if n >= limit:
                return False
            t.set(ref, {"n": n + 1})
            return True

        return tx(self.db.transaction())


def make_repo() -> Any:
    """STORE=memory（要 SYNTH_DIR）または firestore（既定）。"""
    kind = os.getenv("STORE", "firestore")
    if kind == "memory":
        return MemoryRepo.from_synth(os.environ["SYNTH_DIR"])
    return FirestoreRepo(os.getenv("GOOGLE_CLOUD_PROJECT") or None)
