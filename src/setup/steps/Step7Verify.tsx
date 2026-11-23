import { SetupState } from '../types';
import { allowedShiftsFor, MAX_INLINE_STAFF } from '../solverRequest';
import { isAllSetupUsed, isAnySetupUsed, SETUP_USAGE, usageChipLabel } from '../usage';

// S7: 入れた条件の確認だけをする画面。ここではシフトを作らない（ソルバーを呼ばない）。
export function Step7Verify({
  state,
  onJumpStep,
}: {
  state: SetupState;
  onJumpStep?: (step: number) => void;
}) {
  const enabledShifts = state.shifts.filter((s) => s.enabled);
  const countableShifts = enabledShifts.filter((s) => s.counts !== false);
  const nonCountShifts = enabledShifts.filter((s) => s.counts === false);
  const weekdayDayTotals = [0, 1, 2, 3, 4, 5, 6].map((wd) =>
    countableShifts.reduce((sum, s) => {
      const v = state.useWeekdayNeed
        ? (state.needByWeekday?.[s.id]?.[wd] ?? state.needPerShift[s.id] ?? 0)
        : (state.needPerShift[s.id] ?? 0);
      return sum + v;
    }, 0)
  );
  const totalNeedMin = countableShifts.length > 0 ? Math.min(...weekdayDayTotals) : 0;
  const totalNeedMax = countableShifts.length > 0 ? Math.max(...weekdayDayTotals) : 0;
  const fullCount = state.staff.filter((s) => s.employment === '常勤').length;
  const partCount = state.staff.filter((s) => s.employment === 'パート').length;
  const medCount = state.staff.filter((s) => s.canMedicalCare).length;
  const limitCount = state.staff.filter((s) => {
    const lim = s.limits;
    if (!lim) return false;
    if (lim.workDays && (lim.workDays.min != null || lim.workDays.max != null)) return true;
    return Object.values(lim.byShift ?? {}).some((r) => r && (r.min != null || r.max != null));
  }).length;
  const carryWorkCount = state.staff.filter((s) => {
    const seq = state.history?.[s.id];
    if (seq && seq.length > 0) return seq.some((v) => v && v !== '休');
    const c = state.carryIn[s.id];
    return c && c !== '休';
  }).length;
  // 入れる勤務帯が残らない職員（シフトに一度も入らない）
  const noShiftStaff = state.staff.filter((s) => allowedShiftsFor(s, state.shifts).length === 0);

  // シフトを作るのに最低限必要なもの
  const missingReasons: { text: string; step: number; btnLabel: string }[] = [];
  if (enabledShifts.length === 0) {
    missingReasons.push({
      text: '使う勤務帯が1つも選ばれていません。',
      step: 2,
      btnLabel: '勤務帯を直す',
    });
  }
  if (state.staff.length === 0) {
    missingReasons.push({
      text: '職員が1人も登録されていません。',
      step: 4,
      btnLabel: '職員を足す',
    });
  }
  if (countableShifts.length > 0 && totalNeedMax === 0) {
    missingReasons.push({
      text: '毎日の必要人数がすべて0人です。',
      step: 3,
      btnLabel: '人数を直す',
    });
  }

  const facilityUsed = SETUP_USAGE.facilityName || SETUP_USAGE.facilityKind || SETUP_USAGE.units;
  const shiftNeedUsed =
    SETUP_USAGE.shifts &&
    SETUP_USAGE.needPerShift &&
    (!state.useWeekdayNeed || SETUP_USAGE.needByWeekday);
  const staffUsed = SETUP_USAGE.staff && SETUP_USAGE.staffLimits;
  const rulesCarryUsed = SETUP_USAGE.rules && SETUP_USAGE.carryIn && SETUP_USAGE.history;
  const anyUsed = isAnySetupUsed();
  const allUsed = isAllSetupUsed();

  return (
    <div>
      <h2>入れた条件を確認してください</h2>
      <p className="setup-description">
        これまでに入れた条件のまとめです。気になる箇所があれば「直す」から戻れます。入力はこのブラウザに保存されています。
      </p>

      {/* 入力内容の要約 */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-card-head">
            <span className="summary-card-title">1. 施設とユニット</span>
            <div className="summary-card-actions">
              <span className="summary-usage-chip">{usageChipLabel(facilityUsed)}</span>
              {onJumpStep && (
                <button
                  type="button"
                  className="summary-edit-link"
                  onClick={() => onJumpStep(1)}
                >
                  直す
                </button>
              )}
            </div>
          </div>
          <div className="summary-card-value">
            {state.facility.name.trim() || '施設名未入力'}（ユニット {state.facility.units.length}件）
          </div>
          <div className="summary-card-sub">
            {state.facility.kind}
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-card-head">
            <span className="summary-card-title">2・3. 勤務帯と毎日の必要人数</span>
            <div className="summary-card-actions">
              <span className="summary-usage-chip">{usageChipLabel(shiftNeedUsed)}</span>
              {onJumpStep && (
                <button
                  type="button"
                  className="summary-edit-link"
                  onClick={() => onJumpStep(3)}
                >
                  直す
                </button>
              )}
            </div>
          </div>
          <div className="summary-card-value">
            {totalNeedMin === totalNeedMax
              ? `1日合計 ${totalNeedMin}人（使う勤務帯 ${enabledShifts.length}つ）`
              : `1日合計 ${totalNeedMin}〜${totalNeedMax}人（曜日別・使う勤務帯 ${enabledShifts.length}つ）`}
          </div>
          <div className="summary-card-sub">
            {countableShifts.length > 0
              ? countableShifts
                  .map((s) => {
                    if (!state.useWeekdayNeed || !state.needByWeekday?.[s.id]) {
                      return `${s.name} ${state.needPerShift[s.id] ?? 0}人`;
                    }
                    const row = state.needByWeekday[s.id]!;
                    const lo = Math.min(...row);
                    const hi = Math.max(...row);
                    return lo === hi ? `${s.name} ${lo}人` : `${s.name} ${lo}〜${hi}人`;
                  })
                  .join(' ／ ')
              : '人数に数える勤務がありません'}
            {nonCountShifts.length > 0 &&
              `（対象外：${nonCountShifts.map((s) => s.name || s.id).join('・')}）`}
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-card-head">
            <span className="summary-card-title">4. 職員の一覧</span>
            <div className="summary-card-actions">
              <span className="summary-usage-chip">{usageChipLabel(staffUsed)}</span>
              {onJumpStep && (
                <button
                  type="button"
                  className="summary-edit-link"
                  onClick={() => onJumpStep(4)}
                >
                  直す
                </button>
              )}
            </div>
          </div>
          <div className="summary-card-value">
            合計 {state.staff.length}人（常勤 {fullCount}人・パート {partCount}人）
          </div>
          <div className="summary-card-sub">
            医療的ケア可 {medCount}人{limitCount > 0 ? ` ／ 個人の回数指定 ${limitCount}人` : ''}
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-card-head">
            <span className="summary-card-title">5・6. 守ることと前月末</span>
            <div className="summary-card-actions">
              <span className="summary-usage-chip">{usageChipLabel(rulesCarryUsed)}</span>
              {onJumpStep && (
                <button
                  type="button"
                  className="summary-edit-link"
                  onClick={() => onJumpStep(5)}
                >
                  直す
                </button>
              )}
            </div>
          </div>
          <div className="summary-card-value">
            夜勤は月 {state.rules.nightMax}回まで
          </div>
          <div className="summary-card-sub">
            前月の最後の7日に勤務入力がある職員：{carryWorkCount}人
          </div>
        </div>
      </div>


      {missingReasons.length > 0 && (
        <div className="notice-warn">
          <strong>シフトを作るには、次が足りません</strong>
          <ul className="result-issue-list">
            {missingReasons.map((r, idx) => (
              <li key={idx}>
                {r.text}{' '}
                {onJumpStep && (
                  <button
                    type="button"
                    className="summary-edit-link"
                    onClick={() => onJumpStep(r.step)}
                  >
                    {r.btnLabel}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.staff.length > MAX_INLINE_STAFF && (
        <div className="notice-warn">
          <strong>職員が{state.staff.length}人登録されています（上限は{MAX_INLINE_STAFF}人です）</strong>。
          {MAX_INLINE_STAFF + 1}人目以降の{state.staff.length - MAX_INLINE_STAFF}人は作成に使いません。{' '}
          {onJumpStep && (
            <button
              type="button"
              className="summary-edit-link"
              onClick={() => onJumpStep(4)}
            >
              職員を直す
            </button>
          )}
        </div>
      )}

      {state.staff.length > 0 && noShiftStaff.length > 0 && (
        <div className="notice-warn">
          <strong>どの勤務にも入れない職員が{noShiftStaff.length}人います</strong>（
          {noShiftStaff.map((s) => s.name.trim() || `${state.staff.indexOf(s) + 1}人目の職員`).join('、')}
          ）。入れる勤務帯か退勤上限を見直さないと、シフトに一度も入りません。{' '}
          {onJumpStep && (
            <button
              type="button"
              className="summary-edit-link"
              onClick={() => onJumpStep(4)}
            >
              職員を直す
            </button>
          )}
        </div>
      )}

      <p className="rule-footnote">
        {!anyUsed
          ? 'いまの段階では、ここで入れた項目はまだリーダー画面やシフト作成には反映されていません。「リーダー画面へ」を押すと、仮のデータでリーダー画面が開きます。'
          : !allUsed
            ? '一部の項目はまだリーダー画面やシフト作成には反映されていません。'
            : '入力した条件はリーダー画面とシフト作成に反映されます。'}
      </p>
    </div>
  );
}
