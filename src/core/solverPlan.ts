// 「シフトを作る」を、Cloud Run の最適化ソルバー（POST /api/v1/solve-inline）で組む。
// ソルバーは施設全体の「勤務帯ごとの人数」で解く（ユニットは知らない）。ユニットへの割り当ては assignUnits（所属優先・夜勤は各フロアに医療的ケア）。
// 失敗（接続不可・時間切れ・混雑・解なし）したときは呼び出し側が端末内の簡易計算（generateRoster）の案をそのまま使う。
// 職員の名前は送らない（staff_id と属性だけ）。
import type { Assignment, ShiftCode } from './types';
import { STAFF, SHIFT_ORDER, UNITS, type ShiftTypeDef } from './facility';
import { assignUnits, canWork } from './roster';
import type { Availability } from './roster';
import { eventExtra } from './events';
import type { FacilityEvent } from './events';
import { addDays, daysInRange, dow } from './dates';
import { SOLVER } from '../leader/ai/api';

export interface SolverCtx {
  assignments: Assignment[];
  dayOff: Record<string, string[]>;
  avail: Availability;
  events: FacilityEvent[];
  nightMax?: number;
  fixed?: Record<string, Record<string, ShiftCode | '休'>>;
  shiftWish?: Record<string, Record<string, ShiftCode | '勤務'>>;
  shiftTypes?: ShiftTypeDef[];
  /** チャットで足したルール（InlineSolveIn.rules の形。止めたものは含めない） */
  rules?: Record<string, unknown>[];
  /** 前の表（職員ID → 日ごとの勤務）。渡すと、最適な表のうち前の表に一番近いものを返す */
  baseline?: Record<string, string[]>;
}
export interface ChangedCell { staff_id: string; day: number; before: string; after: string }
export interface SolveInlineRes { status: string; wall_ms: number; app_labor_rules?: boolean; cells: Record<string, string[]>; soft_broken?: { rule_id: string; label: string; count: number }[]; explanation?: string[]; changed?: { count: number; cells: ChangedCell[] } }

export class SolverRejectedError extends Error {
  userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

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
  const known = new Set(staff.map((s) => s.id));
  const opt = <T,>(o: Record<string, T[]>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.length));

  // 前月の最後の7日（古い順）を history にまとめる
  const prevDays = daysInRange(addDays(start, -7), addDays(start, -1));
  const history: Record<string, string[]> = {};
  for (const s of staff) {
    const seq = prevDays.map((d) => {
      const hit = ctx.assignments.find((a) => a.staffId === s.id && a.date === d && a.status !== 'absent');
      return hit ? hit.shift : '';
    });
    if (seq.some((v) => v !== '')) history[s.id] = seq;
  }

  const mapByDay = <T extends string>(src: Record<string, Record<string, T>> | undefined): Record<string, Record<number, T>> => {
    const out: Record<string, Record<number, T>> = {};
    for (const [sid, dm] of Object.entries(src ?? {})) {
      if (!known.has(sid)) continue;
      const row: Record<number, T> = {};
      for (const [d, v] of Object.entries(dm)) {
        if (d.startsWith(`${month}-`)) row[+d.slice(8, 10)] = v;
      }
      if (Object.keys(row).length > 0) out[sid] = row;
    }
    return out;
  };
  const fixed = mapByDay(ctx.fixed);
  const shiftWish = mapByDay(ctx.shiftWish);

  const stDefs = ctx.shiftTypes;
  const shiftIds = stDefs ? stDefs.map((s) => s.id) : SHIFT_ORDER;
  const countableIds = stDefs ? stDefs.filter((s) => s.counts).map((s) => s.id) : SHIFT_ORDER;
  const extra: Record<string, Record<string, number>> = {};
  for (const d of days) {
    const ex = eventExtra(ctx.events, d);
    for (const k of countableIds) {
      const n = (ex as Record<string, number>)[k] ?? 0;
      if (n > 0) (extra[d] ??= {})[k] = n;
    }
  }
  return {
    month, days: days.length, first_weekday: dow(start),
    ...(stDefs ? {
      shift_types: stDefs.map((s) => ({
        id: s.id, name: s.name, short: s.short, start: s.start, end: s.end,
        break_min: s.breakMin, group: s.group, counts: s.counts, next_day: s.nextDay,
      })),
    } : {}),
    staff: staff.map((s) => ({
      staff_id: s.id, role: s.role, employment: s.employment, years: s.years, skills: s.skills,
      shifts: stDefs
        ? shiftIds.filter((id) => !s.isLeader || stDefs.find((d) => d.id === id)?.group !== '夜勤系')
        : s.shifts.filter((k) => canWork(s, k)),
      home_unit: s.homeUnit, leave_by: s.leaveBy ?? null, is_leader: !!s.isLeader,
    })),
    need_per_shift: Object.fromEntries(countableIds.map((k) => [k, UNITS.length])),
    day_off: opt(Object.fromEntries(staff.map((s) => [s.id, dayNums(ctx.dayOff[s.id], month)]))),
    // 主任は土日に入れない（generateRoster と同じ）
    unavailable: opt(Object.fromEntries(staff.filter((s) => s.isLeader).map((s) => [s.id, days.filter((d) => dow(d) === 0 || dow(d) === 6).map((d) => +d.slice(8))]))),
    // 「入れる日」を出した人は、できれば補欠として残す（generateRoster も後回しにする）
    keep_free: opt(Object.fromEntries(staff.map((s) => [s.id, dayNums((ctx.avail[s.id] ?? []).map((x) => x.date), month)]))),
    ...(Object.keys(history).length ? { history } : {}),
    ...(Object.keys(fixed).length ? { fixed } : {}),
    ...(Object.keys(shiftWish).length ? { shift_wish: shiftWish } : {}),
    extra, ...(ctx.nightMax ? { night_max: ctx.nightMax } : {}), time_limit: timeLimit,
    ...(ctx.rules?.length ? { rules: ctx.rules } : {}),
    ...(ctx.baseline ? { baseline: ctx.baseline } : {}),
  };
}

