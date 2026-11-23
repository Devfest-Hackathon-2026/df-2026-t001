import type { Assignment, ShiftCode } from './types';
import type { FacilityEvent } from './events';
import { eventExtra } from './events';
import { canWork, generateRoster, summarizeDay } from './roster';
import type { Availability } from './roster';
import { STAFF } from './facility';
import { addDays, daysInRange, nowStamp } from './dates';

export interface Plan {
  month: string; draft: Assignment[]; createdAt: string; status: 'draft' | 'published';
  /** 補欠：「入れる日」を出したが、この月次案では勤務に入らなかった人（欠員のとき最優先で打診） */
  spares: Record<string, { staffId: string; shifts: ShiftCode[] }[]>;
  notes: string[];
  /** ソルバーが画面の労務チェック（明けを含む5連勤・常勤公休8日）を含めて解いたか。false のとき外して作成 */
  appLaborRules?: boolean;
  stats: { dayOffTotal: number; dayOffHonored: number; shortDays: number; warnDays: number; vacantSlots: number; extraSlots: number; nightMax?: number };
}
export const monthEnd = (month: string) => { const [y, m] = month.split('-').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

/** 対象月の前日までの直近 days 日分の有効な割り当て（12/1 などの夜勤明け判定に使う） */
export function prevHistoryOf(assignments: Assignment[] | undefined, month: string, days = 7): Assignment[] {
  if (!assignments?.length) return [];
  const start = `${month}-01`;
  const from = addDays(start, -days);
  return assignments.filter((a) => a.date >= from && a.date < start && a.status !== 'absent');
}

export function computeSpares(draft: Assignment[], avail: Availability, month: string): Plan['spares'] {
  const out: Plan['spares'] = {}; const start = `${month}-01`; const end = monthEnd(month);
  const worked = (id: string, d: string) => draft.some((a) => a.staffId === id && a.date === d && a.status !== 'absent');
  const ake = (id: string, d: string) => draft.some((a) => a.staffId === id && a.shift === '夜勤' && a.date === addDays(d, -1));
  for (const st of STAFF) for (const x of avail[st.id] ?? []) {
    if (x.date < start || x.date > end || worked(st.id, x.date) || ake(st.id, x.date)) continue;
    const shifts = (x.shifts.length ? x.shifts : st.shifts).filter((k) => canWork(st, k));
    if (shifts.length) (out[x.date] ??= []).push({ staffId: st.id, shifts });
  }
  return out;
}

function applyFixedToDraft(draft: Assignment[], fixed: Record<string, Record<string, ShiftCode | '休'>> | undefined, month: string): Assignment[] {
  if (!fixed) return draft;
  let out = draft;
  let seq = out.length + 1;
  for (const [staffId, byDate] of Object.entries(fixed)) {
    const st = STAFF.find((x) => x.id === staffId);
    if (!st) continue;
    for (const [date, val] of Object.entries(byDate)) {
      if (!date.startsWith(`${month}-`)) continue;
      out = out.filter((a) => !(a.staffId === staffId && a.date === date && a.status !== 'absent'));
      if (val !== '休') {
        out.push({ id: `PF-${seq++}`, date, staffId, shift: val, unitId: st.homeUnit, status: 'assigned', source: 'leader' });
      }
    }
  }
  return out;
}

export function planMonth(month: string, ctx: { assignments: Assignment[]; dayOff: Record<string, string[]>; avail: Availability; events: FacilityEvent[]; nightMax?: number; fixed?: Record<string, Record<string, ShiftCode | '休'>> }): Plan {
  const start = `${month}-01`; const end = monthEnd(month);
  const history = prevHistoryOf(ctx.assignments, month, 7);
  const raw = generateRoster({ start, end, history, dayOff: ctx.dayOff, avail: ctx.avail, extra: (d, sh) => eventExtra(ctx.events, d)[sh], nightMax: ctx.nightMax, idPrefix: 'P' });
  const draft = applyFixedToDraft(raw, ctx.fixed, month);
  return finalize(month, draft, { ...ctx, assignments: ctx.assignments }, 'draft');
}
export function finalize(month: string, draft: Assignment[], ctx: { dayOff: Record<string, string[]>; avail: Availability; events: FacilityEvent[]; nightMax?: number; assignments?: Assignment[] }, status: Plan['status'], createdAt = nowStamp(), notes?: string[]): Plan {
  const days = daysInRange(`${month}-01`, monthEnd(month));
  const prev = prevHistoryOf(ctx.assignments, month, 7);
  const withPrev = prev.length ? [...prev, ...draft] : draft;
  let dayOffTotal = 0; let dayOffHonored = 0;
  for (const [id, ds] of Object.entries(ctx.dayOff)) for (const d of ds) if (d.startsWith(month)) { dayOffTotal++; if (!draft.some((a) => a.staffId === id && a.date === d && a.status !== 'absent')) dayOffHonored++; }
  let shortDays = 0; let warnDays = 0; let vacantSlots = 0; let extraSlots = 0;
  for (const d of days) { const sm = summarizeDay(withPrev, d, ctx.events); if (sm.level === 'short') shortDays++; else if (sm.level === 'warn') warnDays++; vacantSlots += sm.vacant; extraSlots += draft.filter((a) => a.date === d && a.note?.includes('行事')).length; }
  const spares = computeSpares(withPrev, ctx.avail, month);
  const spareCount = Object.values(spares).reduce((t, l) => t + l.length, 0);
  return {
    month, draft, createdAt, status, spares,
    notes: notes ?? [`希望休：${dayOffTotal}件のうち${dayOffHonored}件を反映しました`, `補欠（入れる日を出して、勤務に入らない人）：のべ${spareCount}日分`, ...(extraSlots ? [`行事のため追加配置：${extraSlots}枠`] : []), ...(ctx.nightMax ? [`夜勤は1人あたり月${ctx.nightMax}回までにしました`] : [])],
    stats: { dayOffTotal, dayOffHonored, shortDays, warnDays, vacantSlots, extraSlots, nightMax: ctx.nightMax },
  };
}
