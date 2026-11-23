export interface UnitItem {
  id: string;
  name: string;
  floor: number;
}

export interface FacilitySetup {
  name: string;
  kind: string;
  units: UnitItem[];
}

export type ShiftId = string;
export type ShiftGroupJa = '日勤系' | '夜勤系' | 'その他';
export type NextDayKindJa = '明け' | 'なし';

export interface ShiftTimeSetup {
  id: ShiftId;
  name: string;
  short?: string;
  enabled: boolean;
  startTime: string;
  endTime: string;
  group?: ShiftGroupJa;
  counts?: boolean;
  nextDay?: NextDayKindJa;
}

export type NeedPerShiftSetup = Record<string, number>;

/** 曜日ごとの必要人数 [日, 月, 火, 水, 木, 金, 土]（祝日は日曜と同じ値を使う） */
export type WeekdayCounts = [number, number, number, number, number, number, number];
export type NeedByWeekdaySetup = Partial<Record<string, WeekdayCounts>>;

export interface CountRange {
  min?: number | null;
  max?: number | null;
}

export interface StaffLimitsSetup {
  workDays?: CountRange;
  byShift?: Partial<Record<string, CountRange>>;
}

export interface StaffSetupItem {
  id: string;
  name: string;
  role: string;
  employment: '常勤' | 'パート';
  shifts: ShiftId[];
  canMedicalCare: boolean;
  homeUnit: string;
  leaveBy?: string;
  unavailableDaysOfWeek: number[]; // 0: 日, 1: 月, ... 6: 土
  limits?: StaffLimitsSetup;
}

export interface RulesSetup {
  nightMax: number;
}

export interface CarryInSetup {
  [staffId: string]: string; // "早番" | "日勤" | "遅番" | "夜勤" | "休"
}

/** 前月の最後の7日（古い順、"" は休） */
export interface HistorySetup {
  [staffId: string]: string[];
}

export interface SetupState {
  currentStep: number; // 0: S0(案内), 1: S1(施設), 2: S2(勤務帯), 3: S3(必要人数), 4: S4(職員), 5: S5(守ること), 6: S6(前月末), 7: S7(確認)
  facility: FacilitySetup;
  shifts: ShiftTimeSetup[];
  needPerShift: NeedPerShiftSetup;
  useWeekdayNeed?: boolean;
  needByWeekday?: NeedByWeekdaySetup;
  staff: StaffSetupItem[];
  rules: RulesSetup;
  carryIn: CarryInSetup;
  history?: HistorySetup;
}

export const STEP_INFOS = [
  { id: 'S0', title: 'はじめに', shortTitle: '案内' },
  { id: 'S1', title: '施設とユニット', shortTitle: '施設' },
  { id: 'S2', title: '勤務帯', shortTitle: '勤務帯' },
  { id: 'S3', title: '毎日の必要人数', shortTitle: '人数' },
  { id: 'S4', title: '職員の一覧', shortTitle: '職員' },
  { id: 'S5', title: '守ること（ルール）', shortTitle: 'ルール' },
  { id: 'S6', title: '前月の最後の7日', shortTitle: '前月末' },
  { id: 'S7', title: '確認', shortTitle: '確認' },
] as const;
