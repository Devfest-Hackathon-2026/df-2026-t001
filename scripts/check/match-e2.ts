// 「代わりに入れる人は、ソルバーの必須ルールを破らない候補に限る」の headless 確認（デモの欠員で、候補が誤って外れないこと）。
// 実の経路: store.delegateAutopilot → apirank.rankViaApi（cells つき）→ ローカルの care-solver-api → inline_verify → 打診の列。
// 実行（solver-api をローカルで起動しておく: cd solver-api && .venv/bin/uvicorn care.server:app --port 8137）:
//   npx esbuild scripts/check/match-e2.ts --bundle --platform=node --format=esm --outfile=/tmp/match-e2.mjs \
//     --define:import.meta.env='{"VITE_SOLVER_URL":"http://127.0.0.1:8137"}' && node /tmp/match-e2.mjs
import * as S from '../../src/core/store';
import { MY_ID, STAFF, staffById } from '../../src/core/facility';
import { rankRequest } from '../../src/core/apirank';
import { rankCandidates } from '../../src/core/roster';
import { monthStats } from '../../src/core/labor';
import { addDays } from '../../src/core/dates';
import type { Assignment, Vacancy } from '../../src/core/types';

import { SOLVER as API } from '../../src/leader/ai/api';   // --define の VITE_SOLVER_URL（store と同じ宛先）
if (!API.startsWith('http://127.0.0.1')) { console.log(`FAIL  ローカルの API を指定してください (${API})`); process.exit(2); }
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const st = () => S.getState();
const nm = (id: string) => staffById(id).name;
const vac = (id: string) => st().vacancies.find((x) => x.id === id)!;
const wait = async (id: string) => { for (let i = 0; i < 100 && S.isDelegating(id); i++) await new Promise((r) => setTimeout(r, 50)); };

