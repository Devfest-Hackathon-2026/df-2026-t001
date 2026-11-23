/**
 * はじめの設定（setup.html）で入力した各項目が、
 * いまリーダー画面やシフト作成で使われているかどうかを1か所で管理する。
 *
 * 接続（WORKFLOW_setup_connect.md の C5〜C7）が入ったら、
 * 対応する項目を true に切り替えるだけで S0〜S7 とリーダー画面の表示が揃う。
 */
export const SETUP_USAGE = {
  facilityName: false,
  facilityKind: false,
  units: false,
  shifts: false,
  needPerShift: false,
  needByWeekday: false,
  staff: false,
  staffLimits: false,
  rules: false,
  carryIn: false,
  history: false,
} as const;

export type SetupUsageKey = keyof typeof SETUP_USAGE;

/** 1つでもリーダー画面・シフト作成に使われているか */
export function isAnySetupUsed(): boolean {
  return Object.values(SETUP_USAGE).some(Boolean);
}

/** すべての項目が使われているか */
export function isAllSetupUsed(): boolean {
  return Object.values(SETUP_USAGE).every(Boolean);
}

/** 項目ごとの状態チップ文言 */
export function usageChipLabel(used: boolean): string {
  return used ? '作成で使っています' : 'まだ使っていません';
}
