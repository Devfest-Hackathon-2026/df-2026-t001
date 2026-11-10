#!/usr/bin/env python3
"""API の通し確認（標準ライブラリのみ）。ローカルでもデプロイ先でも同じ手順で動く。

  python solver-api/scripts/smoke.py https://<service-url> [facility]

求解 → 検証 → 日次 → 欠員（候補・打診・受諾）→ 組み直し案 → ルール追加と停止。
Firestore に提案・手修正・欠員が追記される。デモ状態に戻すには solver-api/scripts/reset_demo.py。
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080").rstrip("/")
FID = sys.argv[2] if len(sys.argv) > 2 else "fac-hidamari"
P = f"{BASE}/api/v1/facilities/{FID}"
fails: list[str] = []


def call(method, url, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}"), time.time() - t
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), time.time() - t


def check(name, cond, detail=""):
    print(("  ok  " if cond else "  NG  ") + name + (f"  {detail}" if detail else ""))
    if not cond:
        fails.append(name)


st, h, _ = call("GET", f"{BASE}/api/healthz")
check("healthz", st == 200 and h.get("ok"), str(h))
st, f, _ = call("GET", P)
check("facility", st == 200 and len(f.get("staff", [])) > 5, f"{f.get('name')} {len(f.get('staff', []))}名")
st, s, dt = call("POST", f"{P}/rosters/2026-11/solve", {"time_limit": 15})
check("solve 月次+日次", st == 200 and s.get("status") == "OPTIMAL" and s.get("unmet_total") == 0, f"{dt:.1f}s server={s.get('wall_ms')}ms iter={len(s.get('iterations', []))}")
st, v, _ = call("GET", f"{P}/rosters/2026-11/verify")
check("verify 破れ0", st == 200 and v.get("ok"), str(v.get("broken"))[:120])
st, d, dt = call("GET", f"{P}/daily/2026-11-12")
check("daily", st == 200 and d.get("status") == "OPTIMAL" and not d.get("unmet"), f"{dt:.2f}s server={d.get('wall_ms')}ms")
st, r, _ = call("GET", f"{P}/rosters/2026-11")
sid = next(k for k, row in r["current"].items() if row[11] == "日勤")
st, vac, dt = call("POST", f"{P}/vacancies", {"date": "2026-11-12", "shift": "日勤", "absent_staff_id": sid, "reason": "体調不良"})
check("欠員の登録と候補", st == 201 and vac.get("candidates"), f"{dt:.2f}s 候補{len(vac.get('candidates', []))}人 除外{len(vac.get('excluded', []))}人")
vid = vac["vacancy"]["vacancy_id"]
top = vac["candidates"][0]
st, o, _ = call("POST", f"{P}/vacancies/{vid}/offers", {"staff_id": top["staff_id"]})
check("打診", st == 201, o.get("offer_id", ""))
st, r2, _ = call("POST", f"{P}/vacancies/{vid}/offers/{o['offer_id']}/respond", {"status": "accepted"})
check("受諾→充足", st == 200 and r2["vacancy"]["state"] == "filled", r2.get("vacancy", {}).get("filled_by", ""))
st, v, _ = call("GET", f"{P}/rosters/2026-11/verify")
check("充足後に絶対のルールを破っていない", st == 200 and not [b for b in v["broken"] if b["strength"] == "絶対"])
st, rp, dt = call("POST", f"{P}/vacancies/{vid}/replan", {"apply": False})
check("組み直し案（適用しない）", st == 200 and rp.get("applied") is False, f"{dt:.1f}s status={rp.get('status')} changed={rp.get('changed_cells')}")
rule = {"id": "r-smoke", "type": "request", "label": "スモークテスト用", "strength": "できれば", "origin": {"kind": "手入力"},
        "people": {"ids": [sid]}, "days": {"dates": [20]}, "shifts": {"ids": ["夜勤"]}, "want": False}
st, _, _ = call("POST", f"{P}/rules", rule)
check("ルール追加", st in (201, 409))
st, _, _ = call("POST", f"{P}/rules/r-smoke/stop", {"reason": "スモークテスト終了"})
check("ルール停止", st == 200)
print("FAILED:" if fails else "ALL OK", fails or "")
sys.exit(1 if fails else 0)
