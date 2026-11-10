import type { Assignment, ShiftCode } from './types';
import { SHIFTS, STAFF } from './facility';
import { addDays, daysInRange, fmtMD } from './dates';

export const LABOR_RULES = { maxConsecutive: 5, minIntervalH: 11, maxNightsPerMonth: 8, minOffDays: 8 };
export interface StaffStats { staffId: string; workDays: number; nights: number; offDays: number; hours: number; maxConsecutive: number; warnings: { kind: '連勤' | '勤務間インターバル' | '夜勤明け' | '夜勤回数' | '公休数'; text: string; date?: string }[]; }

const workHours = (sh: ShiftCode) => (SHIFTS[sh].end - SHIFTS[sh].start - SHIFTS[sh].breakMin) / 60;

/** 月ごとの職員別集計と労務チェック（目安。法令・就業規則に基づく最終判断は施設で行う） */
export function monthStats(all: Assignment[], monthStart: string): StaffStats[] {
  const [yy, mm] = monthStart.split('-').map(Number);
  const last = daysInRange(monthStart, `${yy}-${String(mm).padStart(2, '0')}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`);
  const byStaff = new Map<string, Assignment[]>();
  for (const a of all) if (a.status !== 'absent') (byStaff.get(a.staffId) ?? byStaff.set(a.staffId, []).get(a.staffId)!).push(a);
  return STAFF.filter((s) => s.shifts.length && !s.isLeader).map((s) => {
    const mine = (byStaff.get(s.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const inMonth = mine.filter((a) => a.date.slice(0, 7) === monthStart.slice(0, 7));
    const worked = new Set(mine.map((a) => a.date));
    const akeDays = new Set(mine.filter((a) => a.shift === '夜勤').map((a) => addDays(a.date, 1)));
    const warnings: StaffStats['warnings'] = [];
    let run = 0, maxRun = 0;
    for (const d of last) { if (worked.has(d) || akeDays.has(d)) { run++; maxRun = Math.max(maxRun, run); if (run === LABOR_RULES.maxConsecutive + 1) warnings.push({ kind: '連勤', text: `${fmtMD(d)}で${run}連勤になります`, date: d }); } else run = 0; }
    for (const a of inMonth) {
      const next = mine.find((b) => b.date === addDays(a.date, 1));
      if (next && a.shift === '夜勤') { warnings.push({ kind: '夜勤明け', text: `${fmtMD(a.date)}夜勤→翌日（夜勤明け）に${next.shift}`, date: next.date }); continue; }
      if (next) { const endAbs = SHIFTS[a.shift].end; const startAbs = 1440 + SHIFTS[next.shift].start; const gap = (startAbs - endAbs) / 60; if (gap < LABOR_RULES.minIntervalH) warnings.push({ kind: '勤務間インターバル', text: `${fmtMD(a.date)}${a.shift}→翌日${next.shift}で間隔${gap}時間`, date: a.date }); }
    }
    const nights = inMonth.filter((a) => a.shift === '夜勤').length;
    if (nights > LABOR_RULES.maxNightsPerMonth) warnings.push({ kind: '夜勤回数', text: `夜勤が${nights}回（目安${LABOR_RULES.maxNightsPerMonth}回以内）` });
    const off = last.filter((d) => !worked.has(d) && !akeDays.has(d)).length;
    if (s.employment === '常勤' && off < LABOR_RULES.minOffDays) warnings.push({ kind: '公休数', text: `公休が${off}日（目安${LABOR_RULES.minOffDays}日以上）` });
    return { staffId: s.id, workDays: inMonth.length, nights, offDays: off, hours: inMonth.reduce((t, a) => t + workHours(a.shift), 0), maxConsecutive: maxRun, warnings };
  });
}
