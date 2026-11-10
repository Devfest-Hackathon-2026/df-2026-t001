// 欠員の日だけを、最適化ソルバー（care-solver-api の POST /api/v1/replan-inline, OR-Tools CP-SAT）で組み直して確かめる。
// ほかの日はすべて今の勤務に固定し、その日の勤務だけを「変わる勤務が最小」になるように解き直す。
// 画面の判定（時間の調整案・打診してよい人）はここでは変えない。結果は「ソルバーで確認」として表示し、
// 端末の案より変わる勤務が少なく、画面の勤務間隔・翌日の確認も通るときだけ、そちらを案として出す（store.ts approveAutopilot）。
// 失敗・遅い（6秒）・形が違う・止めてある（VITE_AI_REPLAN=off / localStorage care-no-replan=1）ときは null を返し、従来どおり進む。投げない。
// 送るのは職員ID・属性と勤務表だけ（氏名は送らない）。
import type { Assignment, ReplanVerdict, ShiftCode, Vacancy } from './types';
import type { State } from './store';
import { SHIFTS, STAFF, staffById } from './facility';
import { addDays, daysInRange } from './dates';
import { canWork } from './roster';
import { toRequest } from './solverPlan';
import { SOLVER } from '../leader/ai/api';

export type { ReplanVerdict };
const TIMEOUT_MS = 6000;
const CODES = new Set<string>(['早番', '日勤', '遅番', '夜勤', '']);

export function replanEnabled(): boolean {
  try { if ((import.meta.env.VITE_AI_REPLAN as string | undefined) === 'off') return false; } catch { /* env が無い環境（node の確認など） */ }
  try { if (localStorage.getItem('care-no-replan') === '1') return false; } catch { /* 読めなくても既定はオン */ }
  return typeof fetch === 'function' && typeof AbortController === 'function';
}

const monthDays = (month: string) => { const [y, m] = month.split('-').map(Number); return daysInRange(`${month}-01`, `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`); };
const absentOf = (s: State, v: Vacancy) => s.assignments.find((a) => a.id === v.fromAssignmentId && a.status === 'absent')?.staffId;

/** API に送る本文（solve-inline と同じ職員・ルール + 今の勤務表 + 欠員）。氏名なし */
export function replanRequest(s: State, v: Vacancy) {
  const month = v.date.slice(0, 7);
  const dayOff = s.collection.month === month ? Object.fromEntries(Object.entries(s.collection.submitted).filter(([, x]) => x).map(([k, x]) => [k, x!.dates])) : {};
  const base = toRequest(month, { assignments: s.assignments, dayOff, avail: s.availability, events: s.events }, 5);
  const days = monthDays(month);
  const ids = new Set(base.staff.map((x) => x.staff_id));
  const cells: Record<string, string[]> = {};
  for (const id of ids) cells[id] = days.map(() => '');
  for (const a of s.assignments) {
    if (a.status === 'absent' || !ids.has(a.staffId) || a.date.slice(0, 7) !== month) continue;
    const i = +a.date.slice(8, 10) - 1;
    if (!cells[a.staffId][i]) cells[a.staffId][i] = a.shift;
  }
  const absent = absentOf(s, v);
  return { ...base, cells, date: +v.date.slice(8, 10), vacancy: { shift: v.shift, ...(absent && ids.has(absent) ? { absent_staff_id: absent } : {}) }, fixed_other_days: true as const };
}

/** 応答の形を厳しく確かめる。合わなければ null */
export function parseReplan(j: unknown, v: Vacancy, cells: Record<string, string[]>): ReplanVerdict | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const status = o.status; const wall = o.wall_ms;
  if (typeof status !== 'string' || typeof wall !== 'number' || !Number.isFinite(wall) || wall < 0) return null;
  if (!Array.isArray(o.changes) || !Array.isArray(o.filled_by)) return null;
  const known = new Set(STAFF.map((x) => x.id)); const i = +v.date.slice(8, 10) - 1;
  const changes: ReplanVerdict['changes'] = [];
  for (const c of o.changes) {
    if (!c || typeof c !== 'object') return null;
    const { staff_id: id, from, to } = c as { staff_id?: unknown; from?: unknown; to?: unknown };
    if (typeof id !== 'string' || !known.has(id) || typeof from !== 'string' || typeof to !== 'string' || !CODES.has(from) || !CODES.has(to) || from === to) return null;
    if ((cells[id]?.[i] ?? '') !== from || changes.some((x) => x.staffId === id)) return null;   // 今の表と食い違う答えは使わない
    changes.push({ staffId: id, from: from as ShiftCode | '', to: to as ShiftCode | '' });
  }
  const filledBy = o.filled_by.filter((x): x is string => typeof x === 'string');
  if (filledBy.length !== o.filled_by.length || filledBy.some((x) => !changes.some((c) => c.staffId === x && c.to === v.shift))) return null;
  const ok = status === 'OPTIMAL' || status === 'FEASIBLE';
  if (ok && !filledBy.length) return null;
  if (!ok && changes.length) return null;
  const relax = Array.isArray(o.relaxation) ? o.relaxation.flatMap((x) => (x && typeof x === 'object' && typeof (x as { label?: unknown }).label === 'string' ? [(x as { label: string }).label] : [])).slice(0, 3) : [];
  return { status, ok, wallMs: Math.round(wall), minimal: o.minimal === true, changes, filledBy, relax, at: v.date };
}

