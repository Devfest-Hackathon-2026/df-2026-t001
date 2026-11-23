// はじめの設定（SetupState）を、ソルバーの POST /api/v1/solve-inline の形に変換する。
// setup 画面ではソルバーを呼ばない。シフト作成の画面が setup の内容を読むようにする段階（Phase 2）で使う。
import { holidaysInMonth } from '../core/holidays';
import { normalizeShiftItem } from './defaults';
import { CountRange, SetupState, ShiftId, ShiftTimeSetup, StaffSetupItem } from './types';

export interface InlineShiftTypePayload {
  id: string;
  name: string;
  short: string;
  start: string;
  end: string;
  group: '日勤系' | '夜勤系' | 'その他';
  counts: boolean;
  next_day: '明け' | 'なし';
}

export interface InlineStaffLimitPayload {
  shifts: ShiftId[] | null;
  unit?: '回' | '時間';
  at_least?: number;
  at_most?: number;
}

export interface TargetMonthInfo {
  year: number;
  month: number; // 1..12
  monthStr: string; // "YYYY-MM"
  label: string; // "YYYY年M月"
  days: number;
  firstWeekday: number; // 0: 日 .. 6: 土
}

export interface InlineStaffPayload {
  staff_id: string;
  role: string;
  employment: string;
  years: number;
  skills: string[];
  shifts: string[];
  home_unit: string | null;
  leave_by: string | null;
  is_leader: boolean;
  limits?: InlineStaffLimitPayload[];
}

export interface InlineSolveRequest {
  month: string;
  days: number;
  first_weekday: number;
  shift_types?: InlineShiftTypePayload[];
  staff: InlineStaffPayload[];
  need_per_shift: Record<string, number>;
  need_by_weekday?: Record<string, number[]>;
  holidays?: number[];
  unavailable: Record<string, number[]>;
  carry_in: Record<string, string>;
  history?: Record<string, string[]>;
  night_max: number;
  time_limit: number;
}

export function getTargetMonth(): TargetMonthInfo {
  const now = new Date();
  const year = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const month = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  const days = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  return {
    year,
    month,
    monthStr,
    label: `${year}年${month}月`,
    days,
    firstWeekday,
  };
}

export function isExcludedByLeaveBy(shift: ShiftTimeSetup, leaveBy?: string): boolean {
  if (!leaveBy) return false;
  const norm = normalizeShiftItem(shift);
  const crossesMidnight = norm.endTime <= norm.startTime && norm.endTime !== '24:00';
  if (norm.group === '夜勤系' || crossesMidnight) return false;
  return norm.endTime > leaveBy;
}

/** 作成に実際に使う「入れる勤務帯」（使わない勤務帯と、退勤上限より後に終わる勤務帯を外したもの） */
export function allowedShiftsFor(member: StaffSetupItem, shifts: ShiftTimeSetup[]): ShiftTimeSetup['id'][] {
  return member.shifts.filter((shId) => {
    const sh = shifts.find((s) => s.id === shId);
    return !!sh && sh.enabled && !isExcludedByLeaveBy(sh, member.leaveBy);
  });
}

export const MAX_INLINE_STAFF = 80;

function toLimitEntry(
  shifts: ShiftId[] | null,
  range: CountRange | undefined
): InlineStaffLimitPayload | null {
  if (!range) return null;
  const rawMin = range.min;
  const rawMax = range.max;
  const hasMin = typeof rawMin === 'number' && Number.isFinite(rawMin);
  const hasMax = typeof rawMax === 'number' && Number.isFinite(rawMax);
  if (!hasMin && !hasMax) return null;
  const clampCount = (v: number) => Math.max(0, Math.min(31, Math.round(v)));
  let atLeast = hasMin ? clampCount(rawMin) : undefined;
  const atMost = hasMax ? clampCount(rawMax) : undefined;
  if (atLeast !== undefined && atMost !== undefined && atLeast > atMost) {
    atLeast = atMost;
  }
  const entry: InlineStaffLimitPayload = { shifts };
  if (atLeast !== undefined) entry.at_least = atLeast;
  if (atMost !== undefined) entry.at_most = atMost;
  return entry;
}

function buildStaffLimits(
  member: StaffSetupItem,
  shiftOrder: ShiftId[],
  enabledShiftIds: Set<ShiftId>
): InlineStaffLimitPayload[] {
  const lim = member.limits;
  if (!lim) return [];
  const out: InlineStaffLimitPayload[] = [];
  const workEntry = toLimitEntry(null, lim.workDays);
  if (workEntry) out.push(workEntry);
  for (const sh of shiftOrder) {
    if (!enabledShiftIds.has(sh)) continue;
    const shEntry = toLimitEntry([sh], lim.byShift?.[sh]);
    if (shEntry) out.push(shEntry);
  }
  return out;
}

const RESERVED_SHIFT_IDS = new Set(['休', '有給', 'paid', 'off', '勤務', '']);

