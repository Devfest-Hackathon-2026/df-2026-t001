// 欠員の日だけの組み直し（POST /api/v1/replan-inline）を、画面の store を headless で動かして確かめる。
// ローカルの API を立ててから:
//   (cd solver-api && .venv/bin/python -m uvicorn care.server:app --port 8765)
//   npx esbuild scripts/check/replan-e3.ts --bundle --platform=node --format=esm \
//     '--define:import.meta.env={"VITE_SOLVER_URL":"http://127.0.0.1:8765"}' --outfile=/tmp/replan-e3.mjs && node /tmp/replan-e3.mjs
// API を止めた状態（接続できない）でも、従来どおりに動くことを確かめる: VITE_SOLVER_URL を http://127.0.0.1:9 にして同じ手順。
import * as S from '../../src/core/store';
import { MY_ID, staffById } from '../../src/core/facility';
import { proposeAdjustments } from '../../src/core/roster';
import { replanRequest, replanViaApi, verdictText } from '../../src/core/apireplan';
import { SOLVER } from '../../src/leader/ai/api';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const st = () => S.getState();
const nm = (id: string) => staffById(id).name;
const vac = (id: string) => st().vacancies.find((x) => x.id === id)!;
const until = async (f: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return f(); };

const live = await fetch(`${SOLVER}/api/healthz`).then((r) => r.ok).catch(() => false);
console.log(`API ${SOLVER}: ${live ? '接続できる' : '接続できない（従来どおりの動きを確かめる）'}`);

// ---- 11/22 遅番（d05）: 野口の退勤 18:00→18:30 が提案され、承認できる。ソルバーの確認結果が添えられる
S.resetDemo();
const d5 = vac('VAC-20261122-L04');
if (live) {
  const t0 = Date.now(); const r = await replanViaApi(st(), d5); const ms = Date.now() - t0;
  const body = replanRequest(st(), d5);
  console.log(`  request: staff ${body.staff.length}名 / date ${body.date} / vacancy ${JSON.stringify(body.vacancy)} / 往復 ${ms}ms`);
  ok(!!r && r.ok && r.changes.length >= 1 && r.filledBy.length === 1, `11/22 replan-inline が答える: ${r ? verdictText(r) : 'null'}`);
}
const t5 = Date.now();
await S.delegateAutopilot(d5.id, { max: 5 }, true);
console.log(`  delegateAutopilot（11/22）: ${Date.now() - t5}ms`);
const d5b = vac(d5.id);
ok(d5b.auto?.mode === 'waiting_adjust' && d5b.auto.planId !== 'solver', `d05 mode=waiting_adjust（画面の時間調整案）: ${d5b.auto?.planId}`);
const pl = proposeAdjustments(st().assignments, d5b).find((p) => p.id === d5b.auto!.planId)!;
console.log('  plan:', pl.title, '|', pl.changes.map((c) => c.text).join('/'));
ok(pl.changes.length === 1 && pl.changes[0].text.includes('野口') && pl.changes[0].text.includes('18:30'), 'd05 野口 退勤 18:00→18:30');
if (live) {
  ok(!!d5b.auto?.replan && d5b.auto.replanUse === 'check', `d05 ソルバーの確認結果が承認カードに出る（replanUse=${d5b.auto?.replanUse}）`);
  console.log('  log:', d5b.auto?.log.find((l) => l.text.startsWith('ソルバーで確認'))?.text);
} else ok(!d5b.auto?.replan, 'd05 API なし: 確認結果なし（従来どおり）');
S.applyAdjustment(d5.id, pl.id);
ok(vac(d5.id).state === 'filled' && vac(d5.id).resolvedBy === 'adjust', 'd05 承認で充足');

// ---- 11/20 夜勤（d02-d04）: 承認して任せる → 後藤（無返信）→ 加藤が入れる
S.resetDemo();
S.submitRequest(MY_ID, '2026-11-20', '休み', '子ども関連', undefined, 'ai');
const rq = st().requests[0];
S.decideRequest(rq.id, true, true);
const v = st().vacancies.find((x) => x.date === '2026-11-20' && x.shift === '夜勤' && x.fromAssignmentId)!;
await until(() => !S.isDelegating(v.id) && vac(v.id).auto?.mode !== 'ask');
const v1 = vac(v.id);
console.log('  queue:', v1.auto?.queue.map(nm).join(' > '), '| mode', v1.auto?.mode);
ok(v1.auto?.mode === 'running', `d03 打診へ進む（mode=${v1.auto?.mode}）`);
ok(nm(v1.auto!.queue[0]).includes('後藤') && nm(v1.auto!.queue[1]).includes('加藤'), 'd03 打診の順番は 後藤 → 加藤（変わらない）');
if (live) { ok(v1.auto?.replanUse === 'check', `d03 ソルバーは確認だけ（replanUse=${v1.auto?.replanUse}）`); console.log('  log:', v1.auto?.log.find((l) => l.text.startsWith('ソルバーで確認'))?.text); }
S.advanceClock(200);
const pend = vac(v.id).offers.find((o) => o.status === 'pending');
ok(!!pend && nm(pend.staffId).includes('加藤'), `d04 返信する候補が加藤: ${pend ? nm(pend.staffId) : 'none'}`);
if (pend) S.askShiftMaker(pend.staffId, 'はい、入れます');
ok(vac(v.id).state === 'filled' && vac(v.id).filledBy === pend?.staffId, 'd04 加藤が入って充足');

// ---- 打診できる候補がいないとき: ソルバーの組み直しを承認待ちにし、承認で反映する（その日だけが変わる）
if (live) {
  S.resetDemo();
  const j = vac('VAC-20261125-N01');
  S.setVacancyOpts(j.id, { maxCandidates: 0, useAdjust: false });
  const before = st().assignments.filter((a) => a.date !== j.date).map((a) => `${a.id}:${a.staffId}:${a.date}:${a.shift}:${a.status}`).sort().join('|');
  await S.delegateAutopilot(j.id, {}, true);
  const j1 = vac(j.id);
  ok(j1.auto?.mode === 'waiting_adjust' && j1.auto.planId === 'solver' && j1.auto.replanUse === 'plan', `候補なし → ソルバーの組み直しを承認待ち: ${j1.auto?.replan ? verdictText(j1.auto.replan) : '-'}`);
  S.applySolverReplan(j.id);
  const j2 = vac(j.id);
  const after = st().assignments.filter((a) => a.date !== j.date).map((a) => `${a.id}:${a.staffId}:${a.date}:${a.shift}:${a.status}`).sort().join('|');
  ok(j2.state === 'filled' && j2.auto?.mode === 'done', '承認で充足');
  ok(before === after, 'その日以外の勤務は1つも変わらない');
  const day = st().assignments.filter((a) => a.date === j.date && a.shift === '夜勤' && a.status !== 'absent');
  ok(day.length === 4 && new Set(day.map((a) => a.unitId)).size === 4, `11/25 夜勤は4ユニットに1人ずつ: ${day.map((a) => `${nm(a.staffId)}(${a.unitId})`).join('、')}`);
}
console.log(fails ? `\n${fails} 件 FAIL` : '\nすべて PASS');
process.exit(fails ? 1 : 0);
