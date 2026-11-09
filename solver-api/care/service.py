"""API のユースケース。保存層（Repo）とソルバーをつなぐ。FastAPI には依存しない。"""
from __future__ import annotations

import calendar
import copy
import json
import os
import time
import uuid
from datetime import date, datetime, timedelta, timezone

from pydantic import TypeAdapter

from .dsl import (ALL_KINDS, OFF, Facility, Month, MonthlyRule, Origin, PeopleSel, DaySel, Request, ShiftSel, StaffMember,
                  TaskRequest, TaskTemplate)
from .solver.coverage import slot_label
from .solver.daily import on_duty, solve_daily
from .solver.explain import explain_daily, explain_monthly
from .solver.loop import solve_integrated
from .solver.monthly import DEFAULT_WORKERS, WORK_H, solve_monthly
from .learn import scoring
from .learn.features import FEATURES
from .store import Conflict, NotFound
from .verify import verify_monthly

_RULES = TypeAdapter(MonthlyRule)


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def month_obj(month: str) -> Month:
    try:
        y, m = map(int, month.split("-"))
        first = date(y, m, 1)
    except Exception as e:  # noqa: BLE001
        raise ServiceError(400, f"month は YYYY-MM で指定してください: {month}") from e
    return Month(month=month, days=calendar.monthrange(y, m)[1], first_weekday=first.isoweekday() % 7)


