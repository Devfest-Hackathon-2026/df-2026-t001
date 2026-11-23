import { NextDayKindJa, SetupState, ShiftGroupJa, ShiftTimeSetup } from './types';

function toMin(hhmm: string, isEnd = false): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (isEnd && h === 24 && mm === 0) return 1440;
  return h * 60 + mm;
}

/** 終了時刻が翌日 05:00 より後（かつ 24:00 終了でない日またぎ）なら「明け」を既定にする */
export function inferNextDay(startTime: string, endTime: string): NextDayKindJa {
  const s = toMin(startTime, false);
  const e = toMin(endTime, true);
  if (endTime.trim() === '24:00') return 'なし';
  return e <= s && e > 300 ? '明け' : 'なし';
}

export function inferShiftGroup(id: string, startTime: string, endTime: string): ShiftGroupJa {
  const s = toMin(startTime, false);
  const e = toMin(endTime, true);
  if (id.includes('夜') || id === '準' || id === '深' || e <= s || s >= 20 * 60 || s < 5 * 60) {
    return '夜勤系';
  }
  return '日勤系';
}

export function normalizeShiftItem(item: ShiftTimeSetup): Required<ShiftTimeSetup> {
  const id = (item.id ?? '').trim();
  const name = (item.name ?? id).trim() || id;
  const short = (item.short ?? id.slice(0, 2)).trim() || id.slice(0, 2);
  const startTime = item.startTime || '08:30';
  const endTime = item.endTime || '17:30';
  const group: ShiftGroupJa = item.group ?? inferShiftGroup(id, startTime, endTime);
  const counts = item.counts ?? true;
  const nextDay: NextDayKindJa = item.nextDay ?? inferNextDay(startTime, endTime);
  return {
    id,
    name,
    short,
    enabled: item.enabled ?? true,
    startTime,
    endTime,
    group,
    counts,
    nextDay,
  };
}

export const TWO_SHIFT_PRESET: ShiftTimeSetup[] = [
  { id: '早番', name: '早番', short: '早', enabled: true, startTime: '07:00', endTime: '16:00', group: '日勤系', counts: true, nextDay: 'なし' },
  { id: '日勤', name: '日勤', short: '日', enabled: true, startTime: '08:30', endTime: '17:30', group: '日勤系', counts: true, nextDay: 'なし' },
  { id: '遅番', name: '遅番', short: '遅', enabled: true, startTime: '11:00', endTime: '20:00', group: '日勤系', counts: true, nextDay: 'なし' },
  { id: '夜勤', name: '夜勤', short: '夜', enabled: true, startTime: '16:30', endTime: '09:30', group: '夜勤系', counts: true, nextDay: '明け' },
];

export const THREE_SHIFT_PRESET: ShiftTimeSetup[] = [
  { id: '日', name: '日勤', short: '日', enabled: true, startTime: '08:30', endTime: '17:15', group: '日勤系', counts: true, nextDay: 'なし' },
  { id: '準', name: '準夜', short: '準', enabled: true, startTime: '16:30', endTime: '01:15', group: '夜勤系', counts: true, nextDay: 'なし' },
  { id: '深', name: '深夜', short: '深', enabled: true, startTime: '00:30', endTime: '09:15', group: '夜勤系', counts: true, nextDay: 'なし' },
];

export const DEFAULT_SETUP_STATE: SetupState = {
  currentStep: 0,
  facility: {
    name: 'ひだまりの郷',
    kind: '特別養護老人ホーム',
    units: [
      { id: 'u1', name: 'ひなた', floor: 1 },
      { id: 'u2', name: 'そよかぜ', floor: 2 },
    ],
  },
  shifts: TWO_SHIFT_PRESET.map((s) => ({ ...s })),
  needPerShift: {
    早番: 2,
    日勤: 2,
    遅番: 2,
    夜勤: 2,
  },
  useWeekdayNeed: false,
  needByWeekday: {},
  staff: [
    { id: 'S001', name: '職員A', role: '主任', employment: '常勤', shifts: ['早番', '日勤', '遅番'], canMedicalCare: true, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [0, 6] },
    { id: 'S002', name: '職員B', role: '介護福祉士', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: true, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S003', name: '職員C', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S004', name: '職員D', role: '介護福祉士', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: true, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S005', name: '職員E', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S006', name: '職員F', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S007', name: '職員G', role: '介護福祉士', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: true, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S008', name: '職員H', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S009', name: '職員I', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S010', name: '職員J', role: '介護福祉士', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: true, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S011', name: '職員K', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S012', name: '職員L', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S013', name: '職員M', role: '介護福祉士', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: true, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S014', name: '職員N', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S015', name: '職員O', role: '介護福祉士', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: true, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S016', name: '職員P', role: '介護職員', employment: '常勤', shifts: ['早番', '日勤', '遅番', '夜勤'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [] },
    { id: 'S017', name: '職員Q', role: '介護職員', employment: 'パート', shifts: ['早番'], canMedicalCare: false, homeUnit: 'ひなた', leaveBy: '16:00', unavailableDaysOfWeek: [0, 6] },
    { id: 'S018', name: '職員R', role: '介護職員', employment: 'パート', shifts: ['早番', '日勤'], canMedicalCare: false, homeUnit: 'ひなた', leaveBy: '', unavailableDaysOfWeek: [2, 4] },
    { id: 'S019', name: '職員S', role: '介護職員', employment: 'パート', shifts: ['遅番'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '', unavailableDaysOfWeek: [1, 3] },
    { id: 'S020', name: '職員T', role: '介護職員', employment: 'パート', shifts: ['早番', '日勤'], canMedicalCare: false, homeUnit: 'そよかぜ', leaveBy: '17:00', unavailableDaysOfWeek: [0, 6] },
  ],
  rules: {
    nightMax: 8,
  },
  carryIn: {},
  history: {},
};
