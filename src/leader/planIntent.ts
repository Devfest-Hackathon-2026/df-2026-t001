// シフト作成チャット用：Gemini の分類を、ルール解釈が読める定型の文に直す（共通部分は core/aiintent.ts）
import { STAFF, UNITS } from '../core/facility';
import { askPlan } from '../core/aiintent';
import type { PlanIntent } from '../core/aiintent';
export { IntentError } from '../core/aiintent';
export type { PlanIntent };
export const askGemini = askPlan;

const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const nm = (id: string) => STAFF.find((x) => x.id === id)?.name.replace(/\s+/g, '') ?? '';
/** Gemini の分類を、ルール解釈が読める定型の文に直す（読めなければ null）。 */
export function canonical(i: Pick<PlanIntent, 'intent' | 'staff_ids' | 'date' | 'shift' | 'unit_id'> & { night_max?: number | null }): string | null {
  const a = i.staff_ids[0] ? nm(i.staff_ids[0]) : ''; const d = i.date ? md(i.date) : ''; const unit = i.unit_id ? UNITS.find((u) => u.id === i.unit_id)?.name ?? '' : '';
  switch (i.intent) {
    case 'off': return a && d ? `${a}さんの${d}を休みに` : null;
    case 'assign': return a && d && i.shift ? `${a}さんを${d}の${i.shift}に${unit}で入れて` : null;
    case 'candidates': return d && i.shift ? `${d}の${i.shift}${unit ? `（${unit}）` : ''}に誰が入れる？` : null;
    case 'swap': return i.staff_ids.length === 2 && d ? `${nm(i.staff_ids[0])}さんと${nm(i.staff_ids[1])}さんを${d}で入れ替えて` : null;
    case 'request_work': return a && d ? `${a}さんに${d}の${i.shift ?? '日勤'}${unit}への出勤を依頼して` : null;
    case 'request_paid': return a ? `${a}さんに${d}有休を打診して` : null;
    case 'request_dayoff': return a && d ? `${a}さんに${d}の希望休の修正を依頼して` : null;
    case 'paid_lacking': return '有休が足りない人に打診して';
    case 'create_plan': return i.night_max ? '夜勤を減らして作り直して' : 'シフトを作って';
    case 'remind': return '未提出者に催促して';
    default: return null;
  }
}