/** ソルバーの表（staff_id -> 日ごとの勤務）を、generateRoster と同じ形の Assignment[] にする */
export function fromResult(month: string, cells: Record<string, string[]>, shiftTypes?: readonly ShiftTypeDef[]): Assignment[] {
  const days = monthDays(month); const out: Assignment[] = []; let n = 0;
  const put = (a: Omit<Assignment, 'id'>) => out.push({ ...a, id: `P-${String(++n).padStart(5, '0')}` });
  const known = new Set(STAFF.map((s) => s.id));
  const order: string[] = shiftTypes
    ? [
        ...shiftTypes.filter((s) => s.group === '夜勤系').map((s) => s.id),
        ...shiftTypes.filter((s) => s.group !== '夜勤系').map((s) => s.id),
      ]
    : ['夜勤', '早番', '日勤', '遅番'];
  days.forEach((d, i) => {
    const extras: Omit<Assignment, 'id'>[] = [];
    for (const sh of order) {
      const ids = Object.keys(cells).filter((sid) => known.has(sid) && cells[sid][i] === sh);
      for (const x of assignUnits(ids, sh as ShiftCode)) {
        const a: Omit<Assignment, 'id'> = { date: d, staffId: x.staffId, shift: sh as ShiftCode, unitId: x.unitId, status: 'assigned', source: 'base' };
        if (x.extra) extras.push({ ...a, note: '行事対応の追加配置' }); else put(a);
      }
    }
    extras.forEach(put);
  });
  return out;
}

export async function solveMonth(month: string, ctx: SolverCtx, signal: AbortSignal): Promise<{ draft: Assignment[]; res: SolveInlineRes }> {
  const r = await fetch(`${SOLVER}/api/v1/solve-inline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toRequest(month, ctx)), signal });
  if (!r.ok) {
    if (r.status === 422) {
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      if (body?.error) throw new SolverRejectedError(body.error);
    }
    throw new Error(`solve-inline ${r.status}`);
  }
  const res = (await r.json()) as SolveInlineRes;
  if ((res.status !== 'OPTIMAL' && res.status !== 'FEASIBLE') || !res.cells || !Object.keys(res.cells).length) {
    if (res.explanation?.length) throw new SolverRejectedError(res.explanation[0]);
    throw new Error(`solve-inline ${res.status}`);
  }
  const n = monthDays(month).length;
  if (Object.values(res.cells).some((row) => !Array.isArray(row) || row.length !== n)) throw new Error('solve-inline: 日数が合いません');
  return { draft: fromResult(month, res.cells, ctx.shiftTypes), res };
}

/** シフト案の「メモ」に出す1行（作成したこと・かかった時間・夜勤回数のそろい方） */
export function solverNote(draft: Assignment[], res: SolveInlineRes, shiftTypes?: readonly ShiftTypeDef[]): string[] {
  const nightIds = new Set(
    shiftTypes ? shiftTypes.filter((s) => s.group === '夜勤系').map((s) => s.id) : ['夜勤'],
  );
  const nights = nightIds.size > 0
    ? STAFF.filter((s) => s.shifts.some((k) => nightIds.has(k) || (!shiftTypes && canWork(s, k)))).map(
        (s) => draft.filter((a) => a.staffId === s.id && nightIds.has(a.shift)).length,
      )
    : [];
  const sec = (res.wall_ms / 1000).toFixed(1);
  const broken = (res.soft_broken ?? []).filter((b) => b.count > 0);
  return [
    `シフト作成君で1か月分を一度に作成：${sec}秒（${res.status === 'OPTIMAL' ? '最適解' : '時間内の最良解'}）`,
    ...(nights.length ? [`夜勤の回数：1人あたり${Math.min(...nights)}〜${Math.max(...nights)}回（夜勤に入れる${nights.length}名でそろえました）`] : []),
    ...(broken.length ? [`守りきれなかった目安：${broken.slice(0, 3).map((b) => `${b.label}（${b.count}件）`).join('、')}`] : []),
  ];
}
