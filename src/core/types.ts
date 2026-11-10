export type ShiftCode = '早番' | '日勤' | '遅番' | '夜勤';
export type SkillId =
  | 'medical' // 医療的ケア（喀痰吸引・経管栄養：研修修了・要件確認済み）
  | 'dementia' // 認知症ケア
  | 'bath' // 入浴介助
  | 'swallow' // 食事介助（嚥下配慮）
  | 'driver' // 送迎（運転）
  | 'terminal' // 看取りケア
  | 'follow' // フォロー・リーダー補助
  | 'night' // 夜勤可
  | 'ict' // 記録・ICT
  | 'preceptor'; // 新人指導

export type TaskKind =
  | 'handover' | 'wake' | 'meal' | 'excretion' | 'bath' | 'med' | 'medical'
  | 'round' | 'record' | 'rec' | 'transport' | 'laundry' | 'bed' | 'watch' | 'break' | 'nap';

export interface Unit { id: string; name: string; floor: 1 | 2; capacity: number; }

export interface Staff {
  id: string; name: string; kana: string; age: number; years: number;
  role: '介護福祉士' | '介護職員' | '主任' | '新人';
  employment: '常勤' | 'パート';
  license: string;
  skills: SkillId[];
  shifts: ShiftCode[]; // 勤務可能な勤務帯
  homeUnit: string;
  leaveBy?: string; // 退勤上限 "18:00"
  leaveReason?: string;
  breakPref?: string; // 休憩希望
  isLeader?: boolean;
  phone: string; // 架空
}

export type Adl = '自立' | '見守り' | '一部介助' | '全介助';
export interface Resident {
  id: string; name: string; age: number; sex: '男性' | '女性'; room: string; unitId: string;
  careLevel: 1 | 2 | 3 | 4 | 5;
  adl: { meal: Adl; excretion: Adl; bath: Adl; transfer: Adl };
  medical: string[]; // 医療的ケア
  notes: string[]; // 注意点
  fallRisk: 'low' | 'mid' | 'high';
  nightCheck: string; // 夜間巡回の目安
}

export interface Assignment {
  id: string; date: string; staffId: string; shift: ShiftCode; unitId: string;
  status: 'assigned' | 'absent' | 'late' | 'early';
  note?: string; source?: 'base' | 'ai' | 'leader' | 'offer';
  covered?: boolean; // 欠勤だが、時間のずらし等の調整で対応済み
  adjust?: { breakAt?: number; startAt?: number; endAt?: number; support?: { unitId: string; from: number; to: number }; swaps?: { from: number; to: number }[] };
  lateMin?: number; // 遅刻分（late）
  earlyAt?: string; // 早退時刻（early）
}

export interface Applicant { id: string; staffId: string; name: string; skills: SkillId[]; years: number; license: string; ok: boolean; missing: SkillId[]; note: string }
export type VacancyState = 'open' | 'offering' | 'posted' | 'applied' | 'filled';
export interface Vacancy {
  id: string; // VAC-yyyymmdd-Xnn
  date: string; shift: ShiftCode; unitId: string;
  needSkills: SkillId[];
  reason: string;
  state: VacancyState;
  offers: { staffId: string; at: string; status: 'pending' | 'accepted' | 'declined' | 'expired' }[];
  jobPost?: { reward: string; postedAt?: string; text?: string; status?: 'draft' | 'posted' };
  opts?: Partial<AutopilotSettings>; // この欠員だけの詳細設定（全体の設定を上書き）
  kind?: 'absence' | 'gap'; // gap = 遅刻・早退で手薄になる時間の応援依頼
  auto?: AutoState;
  applicant?: Applicant;
  applicants?: Applicant[];
  resolvedBy?: 'adjust';
  resolution?: { kind: 'adjust' | 'offer' | 'applicant' | 'leader'; at: string; staffId?: string; title?: string; changes?: { assignmentId: string; staffId: string; text: string }[] };
  filledBy?: string;
  fromAssignmentId?: string;
}

