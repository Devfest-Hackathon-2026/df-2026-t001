// care-solver-api（CP-SAT・欠員の候補・Gemini・学習）のクライアント。ブラウザから Cloud Run に直接（CORS）呼ぶ。
// 既存の /api/**（care-api）とは別のサービス。公開デモのため認証は無く、レート制限・利用上限がサーバー側で効く。
// 既定は本番の Cloud Run。VITE_SOLVER_URL はローカル開発・scripts/check 用の上書き。
// 注意：Firebase Hosting の CSP（firebase.json の connect-src）は既定の URL だけを許可しているため、
// 別の宛先でビルドして Hosting に載せる場合は connect-src も合わせて変えること。
// （import.meta.env が無い node 実行でも落ちないよう ?. で読む）
export const SOLVER = (import.meta.env?.VITE_SOLVER_URL as string | undefined) ?? 'https://care-solver-api-h5p5nqo3qa-an.a.run.app';

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}

async function req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${SOLVER}${path}`, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'サーバーに接続できません。ネットワークを確認してください');
  }
  let data: unknown = null;
  try { data = await r.json(); } catch { /* 本文なし */ }
  if (!r.ok) {
    const msg = (data as { error?: string } | null)?.error ?? (Array.isArray((data as { detail?: unknown } | null)?.detail) ? '入力の形が正しくありません' : `エラー（${r.status}）`);
    throw new ApiError(r.status, msg, Number(r.headers.get('Retry-After')) || undefined);
  }
  return data as T;
}
export const get = <T,>(path: string) => req<T>('GET', path);
export const post = <T,>(path: string, body: unknown = {}) => req<T>('POST', path, body);

export const errText = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.status === 429) return `${e.message}${e.retryAfter ? `（約${e.retryAfter}秒後に再試行できます）` : ''}`;
    if (e.status === 503) return `${e.message}（少し待って、もう一度お試しください）`;
    return e.message;
  }
  return '予期しないエラーが起きました';
};

export const FACILITIES = [
  { id: 'fac-sakura', name: 'さくら苑', kind: '特別養護老人ホーム', note: '34名・4ユニット' },
  { id: 'fac-midori', name: 'みどりの丘', kind: '住宅型有料老人ホーム', note: '22名・3ユニット' },
  { id: 'fac-hidamari', name: 'ひだまりの家', kind: 'グループホーム', note: '16名・2ユニット' },
] as const;
export const MONTHS = ['2026-11', '2026-12'] as const;
export const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ---- 型（使う項目だけ）
export interface StaffM { staff_id: string; name: string; role: string; employment: string; skills: string[]; shifts: string[]; home_unit: string | null; years: number }
export interface FacilityDetail { facility_id: string; name: string; need_per_shift: Record<string, number>; staff: StaffM[] }
export interface RosterRes { facility_id: string; month: string; days: number; first_weekday: number; proposal_id: string | null; base: Record<string, string[]>; current: Record<string, string[]>; edits: number }
export interface Broken { rule_id: string; label: string; count: number; detail?: string[]; strength?: string }
export interface SolveRes {
  status: string; wall_ms: number; explanation: string[]; proposal_id?: string; unmet_total?: number;
  iterations?: { n: number; monthly_ms: number; daily_ms: number; unmet: number }[]; soft_broken?: Broken[]; relaxation?: Broken[];
}
export interface VerifyRes { ok: boolean; proposal_id: string | null; broken: Broken[] }
export interface DailyItem { kind: 'task' | 'break'; task: string; start: string; end: string }
export interface DailyRes {
  status: string; wall_ms: number; switches: number; explanation: string[];
  staff: { staff_id: string; name: string; shift: string; carried_from_previous_night: boolean; items: DailyItem[] }[];
  unmet: { task: string; label: string; cause: string }[];
}
export interface Cand { staff_id: string; name: string; score: number; reasons: string[]; accept_probability: number | null; rank_score?: number }
export interface VacancyRes { vacancy: { vacancy_id: string; date: string; shift: string; state: string; filled_by: string | null }; candidates: Cand[]; excluded: { staff_id: string; name: string; reason: string }[] }
export interface OfferRes { offer_id: string; staff_id: string; status: string; features?: Record<string, number | string | boolean> }
export interface ModelInfo {
  using_model: boolean; note: string | null;
  champion: { version: string; kind: string; rows: number; auc: number | null; logloss_gain: number | null; trained_at: string; compared: Record<string, { auc: number; logloss: number }>; gate?: { passed: boolean; reasons: string[] } } | null;
  history: { version: string; rows: number; live_rows?: number; kind: string; auc: number | null; gate_passed: boolean; gate_reasons?: string[]; promoted: boolean; trained_at: string }[];
}
export interface Proposal { type: string; summary: string; action: { method: 'POST'; path: string; body: unknown }; preview: { new_rule_breaks?: { label: string; strength: string }[]; hard_break?: boolean; is_candidate?: boolean; reasons?: string[]; excluded_reason?: string | null }; executed: boolean }
export interface ChatRes { reply: string; proposals: Proposal[]; tool_trace: { tool: string; ok: boolean }[] }
export interface RuleCand { scope: string; label: string; strength: string; impact: { broken_now: number } | null; rule: Record<string, unknown> }
export interface TranslateRes { input: string; candidates: RuleCand[]; model: string }
export interface Learned {
  key: string; kind: string; name: string; evidence: string; question: string; repeated: number | null;
  choices: { label: string; rule: Record<string, unknown> }[]; impact?: { broken_now: number };
}
