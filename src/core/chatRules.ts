// シフト作成チャットで足す「決まり（ルール）」。言葉 → POST /api/v1/rules/translate-inline → 候補を選ぶ → 次の作成から rules で送る。
// AI が出すのは候補だけ。1つ選んで「このルールを足す」を押すまで、勤務表もルールも変えない（AIは提案、確定は人）。
// 職員の氏名は送らない（言葉の中の氏名は送る前に職員IDに置き換え、ラベルの職員IDは画面で氏名に戻す）。
import { SOLVER } from '../leader/ai/api';
import { STAFF, staffById } from './facility';
import { canWork } from './roster';
import type { Assignment } from './types';

/** translate-inline が返す候補1つ（rule は InlineSolveIn.rules の1本の形そのまま） */
export interface RuleCand {
  scope: string;
  label: string;
  strength: '絶対' | '強く' | 'できれば';
  impact: { broken_now: number } | null;
  rule: Record<string, unknown>;
}
export type TranslateRes =
  | { kind: 'candidates'; candidates: RuleCand[] }
  | { kind: 'setting'; setting_field: string; setting_label: string; message: string; candidates: [] }
  | { kind: 'unsupported'; unsupported_kind: string; message: string; candidates: [] }
  /** 人数・回数・差の数が言葉から読み取れなかった（推測で埋めず、聞き返す） */
  | { kind: 'ask'; message: string; candidates: [] };

/** 足したルール（施設ごとに端末に保存し、作成のたびに送る） */
export interface ChatRule { id: string; label: string; strength: RuleCand['strength']; rule: Record<string, unknown>; on: boolean; addedAt: string }

export class RuleError extends Error {}

/** ソルバーに送る職員（toRequest と同じ人・同じ入れる勤務帯。氏名なし） */
export const ruleStaff = () => STAFF.filter((s) => s.shifts.length).map((s) => ({
  staff_id: s.id, role: s.role, employment: s.employment, skills: [...s.skills], shifts: s.shifts.filter((k) => canWork(s, k)),
}));

/** 作成中の表を、ソルバーの cells の形（職員ID → 日ごとの勤務。休みは空文字）にする */
export function cellsOf(draft: Assignment[], month: string, nDays: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of ruleStaff()) out[s.staff_id] = Array(nDays).fill('');
  for (const a of draft) {
    if (a.status === 'absent' || !a.date.startsWith(`${month}-`) || !out[a.staffId]) continue;
    const i = +a.date.slice(8, 10) - 1;
    if (i >= 0 && i < nDays && !out[a.staffId][i]) out[a.staffId][i] = a.shift;
  }
  return out;
}

/** 言葉の中の氏名（フルネーム・名字）を職員IDに置き換える。名字が重なる人は置き換えない */
export function pseudonymize(text: string): string {
  const fams = new Map<string, number>();
  for (const s of STAFF) { const f = s.name.split(' ')[0]; fams.set(f, (fams.get(f) ?? 0) + 1); }
  const pairs: [string, string][] = [];
  for (const s of STAFF) {
    pairs.push([s.name, s.id], [s.name.replace(/\s+/g, ''), s.id]);
    const f = s.name.split(' ')[0];
    if (fams.get(f) === 1 && f.length >= 2) pairs.push([f, s.id]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let t = text;
  for (const [nm, id] of pairs) t = t.split(nm).join(id);
  return t;
}

/** ラベルの職員ID（EMP-001 など）を、画面の氏名に戻す */
export const displayLabel = (label: string) => label.replace(/EMP-\d{3}/g, (id) => STAFF.some((s) => s.id === id) ? staffById(id).name : id);

/** 決まり（回数・並び・人数・そろえ方）を頼む言葉か。特定の人の特定の日のマスを動かす言葉は除く */
const RULE_RX = /(月|週)\s*[0-9０-９一二三四五六七八九十]+\s*(回|日)|回(まで|以上|以下|以内)|連続|続けて|連勤|しないで|ないように|入れないで|土日とも|そろえ|差を|差は|平等|均等|毎回|毎週|毎月|必ず|人以上|人まで|人以下|人以内/;
export const isRuleLike = (t: string, hasPersonAndDate: boolean) => RULE_RX.test(t) && !hasPersonAndDate;

export async function translateRule(text: string, month: string, current?: Record<string, string[]>): Promise<TranslateRes> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(`${SOLVER}/api/v1/rules/translate-inline`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ text: pseudonymize(text).slice(0, 300), month, staff: ruleStaff(), ...(current ? { current } : {}) }),
    });
    if (r.ok) return (await r.json()) as TranslateRes;
    let m = ''; try { const j = (await r.json()) as { error?: string; detail?: unknown }; m = j.error ?? (typeof j.detail === 'string' ? j.detail : ''); } catch { /* 本文なし */ }
    if (r.status === 429) throw new RuleError(m || 'AI の利用上限に達しました。しばらくしてからお試しください');
    if (r.status === 422) throw new RuleError(m || 'ルールの形にできませんでした。言い方を変えてお試しください');
    throw new RuleError(m || `AI につながりませんでした（${r.status}）`);
  } catch (e) {
    if (e instanceof RuleError) throw e;
    throw new RuleError('AI につながりませんでした。ネットワークを確認して、もう一度お試しください');
  } finally { clearTimeout(timer); }
}