export interface AutopilotSettings {
  enabled: boolean; maxCandidates: number; waitSameDay: number; waitOther: number; quietStart: string; quietEnd: string; defaultReward: string;
  useAdjust: boolean; autoPost?: boolean; adjustKinds: { break: boolean; support: boolean; extend: boolean };
  priority: { availFirst: boolean; skill: 'low' | 'normal' | 'high'; days: 'low' | 'normal' | 'high' };
  jobNote: string;
}
export interface AutoState {
  mode: 'ask' | 'running' | 'paused' | 'waiting_adjust' | 'waiting_post' | 'posted' | 'manual' | 'done'; planId?: string;
  queue: string[]; idx: number; max: number; waitMin?: number;
  waitUntil?: string; pendingStaff?: string; // 夜間のため送信待ちの職員
  log: { at: string; text: string; kind: 'info' | 'offer' | 'ok' | 'warn' }[];
  prob?: Record<string, number>; // 学習済みモデルによる応諾の見込み（0〜1）。API が使えたときだけ入る
  reasonAi?: Record<string, string>; // Gemini が書いた候補ごとの理由（1文）。API が使えたときだけ入る（順番には関係しない）
  replan?: ReplanVerdict; // 欠員の日だけの最小変更の組み直し（CP-SAT, POST /api/v1/replan-inline）。API が答えたときだけ入る
  replanUse?: 'check' | 'plan'; // check=画面の案のまま確認結果だけ表示 / plan=ソルバーの組み直しを案として出した
}
/** ソルバーの組み直し結果（src/core/apireplan.ts が検証済み） */
export interface ReplanVerdict { status: string; ok: boolean; wallMs: number; minimal: boolean; changes: { staffId: string; from: ShiftCode | ''; to: ShiftCode | '' }[]; filledBy: string[]; relax: string[]; at: string }
export type RequestKind = '休み' | '遅刻' | '早退' | 'シフト変更' | '希望休';
export interface ShiftRequest {
  id: string; staffId: string; date: string; kind: RequestKind;
  detail?: string; reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'auto';
  via: 'form' | 'ai' | 'chat';
  createdAt: string;
  impact?: string;
}

export type ThreadId = string; // 'ai' | 'leader' | 'shift:早番' | 'unit:U1' | 'all'
export interface ChatMessage {
  id: string; thread: ThreadId; from: string; // staffId | 'leader' | 'ai'
  text: string; at: string;
  proposal?: AiProposal; // AIの構造化案
  links?: { label: string; target: string }[]; // リーダー向け：開く画面へのリンク
  action?: { kind: string; args: Record<string, unknown>; label: string; detail: string; state: 'proposed' | 'done' | 'cancelled' }; // リーダー向け：実行前の確認カード
  offer?: { vacancyId: string }; // 代わりの出勤の打診（入れる/見送るを会話内で返信）
  attachments?: { name: string; type: string; url: string }[]; // 写真などの添付（端末内のみ）
}

export interface AiProposal {
  id: string; raw: string;
  items: AiItem[];
  state: 'draft' | 'applied' | 'review' | 'cancelled' | 'undone';
  undo?: { assignments: Assignment[]; addedVacancyIds: string[]; prefs?: { breakPref?: string; leaveBy?: string; leaveReason?: string; shiftHope: ShiftCode[] }; requestIds: string[] };
  summary: string;
}
export interface AiItem {
  type: 'request' | 'prefs' | 'avail' | 'dayoff' | 'unknown';
  avail?: { date: string; shifts: ShiftCode[] };
  kind?: RequestKind; date?: string; reason?: string; detail?: string;
  prefs?: Partial<{ breakPref: string; leaveBy: string; leaveReason: string; shiftHope: ShiftCode[] }>;
  normalized: string; // 正規化後の一行
  impact?: string; // 影響チェック
  needsApproval?: boolean;
  requestId?: string; // 反映後に作られた申請ID（進み具合の表示用）
  before?: string; after?: string; // 反映前後の比較表示用
}

export interface Notice {
  id: string; to: string; // staffId | 'leader'
  title: string; body: string; at: string; read: boolean;
  kind: 'info' | 'offer' | 'request' | 'health' | 'shift' | 'autopilot';
  link?: string;
}

export interface HealthCheck {
  id: string; staffId: string; date: string; at: string;
  temp: number; symptoms: string[]; household: string; sleep: '十分' | 'やや不足' | '不足'; note?: string;
  consult: boolean;
}

export interface TaskBlock { start: number; end: number; kind: TaskKind; label: string; unitId?: string; }
export interface DayRow { staff: Staff; assignment: Assignment; blocks: TaskBlock[]; tail?: boolean; }
export interface CoverageIssue {
  t0: number; t1: number; scope: string; need: number; have: number;
  kind: 'headcount' | 'skill'; text: string;
}
