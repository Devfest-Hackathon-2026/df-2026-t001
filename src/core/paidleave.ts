// 年次有給休暇（有休）の取得状況。デモ用の架空データ（年5日の取得義務は仮値）。
import { STAFF } from './facility';
export const PAID_TARGET = 5;
const hash = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
/** 今年度すでに取得した日数（架空）。おおよそ3分の1の人は5日に届いていない */
export const paidBase = (id: string) => { const h = hash(id) % 9; return h < 3 ? h : h < 6 ? 3 + (h % 3) : 5 + (h % 2); };
export const hasPaid = (id: string) => STAFF.some((x) => x.id === id && x.shifts.length);
export const paidCount = (s: { paidLeave?: Record<string, string[]> }, id: string) => paidBase(id) + (s.paidLeave?.[id]?.length ?? 0);
