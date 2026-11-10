// 「シフトを作る」を、Cloud Run の最適化ソルバー（OR-Tools CP-SAT、POST /api/v1/solve-inline）で組む。
// ソルバーは施設全体の「勤務帯ごとの人数」で解く（ユニットは知らない）。ユニットへの割り当ては assignUnits（所属優先・夜勤は各フロアに医療的ケア）。
// 失敗（接続不可・時間切れ・混雑・解なし）したときは呼び出し側が端末内の簡易計算（generateRoster）の案をそのまま使う。
// 職員の名前は送らない（staff_id と属性だけ）。
import type { Assignment, ShiftCode } from './types';
import { STAFF, SHIFT_ORDER, UNITS } from './facility';
import { assignUnits, canWork } from './roster';
import type { Availability } from './roster';
import { eventExtra } from './events';
import type { FacilityEvent } from './events';
import { addDays, daysInRange, dow } from './dates';
import { SOLVER } from '../leader/ai/api';

export interface SolverCtx { assignments: Assignment[]; dayOff: Record<string, string[]>; avail: Availability; events: FacilityEvent[]; nightMax?: number }
export interface SolveInlineRes { status: string; wall_ms: number; cells: Record<string, string[]>; soft_broken?: { rule_id: string; label: string; count: number }[]; explanation?: string[] }

const monthDays = (month: string) => { const [y, m] = month.split('-').map(Number); return daysInRange(`${month}-01`, `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`); };
const dayNums = (dates: string[] | undefined, month: string) => [...new Set((dates ?? []).filter((d) => d.startsWith(`${month}-`)).map((d) => +d.slice(8, 10)))].sort((a, b) => a - b);

/** ソルバーを使うか（VITE_USE_SOLVER=0 で無効。端末ごとに localStorage の care-no-solver=1 でも止められる） */
export function solverEnabled(): boolean {
  if ((import.meta.env?.VITE_USE_SOLVER as string | undefined) === '0') return false;
  try { if (localStorage.getItem('care-no-solver') === '1') return false; } catch { /* 読めなければ使う */ }
  return true;
}

export function toRequest(month: string, ctx: SolverCtx, timeLimit = 12) {
  const days = monthDays(month); const start = days[0];
  const staff = STAFF.filter((s) => s.shifts.length);
  const opt = <T,>(o: Record<string, T[]>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.length));
  const carry: Record<string, ShiftCode> = {};
  for (const a of ctx.assignments) if (a.date === addDays(start, -1) && a.status !== 'absent' && staff.some((s) => s.id === a.staffId)) carry[a.staffId] = a.shift;
  const extra: Record<string, Partial<Record<ShiftCode, number>>> = {};
  for (const d of days) { const ex = eventExtra(ctx.events, d); for (const k of SHIFT_ORDER) if (ex[k] > 0) (extra[d] ??= {})[k] = ex[k]; }
  return {
    month, days: days.length, first_weekday: dow(start),
    staff: staff.map((s) => ({ staff_id: s.id, role: s.role, employment: s.employment, years: s.years, skills: s.skills, shifts: s.shifts.filter((k) => canWork(s, k)), home_unit: s.homeUnit, leave_by: s.leaveBy ?? null, is_leader: !!s.isLeader })),
    need_per_shift: Object.fromEntries(SHIFT_ORDER.map((k) => [k, UNITS.length])),
    day_off: opt(Object.fromEntries(staff.map((s) => [s.id, dayNums(ctx.dayOff[s.id], month)]))),
    // 主任は土日に入れない（generateRoster と同じ）
    unavailable: opt(Object.fromEntries(staff.filter((s) => s.isLeader).map((s) => [s.id, days.filter((d) => dow(d) === 0 || dow(d) === 6).map((d) => +d.slice(8))]))),
    // 「入れる日」を出した人は、できれば補欠として残す（generateRoster も後回しにする）
    keep_free: opt(Object.fromEntries(staff.map((s) => [s.id, dayNums((ctx.avail[s.id] ?? []).map((x) => x.date), month)]))),
    carry_in: carry, extra, ...(ctx.nightMax ? { night_max: ctx.nightMax } : {}), time_limit: timeLimit,
  };
}

/** ソルバーの表（staff_id -> 日ごとの勤務）を、generateRoster と同じ形の Assignment[] にする */
export function fromResult(month: string, cells: Record<string, string[]>): Assignment[] {
  const days = monthDays(month); const out: Assignment[] = []; let n = 0;
  const put = (a: Omit<Assignment, 'id'>) => out.push({ ...a, id: `P-${String(++n).padStart(5, '0')}` });
  const known = new Set(STAFF.map((s) => s.id));
  days.forEach((d, i) => {
    const order: ShiftCode[] = ['夜勤', '早番', '日勤', '遅番'];
    const extras: Omit<Assignment, 'id'>[] = [];
    for (const sh of order) {
      const ids = Object.keys(cells).filter((sid) => known.has(sid) && cells[sid][i] === sh);
      for (const x of assignUnits(ids, sh)) {
        const a: Omit<Assignment, 'id'> = { date: d, staffId: x.staffId, shift: sh, unitId: x.unitId, status: 'assigned', source: 'base' };
        if (x.extra) extras.push({ ...a, note: '行事対応の追加配置' }); else put(a);
      }
    }
    extras.forEach(put);
  });
  return out;
}

export async function solveMonth(month: string, ctx: SolverCtx, signal: AbortSignal): Promise<{ draft: Assignment[]; res: SolveInlineRes }> {
  const r = await fetch(`${SOLVER}/api/v1/solve-inline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toRequest(month, ctx)), signal });
  if (!r.ok) throw new Error(`solve-inline ${r.status}`);
  const res = (await r.json()) as SolveInlineRes;
  if ((res.status !== 'OPTIMAL' && res.status !== 'FEASIBLE') || !res.cells || !Object.keys(res.cells).length) throw new Error(`solve-inline ${res.status}`);
  const n = monthDays(month).length;
  if (Object.values(res.cells).some((row) => !Array.isArray(row) || row.length !== n)) throw new Error('solve-inline: 日数が合いません');
  return { draft: fromResult(month, res.cells), res };
}

/** シフト案の「メモ」に出す1行（ソルバーで作ったこと・かかった時間・夜勤回数のそろい方） */
export function solverNote(draft: Assignment[], res: SolveInlineRes): string[] {
  const nights = STAFF.filter((s) => canWork(s, '夜勤')).map((s) => draft.filter((a) => a.staffId === s.id && a.shift === '夜勤').length);
  const sec = (res.wall_ms / 1000).toFixed(1);
  const broken = (res.soft_broken ?? []).filter((b) => b.count > 0);
  return [
    `最適化ソルバー（CP-SAT）で1か月分を一度に作成：${sec}秒（${res.status === 'OPTIMAL' ? '最適解' : '時間内の最良解'}）`,
    ...(nights.length ? [`夜勤の回数：1人あたり${Math.min(...nights)}〜${Math.max(...nights)}回（夜勤に入れる${nights.length}名でそろえました）`] : []),
    ...(broken.length ? [`守りきれなかった目安：${broken.slice(0, 3).map((b) => `${b.label}（${b.count}件）`).join('、')}`] : []),
  ];
}
