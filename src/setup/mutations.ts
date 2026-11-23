import { THREE_SHIFT_PRESET, TWO_SHIFT_PRESET, normalizeShiftItem } from './defaults';
import {
  FacilitySetup,
  NeedByWeekdaySetup,
  NeedPerShiftSetup,
  RulesSetup,
  SetupState,
  ShiftTimeSetup,
  WeekdayCounts,
} from './types';

export function updateFacility(prev: SetupState, facility: FacilitySetup): SetupState {
  return { ...prev, facility };
}

export function updateShifts(prev: SetupState, shifts: ShiftTimeSetup[]): SetupState {
  const needPerShift = { ...prev.needPerShift };
  for (const s of shifts) {
    const sid = s.id.trim();
    if (sid && needPerShift[sid] === undefined) {
      needPerShift[sid] = 0;
    }
  }
  return { ...prev, shifts, needPerShift };
}

export function renameShiftId(prev: SetupState, oldId: string, newId: string): SetupState {
  const needPerShift = { ...prev.needPerShift };
  if (oldId in needPerShift) {
    if (needPerShift[newId] === undefined) {
      needPerShift[newId] = needPerShift[oldId];
    }
    delete needPerShift[oldId];
  }
  const needByWeekday = { ...(prev.needByWeekday ?? {}) };
  if (needByWeekday[oldId]) {
    needByWeekday[newId] = needByWeekday[oldId];
    delete needByWeekday[oldId];
  }
  const staff = prev.staff.map((st) => {
    const shifts = st.shifts.map((k) => (k === oldId ? newId : k));
    const byShift = st.limits?.byShift ? { ...st.limits.byShift } : undefined;
    if (byShift && byShift[oldId]) {
      byShift[newId] = byShift[oldId];
      delete byShift[oldId];
    }
    return {
      ...st,
      shifts,
      ...(st.limits ? { limits: { ...st.limits, ...(byShift ? { byShift } : {}) } } : {}),
    };
  });
  return { ...prev, needPerShift, needByWeekday, staff };
}

export function applyShiftPreset(prev: SetupState, preset: '2shift' | '3shift'): SetupState {
  const unitCount = Math.max(1, Math.min(20, prev.facility.units.length || 1));
  const rawPreset: ShiftTimeSetup[] =
    preset === '3shift'
      ? THREE_SHIFT_PRESET.map((s) => ({ ...s }))
      : TWO_SHIFT_PRESET.map((s) => ({ ...s }));
  const norm = rawPreset.map(normalizeShiftItem);
  const allIds = norm.map((s) => s.id);
  const dayIds = norm.filter((s) => s.group === '日勤系').map((s) => s.id);
  const needPerShift: Record<string, number> =
    preset === '3shift'
      ? { 日: Math.max(2, unitCount * 2), 準: unitCount, 深: unitCount }
      : Object.fromEntries(allIds.map((id) => [id, unitCount]));
  const staff = prev.staff.map((st) => ({
    ...st,
    shifts:
      st.role === '主任'
        ? [...dayIds]
        : st.employment === 'パート'
          ? (preset === '3shift' ? ['日'] : dayIds.slice(0, 2))
          : [...allIds],
  }));
  return {
    ...prev,
    shifts: rawPreset,
    needPerShift,
    useWeekdayNeed: false,
    needByWeekday: {},
    staff,
    carryIn: {},
    history: {},
  };
}

export function updateNeedPerShift(prev: SetupState, needPerShift: NeedPerShiftSetup): SetupState {
  const nextWeekday: NeedByWeekdaySetup = { ...(prev.needByWeekday ?? {}) };
  if (!prev.useWeekdayNeed) {
    for (const s of prev.shifts) {
      if (needPerShift[s.id] !== prev.needPerShift[s.id]) {
        delete nextWeekday[s.id];
      }
    }
  }
  return { ...prev, needPerShift, needByWeekday: nextWeekday };
}

export function updateWeekdayNeed(
  prev: SetupState,
  useWeekdayNeed: boolean,
  needByWeekday: NeedByWeekdaySetup
): SetupState {
  return { ...prev, useWeekdayNeed, needByWeekday };
}

export function alignAllNeedToUnits(prev: SetupState, target: number): SetupState {
  const needPerShift = { ...prev.needPerShift };
  const needByWeekday: NeedByWeekdaySetup = { ...(prev.needByWeekday ?? {}) };
  const row: WeekdayCounts = [target, target, target, target, target, target, target];
  for (const s of prev.shifts) {
    const v = s.enabled ? target : 0;
    needPerShift[s.id] = v;
    if (prev.useWeekdayNeed && s.enabled) {
      needByWeekday[s.id] = [...row];
    } else if (!prev.useWeekdayNeed) {
      delete needByWeekday[s.id];
    }
  }
  return { ...prev, needPerShift, needByWeekday };
}

export function updateRules(prev: SetupState, rules: RulesSetup): SetupState {
  return { ...prev, rules };
}