/** 画面の判定で打診してよい人 と、API が必須ルールで外した人を突き合わせる */
async function crossCheck(v: Vacancy, label: string) {
  const s = st();
  const feOk = rankCandidates(s.assignments, v).filter((c) => !c.blocked && !c.unfit).map((c) => c.staff.id);
  const t0 = Date.now();
  const r = await fetch(`${API}/api/v1/rank-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rankRequest(s, v)) });
  const ms = Date.now() - t0;
  ok(r.ok, `${label}: API 200 (${r.status}, ${ms}ms)`);
  const j = await r.json() as { candidates: { staff_id: string }[]; excluded: { staff_id: string; reason: string; rule_id?: string }[] };
  const hard = j.excluded.filter((e) => e.rule_id);
  console.log(`  ${label}: 画面OK=${feOk.map(nm).join('・') || '-'} / API候補=${j.candidates.map((c) => nm(c.staff_id)).join('・') || '-'}`);
  console.log(`  ${label}: 必須ルールで除外=${hard.map((e) => `${nm(e.staff_id)}(${e.rule_id})`).join('・') || 'なし'}（画面で既に外れている人を含む）`);
  // 画面の判定（rankCandidates）では打診できるのに API が外した人は、理由が説明できること:
  //  ・連勤／公休: 引き受けると画面の労務チェック（labor.ts monthStats）に新しい警告が出る（= labor.ts の数え方と一致）
  //  ・夜勤明け: 夜勤の翌日に夜勤（画面の rankCandidates は許すが、ソルバーの「夜勤のあとは翌日を休み」は禁止）
  for (const e of hard.filter((x) => feOk.includes(x.staff_id))) {
    const add: Assignment = { id: 'X', date: v.date, staffId: e.staff_id, shift: v.shift, unitId: v.unitId, status: 'assigned', source: 'base' };
    const w = (list: Assignment[]) => monthStats(list, `${v.date.slice(0, 7)}-01`).find((x) => x.staffId === e.staff_id)?.warnings.map((x) => x.text) ?? [];
    const before = w(s.assignments); const after = w([...s.assignments, add]).filter((t) => !before.includes(t));
    const nightNight = v.shift === '夜勤' && s.assignments.some((a) => a.staffId === e.staff_id && a.status !== 'absent' && a.date === addDays(v.date, 1) && a.shift === '夜勤');
    const why = e.rule_id === 'r-ake' && nightNight ? '翌日も夜勤（夜勤明けに勤務）' : (e.rule_id === 'r-run' || e.rule_id === 'app-min-off') && after.length ? `labor.ts も警告: ${after.join('／')}` : '';
    ok(!!why, `${label}: 画面では打診可だが API が除外 → ${nm(e.staff_id)}（${e.reason}）: ${why || '説明できない不一致'}`);
  }
  return { feOk, hard, ms };
}

const health = await fetch(`${API}/api/healthz`).then((r) => r.ok).catch(() => false);
if (!health) { console.log(`FAIL  solver-api が ${API} で起動していません`); process.exit(2); }

// 参考: API なし（画面の判定だけ）の打診の列
for (const id of ['VAC-20261122-L04', 'VAC-20261125-N01']) {
  S.resetDemo(); S.startAutopilot(id, id.endsWith('L04') ? { max: 5 } : {});
  console.log(`  baseline(APIなし) ${id}: ${(vac(id).auto?.queue ?? []).map(nm).join(' > ')}`);
}
S.resetDemo();

// d02-d04: 美咲（MY_ID）が 11/20 夜勤を休み → 承認して任せる → 後藤（無返信）→ 加藤が受諾
S.submitRequest(MY_ID, '2026-11-20', '休み', '子ども関連', undefined, 'ai');
const rq = st().requests[0];
S.decideRequest(rq.id, true, true);
const v = st().vacancies.find((x) => x.date === '2026-11-20' && x.shift === '夜勤' && x.fromAssignmentId)!;
await wait(v.id);
const c20 = await crossCheck(v, '11/20 夜勤');
ok(!c20.hard.some((e) => c20.feOk.includes(e.staff_id)), '11/20 夜勤: 画面で打診できる人は1人も外れない');
const q = vac(v.id).auto?.queue ?? [];
console.log('  queue:', q.map(nm).join(' > '));
ok(q.some((id) => nm(id).includes('後藤')) && q.some((id) => nm(id).includes('加藤')), '11/20 夜勤: 後藤 リナ と 加藤 誠 が打診の列に残る');
ok(!(vac(v.id).auto?.log ?? []).some((l) => l.text.includes('必須ルール')), '11/20 夜勤: 必須ルールによる除外のログなし');
S.advanceClock(200);
const pend = vac(v.id).offers.find((o) => o.status === 'pending');
ok(!!pend && nm(pend.staffId).includes('加藤'), `11/20 夜勤: 期限切れの次は加藤に打診 (${pend ? nm(pend.staffId) : 'none'})`);
if (pend) S.askShiftMaker(pend.staffId, 'はい、入れます');
ok(vac(v.id).state === 'filled', '11/20 夜勤: 加藤の受諾で充足');

// d05: 11/22 遅番
S.resetDemo();
const d5 = 'VAC-20261122-L04';
const c5 = await crossCheck(vac(d5), '11/22 遅番');
ok(!c5.hard.some((e) => c5.feOk.includes(e.staff_id)), '11/22 遅番: 画面で打診できる人は1人も外れない');
await S.delegateAutopilot(d5, { max: 5 }, true);
console.log('  queue:', (vac(d5).auto?.queue ?? []).map(nm).join(' > '), 'mode', vac(d5).auto?.mode);
ok(vac(d5).auto?.mode === 'waiting_adjust' && (vac(d5).auto?.queue.length ?? 0) > 0, '11/22 遅番: 時間調整の承認待ち・候補あり');

// 11/25 夜勤: 候補1人 → 辞退 → 求人
S.resetDemo();
const j = 'VAC-20261125-N01';
await crossCheck(vac(j), '11/25 夜勤');
await S.delegateAutopilot(j, {}, true);
const jq = vac(j).auto?.queue ?? [];
console.log('  queue:', jq.map(nm).join(' > '));
console.log('  log:', (vac(j).auto?.log ?? []).filter((l) => l.text.includes('必須ルール')).map((l) => l.text).join(' | '));
ok(jq.length === 1, '11/25 夜勤: 動画どおり内部の候補は1人（maxCandidates=1）');
const w = vac(j).offers.find((o) => o.status === 'pending')?.staffId;
ok(!!w, `11/25 夜勤: 候補に打診中 (${w ? nm(w) : 'none'})`);
if (w) S.respondOffer(j, w, false);
ok(vac(j).state === 'posted' || vac(j).auto?.mode === 'waiting_post', '11/25 夜勤: 辞退のあと求人へ進む');

// 全員が除外されたとき: 空の列でも止まらず求人へ進む（API の応答を模した hard を渡す）
S.resetDemo();
const all = STAFF.map((x) => ({ staffId: x.id, reason: '夜勤のあとは翌日を休みにする（デモ用の仮値）', ruleId: 'r-ake' }));
S.startAutopilot(j, { ai: { order: [], prob: {}, hard: all } });
const e = vac(j);
console.log('  log:', e.auto?.log.map((l) => l.text).filter((t) => t.includes('必須ルール') || t.includes('求人')).join(' | ').slice(0, 300));
ok((e.auto?.queue.length ?? -1) === 0 && (e.state === 'posted' || e.auto?.mode === 'waiting_post'), '全員除外: 列は空・求人へ進む');
ok(!!e.auto?.log.some((l) => l.text.startsWith('ソルバーの必須ルールを破るため除外: ') && l.text.includes('さん（夜勤のあとは翌日を休みにする）')), '全員除外: ログに1行');

process.exit(fails ? 1 : 0);