/** 1回だけ呼ぶ（再試行なし・6秒で打ち切り）。エラー・タイムアウト・429・5xx・形の違いはすべて null。投げない */
export async function replanViaApi(s: State, v: Vacancy): Promise<ReplanVerdict | null> {
  try {
    if (!replanEnabled() || v.kind === 'gap') return null;
    const body = replanRequest(s, v);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${SOLVER}/api/v1/replan-inline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) return null;
      return parseReplan(await r.json(), v, body.cells);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 画面の勤務間隔・翌日の確認（roster.ts の laborBlock と同じ基準）を、ソルバーの変更ごとに通す。通らなければ理由を返す */
export function feCheck(all: Assignment[], date: string, changes: ReplanVerdict['changes']): string[] {
  const ng: string[] = [];
  for (const c of changes) {
    if (!c.to) continue;
    const st = staffById(c.staffId); const nm = st.name;
    if (!canWork(st, c.to)) { ng.push(`${nm}さん：${c.to}に入れない`); continue; }
    const mine = all.filter((a) => a.staffId === c.staffId && a.status !== 'absent' && a.date !== date);
    const has = (d: string) => mine.some((a) => a.date === d) || mine.some((a) => a.shift === '夜勤' && addDays(a.date, 1) === d);
    let before = 0; for (let i = 1; i <= 6; i++) { if (has(addDays(date, -i))) before++; else break; }
    let after = 0; for (let i = 1; i <= 6; i++) { if (has(addDays(date, i))) after++; else break; }
    if (c.to === '夜勤' && mine.some((a) => a.date === addDays(date, 1))) { ng.push(`${nm}さん：夜勤明けの日に勤務がある`); continue; }
    if (before + after + 1 + (c.to === '夜勤' && !has(addDays(date, 1)) ? 1 : 0) > 5) { ng.push(`${nm}さん：連勤が5日を超える`); continue; }
    const prev = mine.find((a) => a.date === addDays(date, -1));
    if (prev?.shift === '夜勤') { ng.push(`${nm}さん：夜勤明けの日になる`); continue; }
    if (prev) { const gap = (1440 + SHIFTS[c.to].start - SHIFTS[prev.shift].end) / 60; if (gap < 11) { ng.push(`${nm}さん：前日${prev.shift}との間隔が${gap}時間`); continue; } }
    const next = mine.find((a) => a.date === addDays(date, 1));
    if (next && c.to !== '夜勤') { const gap = (1440 + SHIFTS[next.shift].start - SHIFTS[c.to].end) / 60; if (gap < 11) { ng.push(`${nm}さん：翌日${next.shift}との間隔が${gap}時間`); continue; } }
  }
  return ng;
}

const cellText = (c: ReplanVerdict['changes'][number]) => `${staffById(c.staffId).name}さん ${c.from || '休み'}→${c.to || '休み'}`;

/** 承認カード・ログに出す1行 */
export function verdictText(r: ReplanVerdict): string {
  const sec = (r.wallMs / 1000).toFixed(1);
  if (!r.ok) return `ソルバーで確認（${sec}秒）：この日だけの組み直しでは、今のルールのまま埋める方法がありません${r.relax.length ? `（埋めるには「${r.relax.join('」「')}」を破る必要があります）` : ''}`;
  return `ソルバーで確認（${sec}秒）：この日だけの組み直しで変更 ${r.changes.length} 件${r.minimal ? '（最小）' : '（時間内の最良）'}：${r.changes.map(cellText).join('／')}`;
}
