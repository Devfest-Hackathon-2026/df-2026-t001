import type { ShiftCode } from './types';
import { SHIFT_ORDER } from './facility';

export type EventKind = '行事' | '訓練' | '研修' | '面会' | '誕生会' | 'その他';
export interface FacilityEvent {
  id: string; date: string; title: string; kind: EventKind; note?: string;
  /** 必要人数への影響：この勤務帯に extra 名の追加が必要。allStaff=true は、その勤務帯の職員は全員参加（人数の追加はなし） */
  effect?: { shifts: ShiftCode[]; extra: number; allStaff?: boolean };
}
export const HOLIDAYS: Record<string, string> = { '2026-10-12': 'スポーツの日', '2026-11-03': '文化の日', '2026-11-23': '勤労感謝の日' };
export const holidayOf = (date: string) => HOLIDAYS[date];

export const SEED_EVENTS: FacilityEvent[] = [
  { id: 'EV1', date: '2026-11-20', title: '家族面会（午後）', kind: '面会', note: '14:00〜16:00。各ユニットで面会の案内' },
  { id: 'EV2', date: '2026-11-25', title: '11月の誕生会', kind: '誕生会', note: '15:00〜 食堂。レクの職員を増やす', effect: { shifts: ['日勤'], extra: 1 } },
  { id: 'EV3', date: '2026-11-27', title: '避難訓練', kind: '訓練', note: '14:00〜。日勤・遅番は全員参加', effect: { shifts: ['日勤', '遅番'], extra: 0, allStaff: true } },
  { id: 'EV4', date: '2026-11-29', title: 'ボランティア来所（音楽会）', kind: '行事', effect: { shifts: ['日勤'], extra: 1 } },
  { id: 'EV5', date: '2026-12-03', title: '感染対策研修', kind: '研修', note: '日勤は全員参加（オンライン）', effect: { shifts: ['日勤'], extra: 0, allStaff: true } },
  { id: 'EV6', date: '2026-12-12', title: '入浴強化日', kind: '行事', note: '特浴を増やす日', effect: { shifts: ['日勤'], extra: 1 } },
  { id: 'EV7', date: '2026-12-24', title: 'クリスマス会', kind: '誕生会', effect: { shifts: ['日勤', '遅番'], extra: 1 } },
  { id: 'EV8', date: '2026-12-31', title: '大晦日（面会・帰省が多い日）', kind: '行事', effect: { shifts: ['夜勤'], extra: 1 } },
];

/** その日の行事による追加必要人数（勤務帯ごと） */
export function eventExtra(events: FacilityEvent[], date: string): Record<ShiftCode, number> {
  const r = Object.fromEntries(SHIFT_ORDER.map((s) => [s, 0])) as Record<ShiftCode, number>;
  for (const e of events) if (e.date === date && e.effect) for (const s of e.effect.shifts) r[s] += e.effect.extra;
  return r;
}
export const eventsOn = (events: FacilityEvent[], date: string) => events.filter((e) => e.date === date);
