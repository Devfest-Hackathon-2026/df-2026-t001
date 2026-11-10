// デモシナリオ(d02-d05)の headless 確認。
// 実行: npx esbuild scripts/check/demo-a.ts --bundle --platform=node --format=esm --outfile=/tmp/demo-a.mjs && node /tmp/demo-a.mjs
import * as S from '../../src/core/store';
import { MY_ID, staffById } from '../../src/core/facility';
import { adjustChecks } from '../../src/leader/Delegate';
import { proposeAdjustments } from '../../src/core/roster';
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const st = () => S.getState();
const nm = (id: string) => staffById(id).name;

// d02: 美咲が 11/20 の夜勤を「休み」(子ども関連)
const mine = st().assignments.find((a) => a.staffId === MY_ID && a.date === '2026-11-20');
console.log('MY 11/20:', mine?.shift, mine?.status);
S.submitRequest(MY_ID, '2026-11-20', '休み', '子ども関連', undefined, 'ai');
const rq = st().requests[0];
ok(!!st().notices.find((n) => n.to === 'leader' && n.kind === 'request' && n.title.includes('休み')), 'd02 要対応(leader notice kind=request)が出る');
// d03: 承認して任せる
S.decideRequest(rq.id, true, true);
const v = st().vacancies.find((x) => x.date === '2026-11-20' && x.shift === '夜勤' && x.fromAssignmentId);
console.log('vac', v?.id, 'mode', v?.auto?.mode, 'queue', v?.auto?.queue.map(nm).join('>'));
ok(!!st().notices.find((n) => n.to === 'leader' && n.link === `autopilot:${v!.id}`), 'd03 autopilot:<id> の通知がある');
// d04: 1人目は無返信 → 期限で次 → 加藤が入れる
console.log('demoPlan', S.demoPlan(st().vacancies.find((x) => x.id === v!.id)!));
console.log('pending now', st().vacancies.find((x) => x.id === v!.id)!.offers.map((o) => `${nm(o.staffId)}:${o.status}`).join(','));
S.advanceClock(200);
let v2 = st().vacancies.find((x) => x.id === v!.id)!;
console.log('after expiry', v2.offers.map((o) => `${nm(o.staffId)}:${o.status}`).join(','));
const pend = v2.offers.find((o) => o.status === 'pending')!;
ok(!!pend && nm(pend.staffId).includes('加藤'), `d04 返信する候補が加藤: ${pend ? nm(pend.staffId) : 'none'}`);
S.askShiftMaker(pend.staffId, 'はい、入れます');
v2 = st().vacancies.find((x) => x.id === v!.id)!;
ok(v2.state === 'filled' && v2.filledBy === pend.staffId, '3 自由記述「入れます」で respondOffer(true) -> 充足');
ok(!st().messages.some((m) => m.thread === `ai:${pend.staffId}` && m.proposal), '3 proposeFromText へ渡していない(proposalなし)');
const n = st().notices.find((x) => x.to === MY_ID && x.title === '代わりが決まりました');
ok(!!n, `2 欠勤者(美咲)へ通知: ${n?.body}`);

// d05: 別の日(11/22 遅番)。野口の退勤+30分で解消、承認待ちになる
S.resetDemo();
const d5 = st().vacancies.find((x) => x.id === 'VAC-20261122-L04')!;
S.startAutopilot(d5.id, { max: 5 });
const d5b = st().vacancies.find((x) => x.id === d5.id)!;
ok(d5b.auto?.mode === 'waiting_adjust', 'd05 mode=waiting_adjust: ' + d5b.auto?.planId);
const pl = proposeAdjustments(st().assignments, d5b).find((p) => p.id === d5b.auto!.planId)!;
console.log('plan:', pl.title, '|', pl.changes.map((c) => c.text).join('/'), '|', pl.caution);
ok(pl.changes.length === 1 && pl.changes[0].text.includes('野口') && pl.changes[0].text.includes('30分'), 'd05 野口 +30分');
console.log('checks:', adjustChecks(st().assignments, pl));
S.applyAdjustment(d5.id, pl.id);
ok(st().vacancies.find((x) => x.id === d5.id)!.state === 'filled', 'd05 承認で充足');

// 5: 求人の自動掲載(11/25 夜勤: 候補1人→辞退→求人)
S.resetDemo();
const j = st().vacancies.find((x) => x.id === 'VAC-20261125-N01')!;
S.startAutopilot(j.id);
let jv = st().vacancies.find((x) => x.id === j.id)!;
const who = jv.offers.find((o) => o.status === 'pending')!.staffId;
S.respondOffer(j.id, who, false);
jv = st().vacancies.find((x) => x.id === j.id)!;
ok(jv.auto?.mode === 'posted' && jv.state === 'posted' && jv.jobPost?.status === 'posted' && !!jv.jobPost.text, '5 autoPost ON: 自動で掲載済み');
ok(st().notices.some((n) => n.to === 'leader' && n.title.includes('求人を自動で掲載')), '5 leader へ通知');
S.rejectJobPost(j.id);
jv = st().vacancies.find((x) => x.id === j.id)!;
ok(jv.auto?.mode === 'manual' && jv.state === 'open' && !jv.jobPost, '5 取り消し可能');
// 手動承認パス
S.resetDemo();
S.updateAutopilot({ autoPost: false });
S.startAutopilot(j.id);
const w2 = st().vacancies.find((x) => x.id === j.id)!.offers.find((o) => o.status === 'pending')!.staffId;
S.respondOffer(j.id, w2, false);
jv = st().vacancies.find((x) => x.id === j.id)!;
ok(jv.auto?.mode === 'waiting_post' && jv.state === 'open', '5 autoPost OFF: waiting_post(手動承認)');
S.approveJobPost(j.id, jv.jobPost!.text!, jv.jobPost!.reward);
ok(st().vacancies.find((x) => x.id === j.id)!.state === 'posted', '5 手動承認で掲載');

// 3 辞退の自由記述
S.resetDemo();
S.startAutopilot(j.id);
const w3 = st().vacancies.find((x) => x.id === j.id)!.offers.find((o) => o.status === 'pending')!.staffId;
S.askShiftMaker(w3, '今回は難しいです');
ok(st().vacancies.find((x) => x.id === j.id)!.offers.find((o) => o.staffId === w3)!.status === 'declined', '3 自由記述「難しい」で declined');
process.exit(fails ? 1 : 0);
