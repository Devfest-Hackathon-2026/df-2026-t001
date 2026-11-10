// 端末の案（時間の調整・打診）と、ソルバーの「この日だけの組み直し」（apireplan.ts）のどちらを出すかを決める。
// 比べるのは「変わる勤務（勤務区分のセル）の数」。
//   時間の調整（休憩をずらす・応援・退勤を延ばす）は勤務区分を変えないので 0 件。打診は、入る人の1件。
//   ソルバーの組み直しは、休みの人が入る1件か、入れ替えを含む2件以上。
// ソルバーの案が少なく、かつ画面の勤務間隔・翌日の確認（feCheck）を通るときだけ、ソルバーの案を承認待ちに出す。
// それ以外は端末の案のまま、確認結果だけを表示する（時間の調整のような、勤務区分で表せない変更はソルバーでは表せない）。
import type { Assignment, AutoState, Notice, ReplanVerdict, ShiftCode, Vacancy } from './types';
import type { State } from './store';
import { staffById } from './facility';
import { fmtMD } from './dates';
import { feCheck, verdictText } from './apireplan';

export const SOLVER_PLAN = 'solver';

export interface ReplanChoice { use: 'check' | 'plan'; text: string; kind: 'info' | 'ok' | 'warn' }

/** heurAdjust: 時間の調整案があるか / queue: 打診する順番 */
export function decideReplan(all: Assignment[], v: Vacancy, heurAdjust: boolean, queue: string[], r: ReplanVerdict): ReplanChoice {
  const head = verdictText(r);
  const heur = heurAdjust ? 0 : queue.length ? 1 : Infinity;
  if (!r.ok) return { use: 'check', text: head, kind: 'info' };
  const ng = feCheck(all, v.date, r.changes);
  const n = r.changes.length;
  if (heurAdjust) return { use: 'check', text: `${head}。時間の調整なら勤務の入れ替えは0件のため、時間の調整を提案します`, kind: 'info' };
  if (ng.length) return { use: 'check', text: `${head}。ただし画面の確認（${ng.join('、')}）を通らないため使いません`, kind: 'info' };
  if (n < heur) return { use: 'plan', text: `${head}。打診できる候補がいないため、この組み直しを承認待ちにします`, kind: 'warn' };
  const who = r.filledBy[0];
  const same = n === 1 && queue.includes(who);
  return { use: 'check', text: `${head}。${same ? `${staffById(who).name}さんは打診の候補に入っています。` : ''}変わる勤務は打診（1件）${n === 1 ? 'と同じ' : 'のほうが少ない'}ため、打診の順番はそのままにします`, kind: 'info' };
}

/** ソルバーの組み直しを勤務表に反映する。空いたユニットは、入れ替わった人へ順に渡す */
export function replanAssignments(all: Assignment[], v: Vacancy, changes: ReplanVerdict['changes'], mkId: () => string): { list: Assignment[]; ids: Record<string, string> } {
  const freed: Partial<Record<ShiftCode, string[]>> = { [v.shift]: [v.unitId] };
  const day = (sid: string) => all.find((a) => a.staffId === sid && a.date === v.date && a.status !== 'absent');
  let list = all.filter((a) => !(a.date === v.date && a.shift === v.shift && a.unitId === v.unitId && a.status === 'absent'));
  for (const c of changes) {
    const a = c.from ? day(c.staffId) : undefined;
    if (a && c.from) (freed[c.from] ??= []).push(a.unitId);
    if (a && !c.to) list = list.filter((x) => x.id !== a.id);
  }
  const ids: Record<string, string> = {};
  for (const c of changes) {
    if (!c.to) continue;
    const unitId = freed[c.to]?.shift() ?? staffById(c.staffId).homeUnit ?? v.unitId;
    const a = c.from ? day(c.staffId) : undefined;
    if (a) { list = list.map((x) => (x.id === a.id ? { ...x, shift: c.to as ShiftCode, unitId, source: 'ai' as const, note: '欠員の日の組み直し' } : x)); ids[c.staffId] = a.id; }
    else { const id = mkId(); list = [...list, { id, date: v.date, staffId: c.staffId, shift: c.to, unitId, status: 'assigned', source: 'ai', note: '欠員の日の組み直し' }]; ids[c.staffId] = id; }
  }
  return { list, ids };
}

interface Helpers {
  uid: (p: string) => string;
  logS: (s: State, id: string, text: string, kind?: AutoState['log'][number]['kind']) => State;
  autoS: (s: State, id: string, p: Partial<AutoState>) => State;
  patchV: (s: State, id: string, fn: (v: Vacancy) => Vacancy) => State;
  noticeS: (s: State, n: Omit<Notice, 'id' | 'at' | 'read'>) => State;
}
/** 承認されたソルバーの組み直しを反映した State（store.ts applySolverReplan から呼ぶ） */
export function applyReplanS(s: State, id: string, h: Helpers): Partial<State> {
  const v = s.vacancies.find((x) => x.id === id); const r = v?.auto?.replan;
  if (!v || !r?.ok || v.auto?.planId !== SOLVER_PLAN || v.state === 'filled') return {};
  const { list, ids } = replanAssignments(s.assignments, v, r.changes, () => h.uid('A'));
  const text = (c: ReplanVerdict['changes'][number]) => `${staffById(c.staffId).name}さん ${fmtMD(v.date)} ${c.from || '休み'}→${c.to || '休み'}`;
  let t = h.patchV({ ...s, assignments: list }, id, (x) => ({ ...x, state: 'filled', resolvedBy: 'adjust', filledBy: r.filledBy[0], resolution: { kind: 'adjust', at: s.now, title: 'この日だけの組み直し（ソルバー）', changes: r.changes.map((c) => ({ assignmentId: ids[c.staffId] ?? '', staffId: c.staffId, text: text(c) })) } }));
  t = h.logS(h.autoS(t, id, { mode: 'done', waitUntil: undefined, pendingStaff: undefined }), id, `リーダーがこの日だけの組み直しを承認しました。${r.changes.map(text).join('／')}`, 'ok');
  for (const c of r.changes) t = h.noticeS(t, { to: c.staffId, kind: 'shift', title: `${fmtMD(v.date)}の勤務が変わりました`, body: `${text(c)}。欠員への対応です。都合が悪い場合はリーダーに相談してください。`, link: 'shift' });
  return h.noticeS(t, { to: 'leader', kind: 'shift', title: `${id}：組み直しを反映しました`, body: r.changes.map(text).join('／'), link: 'vacancy' });
}