def prev_month(month: str) -> str:
    y, m = map(int, month.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


class Events:
    """業務イベントを Pub/Sub へ（BigQuery subscription が care_analytics.events_raw に書く）。未設定ならメモリに溜める。"""

    def __init__(self) -> None:
        self.topic = os.getenv("PUBSUB_TOPIC")
        self.project = os.getenv("GOOGLE_CLOUD_PROJECT")
        self.local: list[dict] = []
        self._pub = None

    def emit(self, facility_id: str, event_type: str, payload: dict, vacancy_id: str | None = None) -> dict:
        ev = {"event_id": str(uuid.uuid4()), "event_type": event_type, "vacancy_id": vacancy_id, "facility_id": facility_id,
              "ts": time.time(), "payload": json.dumps(payload, ensure_ascii=False)}
        self.local = (self.local + [ev])[-500:]
        if self.topic:
            try:
                if self._pub is None:
                    from google.cloud import pubsub_v1

                    self._pub = pubsub_v1.PublisherClient()
                self._pub.publish(self._pub.topic_path(self.project, self.topic), json.dumps(ev, ensure_ascii=False).encode())
            except Exception as e:  # noqa: BLE001  イベント送信の失敗で業務操作を止めない
                print(f"[events] publish failed: {e}")
        return ev


class Svc:
    def __init__(self, repo, events: Events | None = None, models=None) -> None:
        self.repo = repo
        self.events = events or Events()
        self.models = models                   # 学習の成果物（champion モデル・履歴・反復検出）。None なら従来の順位付け

    # ------------------------------------------------------------ 読み込み
    def facility(self, fid: str) -> Facility:
        try:
            d = self.repo.facility(fid)
        except NotFound as e:
            raise ServiceError(404, f"施設が見つかりません: {fid}") from e
        return Facility(
            facility_id=fid, name=d["facility"]["name"], need_per_shift=d["facility"].get("needPerShift", {}),
            staff=[StaffMember(**{k: v for k, v in s.items() if k in StaffMember.model_fields}) for s in d["staff"]],
            templates=[TaskTemplate(**{k: v for k, v in t.items() if k in TaskTemplate.model_fields}) for t in d["templates"]])

    def rules(self, fid: str, month: str | None = None, include_requests: bool = True):
        """(月次ルール, 日次ルール, 読めなかったルールの id)。希望休は Request ルールとして足す。"""
        monthly, daily, bad = [], [], []
        for d in self.repo.rules(fid):
            try:
                if d.get("type") == "taskRequest":
                    daily.append(TaskRequest.model_validate(d))
                else:
                    monthly.append(_RULES.validate_python(d))
            except Exception:  # noqa: BLE001
                bad.append(d.get("id", "?"))
        if month and include_requests:
            for sid, days in sorted(self.repo.requests(fid, month).items()):
                monthly.append(Request(id=f"req-{sid}", label=f"{sid} の希望休（{len(days)}日）", strength="強く",
                                       origin=Origin(kind="手入力"), people=PeopleSel(ids=[sid]), days=DaySel(dates=sorted(days)),
                                       shifts=ShiftSel(ids=[OFF]), want=True))
        return [r for r in monthly if not r.lifecycle.stopped], [r for r in daily if not r.lifecycle.stopped], bad

    def roster(self, fid: str, month: str) -> dict:
        """現状の表 = 最新の提案 + その提案に対する手修正。表を上書き保存する経路は無い。"""
        mo = month_obj(month)
        p = self.repo.latest_proposal(fid, month)
        if p:
            base, pid = p["cells"], p["id"]
        else:
            seed = self.repo.seed_roster(fid, month)
            if not seed:
                raise ServiceError(404, f"{month} の勤務表がありません。先に solve してください")
            base, pid = {sid: [x or "" for x in row] for sid, row in seed["proposal"].items()}, None
        cells = copy.deepcopy(base)
        edits = self.repo.edits(fid, month, pid)
        for e in edits:
            cells[e["staff_id"]][e["day"] - 1] = e["to_shift"]
        return {"month": mo, "base": base, "cells": cells, "proposal_id": pid, "edits": edits, "proposal": p}

    def carry_in(self, fid: str, month: str) -> dict[str, str]:
        seed = self.repo.seed_roster(fid, month)
        if seed and seed.get("carryIn"):
            return seed["carryIn"]
        try:
            prev = self.roster(fid, prev_month(month))
        except ServiceError:
            return {}
        return {sid: row[-1] for sid, row in prev["cells"].items() if row and row[-1]}

    # ------------------------------------------------------------ 求解
    def solve(self, fid: str, month: str, *, time_limit: float = 15.0, with_daily: bool = True) -> dict:
        fac, mo = self.facility(fid), month_obj(month)
        rules, drules, bad = self.rules(fid, month)
        ci = self.carry_in(fid, month)
        if with_daily:
            r = solve_integrated(fac, mo, rules, carry_in=ci, daily_rules=drules, monthly_time=time_limit, daily_time=1.0, budget=40.0, max_iter=2)
            m, daily = r.monthly, r.daily
        else:
            m, daily, r = solve_monthly(fac, mo, rules, carry_in=ci, time_limit=time_limit, workers=DEFAULT_WORKERS), {}, None
        out = {"facility_id": fid, "month": month, "status": m.status, "wall_ms": r.wall_ms if r else m.wall_ms,
               "explanation": explain_monthly(m), "warnings": [f"読み込めなかったルール: {', '.join(bad)}"] if bad else []}
        if m.status not in ("OPTIMAL", "FEASIBLE"):
            out["relaxation"] = [{"rule_id": b.rule_id, "label": b.label, "count": b.count, "detail": b.detail} for b in m.relaxation]
            return out          # 解けなかった表は保存しない
        out["soft_broken"] = [{"rule_id": b.rule_id, "label": b.label, "count": b.count, "detail": b.detail} for b in m.soft_broken]
        if r:
            out["iterations"] = [{"n": i.n, "monthly_ms": i.monthly_ms, "daily_ms": i.daily_ms, "unmet": i.unmet} for i in r.iterations]
            out["unmet_total"] = r.unmet_total
        pid = f"P-{month}-{uuid.uuid4().hex[:8]}"
        doc = {"id": pid, "facility_id": fid, "month": month, "created_at": now(), "status": m.status, "cells": m.cells,
               "soft_broken": out["soft_broken"], "unmet_total": out.get("unmet_total"), "wall_ms": out["wall_ms"]}
        self.repo.add_proposal(fid, doc)
        out["proposal_id"] = pid
        self.events.emit(fid, "roster_proposed", {"month": month, "proposal_id": pid, "status": m.status, "wall_ms": out["wall_ms"]})
        return out

    def verify(self, fid: str, month: str) -> dict:
        fac = self.facility(fid)
        rules, _, _ = self.rules(fid, month)
        ro = self.roster(fid, month)
        broken = verify_monthly(fac, ro["month"], ro["cells"], rules, self.carry_in(fid, month))
        by = {r.id: r for r in rules}
        return {"month": month, "proposal_id": ro["proposal_id"], "ok": not broken, "broken": [
            {"rule_id": k, "label": by[k].label if k in by else k, "strength": by[k].strength if k in by else "絶対", "count": n}
            for k, n in sorted(broken.items(), key=lambda x: -x[1])]}

    def daily(self, fid: str, day: str, *, time_limit: float = 5.0) -> dict:
        month = day[:7]
        fac, ro = self.facility(fid), self.roster(fid, month)
        try:
            d = int(day[8:10])
        except ValueError as e:
            raise ServiceError(400, f"date は YYYY-MM-DD: {day}") from e
        if not 1 <= d <= ro["month"].days:
            raise ServiceError(400, f"{month} に {d} 日はありません")
        _, drules, _ = self.rules(fid, month, include_requests=False)
        res = solve_daily(fac, ro["month"], ro["cells"], d, carry_in=self.carry_in(fid, month), rules=drules, time_limit=time_limit)
        name = {s.staff_id: s.name for s in fac.staff}
        duty = {sd.staff.staff_id: sd for sd in on_duty(fac, ro["month"], ro["cells"], d, self.carry_in(fid, month))}
        rows: dict[str, list[dict]] = {}
        for a in res.assignments:
            rows.setdefault(a["staff_id"], []).append({"kind": "task", "task": a["task"], "start": slot_label(a["start"]),
                                                       "end": slot_label(a["end"]) if a["end"] < 48 else "24:00"})
        for b in res.breaks:
            rows.setdefault(b["staff_id"], []).append({"kind": "break", "task": "break", "start": slot_label(b["start"]), "end": slot_label(b["end"])})
        staff = [{"staff_id": sid, "name": name[sid], "shift": sd.shift, "carried_from_previous_night": sd.prev_day,
                  "items": sorted(rows.get(sid, []), key=lambda x: x["start"])} for sid, sd in duty.items()]
        return {"facility_id": fid, "date": day, "status": res.status, "wall_ms": res.wall_ms, "switches": res.switches,
                "staff": staff, "unmet": res.unmet, "explanation": explain_daily(res)}

    # ------------------------------------------------------------ 手修正（追記のみ）
    def add_edit(self, fid: str, month: str, staff_id: str, day: int, to: str, *, kind: str = "manual", reason: str | None = None,
                 check: bool = True) -> dict:
        fac, ro = self.facility(fid), self.roster(fid, month)
        to = "" if to in (OFF, "") else to
        if to and to not in ALL_KINDS:
            raise ServiceError(400, f"勤務区分が不正です: {to}")
        if staff_id not in ro["cells"]:
            raise ServiceError(404, f"従業員が見つかりません: {staff_id}")
        if not 1 <= day <= ro["month"].days:
            raise ServiceError(400, f"{month} に {day} 日はありません")
        frm = ro["cells"][staff_id][day - 1]
        if frm == to:
            raise ServiceError(409, "すでにその勤務です（変更なし）")
        doc = {"edit_id": f"EDIT-{datetime.now(timezone.utc):%Y%m%d%H%M%S%f}-{uuid.uuid4().hex[:6]}", "facility_id": fid, "month": month,
               "proposal_id": ro["proposal_id"], "staff_id": staff_id, "day": day, "weekday": (ro["month"].first_weekday + day - 1) % 7,
               "from_shift": frm, "to_shift": to, "kind": kind, "reason": reason, "edited_at": now(), "synthetic": False}
        self.repo.add_edit(fid, doc)
        self.events.emit(fid, "roster_edit", {k: doc[k] for k in ("staff_id", "month", "day", "from_shift", "to_shift", "kind")})
        if not check:
            return {"edit": doc}
        v = self.verify(fid, month)
        return {"edit": doc, "after": {"ok": v["ok"], "broken": v["broken"]}}

    # ------------------------------------------------------------ 欠員フロー
    def _rank(self, fac: Facility, ro: dict, rules: list, ci: dict, vac: dict) -> tuple[list[dict], list[dict]]:
        cells, mo, day, shift = ro["cells"], ro["month"], int(vac["date"][8:10]), vac["shift"]
        by = {r.id: r for r in rules}
        base = verify_monthly(fac, mo, cells, rules, ci)
        ok, excluded = [], []
        for s in fac.staff:
            sid = s.staff_id
            if sid == vac["absent_staff_id"] or cells[sid][day - 1]:
                continue
            if shift not in s.shifts:
                continue
            if vac.get("need_skills") and not set(vac["need_skills"]) <= set(s.skills):
                excluded.append({"staff_id": sid, "name": s.name, "reason": "必要な資格がない"})
                continue
            hypo = {**cells, sid: [*cells[sid][: day - 1], shift, *cells[sid][day:]]}
            v = verify_monthly(fac, mo, hypo, rules, ci)
            worse = {k: n - base.get(k, 0) for k, n in v.items() if n > base.get(k, 0)}
            hard = [k for k in worse if k in by and by[k].strength == "絶対"]
            if hard:
                excluded.append({"staff_id": sid, "name": s.name, "reason": f"「{by[hard[0]].label}」を破る"})
                continue
            hours = sum(WORK_H[x] for x in cells[sid] if x)
            reasons = []
            if s.home_unit and s.home_unit == vac.get("unit_id"):
                reasons.append("同じユニット")
            reasons.append(f"今月の勤務 {sum(1 for x in cells[sid] if x)}日")
            soft = [by[k].label for k in worse if k in by]
            if soft:
                reasons.append("次のルールが新たに破れる: " + "、".join(soft))
            score = (1.0 if s.home_unit == vac.get("unit_id") else 0.0) - 0.02 * hours - 0.5 * len(soft)
            ok.append({"staff_id": sid, "name": s.name, "score": round(score, 3), "reasons": reasons,
                       "accept_probability": None})      # 受諾確率は Vertex AI の予測（P5）が入る
        return self._apply_model(fac, ro, vac, ok), excluded[:5]

    JA = {"log_lead": "依頼までの余裕", "is_night": "夜勤の依頼", "is_early": "早番の依頼", "is_late": "遅番の依頼", "same_unit": "同じユニット",
          "skill_match": "必要な資格", "consec_excess": "連勤が続いていること", "hours_dev": "今月の勤務時間", "nights_last30": "最近の夜勤の多さ",
          "offers_last14": "最近の打診の多さ", "tenure": "経験年数", "part_time": "パート勤務", "is_weekend": "土日の依頼", "staff_prior": "この人の過去の応諾率"}

    def _apply_model(self, fac: Facility, ro: dict, vac: dict, ok: list[dict]) -> list[dict]:
        """champion モデルがあれば、応諾確率で順位をつける。無ければ従来のスコア順（理由に『モデルなし』は出さない）。"""
        art = self.models.champion(fac.facility_id) if self.models else None
        if not art or not ok:
            ok.sort(key=lambda x: -x["score"])
            return ok
        for c in ok:
            row = self.offer_features(fac.facility_id, fac, ro, vac, c["staff_id"])
            row["staff_id"], row["status"] = c["staff_id"], ""
            p = scoring.predict(art, row)
            c["accept_probability"] = round(p, 3)
            c["reasons"].insert(0, f"応諾の見込み {p * 100:.0f}%（この施設の過去の打診から学習）")
            top = [f"{self.JA.get(n, n)}が{'プラス' if v > 0 else 'マイナス'}" for n, v in scoring.explain(art, row, 2) if abs(v) >= 0.15]
            if top:
                c["reasons"].append("影響の大きい要因: " + "、".join(top))
            c["rank_score"] = round(p - 0.03 * sum(1 for r in c["reasons"] if r.startswith("次のルールが新たに")), 4)
        ok.sort(key=lambda x: -x["rank_score"])
        return ok

    SHIFT_START = {"早番": 7.0, "日勤": 9.0, "遅番": 12.0, "夜勤": 16.5}

    def offer_features(self, fid: str, fac: Facility, ro: dict, vac: dict, staff_id: str, *, now_iso: str | None = None) -> dict:
        """打診の時点で分かる特徴量（fact_offers と同じ列）。学習・採点・イベントの記録で共通。"""
        s = next(x for x in fac.staff if x.staff_id == staff_id)
        day = int(vac["date"][8:10])
        cells = ro["cells"]
        y, m = map(int, vac["date"][:7].split("-"))
        start = datetime(y, m, day, tzinfo=timezone.utc) + timedelta(hours=self.SHIFT_START[vac["shift"]] - 9)   # JST を UTC に
        t0 = datetime.fromisoformat((now_iso or vac.get("discovered_at") or vac["created_at"]).replace("Z", "+00:00"))
        run = 0
        while day - 1 - run > 0 and cells[staff_id][day - 2 - run]:
            run += 1
        sent14 = 0
        for v in self.repo.vacancies(fid, vac["date"][:7]):
            for o in self.repo.offers(fid, v["vacancy_id"]):
                if o["staff_id"] == staff_id and o.get("offered_at") and datetime.fromisoformat(o["offered_at"].replace("Z", "+00:00")) >= t0 - timedelta(days=14):
                    sent14 += 1
        row = cells[staff_id]
        return {"lead_hours": round(max((start - t0).total_seconds() / 3600, 0.5), 2), "weekday": (ro["month"].first_weekday + day - 1) % 7, "shift": vac["shift"],
                "same_unit": bool(s.home_unit and s.home_unit == vac.get("unit_id")), "skill_match": set(vac.get("need_skills") or []) <= set(s.skills),
                "consec_before": run, "month_hours_before": float(sum(WORK_H[x] for x in row[: day - 1] if x)),
                "nights_last30": sum(1 for x in row[max(0, day - 31): day - 1] if x == "夜勤"), "offers_last14": sent14,
                "tenure_years": s.years, "employment": s.employment}

    def create_vacancy(self, fid: str, date_s: str, shift: str, absent_staff_id: str, *, reason: str | None = None,
                       need_skills: list[str] | None = None, discovered_at: str | None = None) -> dict:
        fac, month = self.facility(fid), date_s[:7]
        ro = self.roster(fid, month)
        day = int(date_s[8:10])
        if absent_staff_id not in ro["cells"] or ro["cells"][absent_staff_id][day - 1] != shift:
            raise ServiceError(409, f"{absent_staff_id} は {date_s} に {shift} に入っていません")
        absent = next(s for s in fac.staff if s.staff_id == absent_staff_id)
        n = self.repo.vacancy_count(fid, date_s) + 1
        vid = f"VAC-{date_s.replace('-', '')}-{fid.split('-')[-1][:3].upper()}{n:02d}"
        self.add_edit(fid, month, absent_staff_id, day, "", kind="absence", reason=reason or "欠勤", check=False)
        doc = {"vacancy_id": vid, "facility_id": fid, "date": date_s, "shift": shift, "unit_id": absent.home_unit,
               "need_skills": need_skills or [], "reason": reason or "欠勤", "absent_staff_id": absent_staff_id, "state": "open",
               "created_at": now(), "discovered_at": discovered_at or now(), "filled_by": None, "filled_at": None}
        try:
            self.repo.add_vacancy(fid, doc)
        except Conflict as e:
            raise ServiceError(409, "欠員 ID が重複しました。もう一度実行してください") from e
        self.events.emit(fid, "vacancy_created", {k: doc[k] for k in ("date", "shift", "unit_id", "reason", "absent_staff_id")}, vid)
        return {"vacancy": doc, **self.candidates(fid, vid)}

    def candidates(self, fid: str, vid: str) -> dict:
        try:
            vac = self.repo.vacancy(fid, vid)
        except NotFound as e:
            raise ServiceError(404, f"欠員が見つかりません: {vid}") from e
        fac, month = self.facility(fid), vac["date"][:7]
        rules, _, _ = self.rules(fid, month)
        ok, excluded = self._rank(fac, self.roster(fid, month), rules, self.carry_in(fid, month), vac)
        return {"candidates": ok[:8], "excluded": excluded}

    def offer(self, fid: str, vid: str, staff_id: str) -> dict:
        vac = self._vac(fid, vid)
        if vac["state"] == "filled":
            raise ServiceError(409, "この欠員はすでに充足しています")
        if staff_id not in {s.staff_id for s in self.facility(fid).staff}:
            raise ServiceError(404, f"従業員が見つかりません: {staff_id}")
        existing = self.repo.offers(fid, vid)
        if any(o["staff_id"] == staff_id and o["status"] == "pending" for o in existing):
            raise ServiceError(409, "その人にはすでに打診中です")
        fac = self.facility(fid)
        feats = self.offer_features(fid, fac, self.roster(fid, vac["date"][:7]), vac, staff_id)     # 打診の時点の特徴量（学習に使う）
        doc = {"offer_id": f"OFF-{vid}-{len(existing) + 1}", "vacancy_id": vid, "facility_id": fid, "staff_id": staff_id,
               "rank": len(existing) + 1, "status": "pending", "offered_at": now(), "responded_at": None, "features": feats}
        self.repo.add_offer(fid, vid, doc)
        self.repo.update_vacancy(fid, vid, {"state": "offering"})
        self.events.emit(fid, "offer_sent", {"staff_id": staff_id, "rank": doc["rank"], "features": feats}, vid)
        return doc

    def respond(self, fid: str, vid: str, oid: str, status: str) -> dict:
        vac = self._vac(fid, vid)
        try:
            off = self.repo.offer(fid, vid, oid)
        except NotFound as e:
            raise ServiceError(404, f"打診が見つかりません: {oid}") from e
        if off["status"] != "pending":
            raise ServiceError(409, f"この打診はすでに{off['status']}です")
        if status == "accepted":
            if vac["state"] == "filled":
                raise ServiceError(409, "この欠員はすでに充足しています")
            self.add_edit(fid, vac["date"][:7], off["staff_id"], int(vac["date"][8:10]), vac["shift"], kind="vacancy_cover",
                          reason=f"{vid} の補充", check=False)
            self.repo.update_vacancy(fid, vid, {"state": "filled", "filled_by": off["staff_id"], "filled_at": now()})
        self.repo.update_offer(fid, vid, oid, {"status": status, "responded_at": now()})
        self.events.emit(fid, "offer_responded", {"staff_id": off["staff_id"], "status": status}, vid)
        if status == "accepted":
            self.events.emit(fid, "vacancy_filled", {"by": off["staff_id"], "route": "offer"}, vid)
        return {"offer": {**off, "status": status}, "vacancy": self.repo.vacancy(fid, vid)}

    def replan(self, fid: str, vid: str, *, apply: bool = False, time_limit: float = 10.0) -> dict:
        """欠員の日から先だけを、最小変更で組み直す案を作る。apply=True で編集ログに追記する。"""
        vac = self._vac(fid, vid)
        month, day = vac["date"][:7], int(vac["date"][8:10])
        fac, ro = self.facility(fid), self.roster(fid, month)
        rules, _, _ = self.rules(fid, month)
        cells = ro["cells"]
        fixed = {sid: {d: (cells[sid][d - 1] or OFF) for d in range(1, day)} for sid in cells}      # 欠員の前の日は動かさない
        fixed[vac["absent_staff_id"]][day] = OFF
        r = solve_monthly(fac, ro["month"], rules, carry_in=self.carry_in(fid, month), baseline=cells, fixed=fixed, time_limit=time_limit,
                          workers=DEFAULT_WORKERS)
        out = {"vacancy_id": vid, "status": r.status, "wall_ms": r.wall_ms, "explanation": explain_monthly(r), "applied": False}
        if r.status not in ("OPTIMAL", "FEASIBLE"):
            return out
        name = {s.staff_id: s.name for s in fac.staff}
        changes = [{"staff_id": sid, "name": name[sid], "day": d, "from": cells[sid][d - 1], "to": r.cells[sid][d - 1]}
                   for sid in cells for d in range(1, ro["month"].days + 1) if cells[sid][d - 1] != r.cells[sid][d - 1]]
        out.update(changes=changes, changed_cells=len(changes))
        if apply:
            for c in changes:
                self.add_edit(fid, month, c["staff_id"], c["day"], c["to"], kind="replan", reason=f"{vid} の組み直し", check=False)
            self.repo.update_vacancy(fid, vid, {"state": "replanned", "filled_at": now()})
            self.events.emit(fid, "vacancy_filled", {"by": None, "route": "replan", "changed_cells": len(changes)}, vid)
            out["applied"] = True
        return out

    def _vac(self, fid: str, vid: str) -> dict:
        try:
            return self.repo.vacancy(fid, vid)
        except NotFound as e:
            raise ServiceError(404, f"欠員が見つかりません: {vid}") from e

    # ------------------------------------------------------------ 学習（応諾予測・反復検出）
    def model_info(self, fid: str) -> dict:
        from .learn.store import public_meta

        self.facility(fid)
        champ = self.models.champion(fid) if self.models else None
        hist = self.models.history(fid) if self.models else []
        return {"facility_id": fid, "using_model": bool(champ), "champion": public_meta(champ), "history": hist,
                "note": None if champ else "この施設は、基準（件数に依らない基本確率）を上回るモデルがまだありません。従来の順位付けを使っています"}

    @staticmethod
    def learned_rule_id(key: str) -> str:
        return "r-learned-" + key.replace(":", "-")

    def learned_candidates(self, fid: str, month: str | None = None) -> dict:
        """手修正のくり返しから見つけたルール候補。すでにルールにした・却下したものは出さない（一度答えたら、もう聞かない）。"""
        from .learn.detect import to_rule

        fac = self.facility(fid)
        doc = self.models.learned(fid) if self.models else None
        if not doc:
            return {"facility_id": fid, "detected_at": None, "candidates": []}
        names = {s.staff_id: s.name for s in fac.staff}
        have = {r["id"] for r in self.repo.rules(fid)}
        dismissed = {e["key"] for e in self.repo.rule_events(fid) if e.get("event") == "learned_dismissed"}
        cur, ci = None, None
        if month:
            try:
                cur, ci = self.roster(fid, month), self.carry_in(fid, month)
            except ServiceError:
                cur = None
        out = []
        for c in doc["candidates"]:
            if self.learned_rule_id(c["key"]) in have or c["key"] in dismissed:
                continue
            choices = [{"label": "ずっと続ける（期限なし）", "rule": to_rule(c, names)}, {"label": "3か月だけ", "rule": to_rule(c, names, term_months=3)}]
            item = {**{k: c[k] for k in ("key", "kind", "staff_id", "evidence", "threshold")}, "name": names.get(c["staff_id"], c["staff_id"]),
                    "question": f"{choices[0]['rule']['label']}、というルールにしますか？", "choices": choices,
                    "repeated": c.get("months_repeated") or c.get("days_repeated"), "edit_ids": c["edit_ids"]}
            if cur and c["kind"] == "roster":
                from pydantic import TypeAdapter

                rule = _RULES.validate_python(choices[0]["rule"])
                item["impact"] = {"broken_now": sum(verify_monthly(fac, cur["month"], cur["cells"], [rule], ci).values())}
            out.append(item)
        return {"facility_id": fid, "detected_at": doc["detected_at"], "edits_seen": doc.get("edits_seen"), "candidates": out}

    def dismiss_learned(self, fid: str, key: str, reason: str) -> dict:
        self.facility(fid)
        self.repo.add_rule_event(fid, {"event_id": f"RE-{uuid.uuid4().hex[:10]}", "event": "learned_dismissed", "key": key, "reason": reason, "at": now()})
        return {"key": key, "dismissed": True}

    # ------------------------------------------------------------ ルール
    def add_rule(self, fid: str, rule_dict: dict) -> dict:
        try:
            rule = _RULES.validate_python(rule_dict)
        except Exception as e:  # noqa: BLE001
            raise ServiceError(422, f"ルールの形が不正です: {str(e)[:300]}") from e
        if rule.origin.kind == "手入力" and not rule.origin.evidence:
            rule.origin.evidence = "API から追加"
        self.facility(fid)
        try:
            self.repo.add_rule(fid, rule.model_dump(mode="json"))
        except Conflict as e:
            raise ServiceError(409, f"同じ id のルールがあります: {rule.id}") from e
        return rule.model_dump(mode="json")

    def stop_rule(self, fid: str, rid: str, reason: str) -> dict:
        try:
            self.repo.stop_rule(fid, rid, {"event_id": f"RE-{uuid.uuid4().hex[:10]}", "rule_id": rid, "event": "stopped", "reason": reason, "at": now()})
        except NotFound as e:
            raise ServiceError(404, f"ルールが見つかりません: {rid}") from e
        return {"rule_id": rid, "stopped": True, "reason": reason}