export function buildInlineRequest(state: SetupState): {
  payload: InlineSolveRequest;
  staffNameMap: Record<string, string>;
  targetMonth: TargetMonthInfo;
  droppedStaffCount: number;
} {
  const targetMonth = getTargetMonth();
  const staffNameMap: Record<string, string> = {};
  const usedIds = new Set<string>();
  const staff: InlineStaffPayload[] = [];
  const unavailable: Record<string, number[]> = {};
  const carry_in: Record<string, string> = {};
  const history: Record<string, string[]> = {};

  const seenShiftIds = new Set<string>();
  const normalizedShifts: Required<ShiftTimeSetup>[] = [];
  for (const rawShift of state.shifts) {
    const norm = normalizeShiftItem(rawShift);
    if (RESERVED_SHIFT_IDS.has(norm.id) || seenShiftIds.has(norm.id)) continue;
    seenShiftIds.add(norm.id);
    normalizedShifts.push(norm);
    if (normalizedShifts.length >= 12) break;
  }
  const shiftTypesPayload: InlineShiftTypePayload[] = normalizedShifts.map((s) => ({
    id: s.id,
    name: s.name,
    short: s.short,
    start: s.startTime,
    end: s.endTime,
    group: s.group,
    counts: s.counts,
    next_day: s.nextDay,
  }));
  const allShiftOrder = normalizedShifts.map((s) => s.id);
  const enabledShiftSet = new Set<ShiftId>(
    normalizedShifts.filter((s) => s.enabled).map((s) => s.id)
  );
  const isWorkShift = (v: string | undefined): v is ShiftId =>
    Boolean(v && enabledShiftSet.has(v));
  let nextAutoNum = 1;
  const droppedStaffCount = Math.max(0, state.staff.length - MAX_INLINE_STAFF);

  state.staff.slice(0, MAX_INLINE_STAFF).forEach((member, idx) => {
    // 名前は一切送らず、自動採番 ID のみ送信する
    let sid: string;
    if (member.id && /^S\d+$/.test(member.id) && !usedIds.has(member.id)) {
      sid = member.id;
    } else {
      while (usedIds.has(`S${String(nextAutoNum).padStart(3, '0')}`)) {
        nextAutoNum += 1;
      }
      sid = `S${String(nextAutoNum).padStart(3, '0')}`;
      nextAutoNum += 1;
    }
    usedIds.add(sid);
    staffNameMap[sid] = member.name.trim() || `職員 ${idx + 1}`;

    const allowedShifts = allowedShiftsFor(member, normalizedShifts).filter((id) =>
      seenShiftIds.has(id)
    );
    const staffLimits = buildStaffLimits(member, allShiftOrder, enabledShiftSet);

    staff.push({
      staff_id: sid,
      role: member.role || '介護職員',
      employment: member.employment || '常勤',
      years: 0,
      skills: member.canMedicalCare ? ['medical'] : [],
      shifts: allowedShifts,
      // 所属ユニットは作成にはまだ使っていない。サーバーの上限（20文字）を超えて受け付けられないことがないよう切り詰める
      home_unit: member.homeUnit?.trim() ? member.homeUnit.trim().slice(0, 20) : null,
      leave_by: member.leaveBy?.trim() ? member.leaveBy.trim() : null,
      is_leader: member.role === '主任',
      ...(staffLimits.length > 0 ? { limits: staffLimits } : {}),
    });

    if (member.unavailableDaysOfWeek.length > 0) {
      const dates: number[] = [];
      for (let d = 1; d <= targetMonth.days; d++) {
        const w = (targetMonth.firstWeekday + d - 1) % 7;
        if (member.unavailableDaysOfWeek.includes(w)) {
          dates.push(d);
        }
      }
      if (dates.length > 0) {
        unavailable[sid] = dates;
      }
    }

    const rawHist = state.history?.[member.id];
    if (rawHist && rawHist.length > 0) {
      const seq = rawHist.slice(-7).map((v) => (isWorkShift(v) ? v : ''));
      if (seq.some((v) => v !== '')) {
        history[sid] = seq;
      }
      const lastShift = seq[seq.length - 1];
      if (lastShift) {
        carry_in[sid] = lastShift;
      }
    } else {
      const prevShift = state.carryIn[member.id];
      if (isWorkShift(prevShift)) {
        carry_in[sid] = prevShift;
      }
    }
  });

  const need_per_shift: Record<string, number> = {};
  const need_by_weekday: Record<string, number[]> = {};
  const clampNeed = (v: number) => Math.max(0, Math.min(20, Math.round(v)));
  for (const s of normalizedShifts) {
    if (!s.enabled) {
      need_per_shift[s.id] = 0;
      continue;
    }
    if (!s.counts) {
      continue;
    }
    const base = clampNeed(state.needPerShift[s.id] ?? 0);
    const rawRow = state.useWeekdayNeed ? state.needByWeekday?.[s.id] : undefined;
    if (rawRow && rawRow.length === 7) {
      const row = rawRow.map((v) => clampNeed(Number.isFinite(v) ? v : base));
      need_per_shift[s.id] = Math.min(...row);
      if (new Set(row).size > 1) {
        need_by_weekday[s.id] = row;
      }
    } else {
      need_per_shift[s.id] = base;
    }
  }

  const payload: InlineSolveRequest = {
    month: targetMonth.monthStr,
    days: targetMonth.days,
    first_weekday: targetMonth.firstWeekday,
    ...(shiftTypesPayload.length > 0 ? { shift_types: shiftTypesPayload } : {}),
    staff,
    need_per_shift,
    unavailable,
    carry_in,
    night_max: Math.max(1, Math.min(15, state.rules.nightMax || 8)),
    time_limit: 12,
  };
  if (Object.keys(need_by_weekday).length > 0) {
    payload.need_by_weekday = need_by_weekday;
    const holidays = holidaysInMonth(targetMonth.monthStr);
    if (holidays.length > 0) {
      payload.holidays = holidays;
    }
  }

  if (Object.keys(history).length > 0) {
    payload.history = history;
  }

  return { payload, staffNameMap, targetMonth, droppedStaffCount };
}
