import {
  NeedByWeekdaySetup,
  NeedPerShiftSetup,
  ShiftId,
  ShiftTimeSetup,
  WeekdayCounts,
} from '../types';
import { SETUP_USAGE, usageChipLabel } from '../usage';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function clampCount(value: number): number {
  return Math.max(0, Math.min(20, Math.round(value)));
}

function defaultWeekRow(baseCount: number): WeekdayCounts {
  const v = clampCount(baseCount);
  return [v, v, v, v, v, v, v];
}

export function Step3Need({
  data,
  useWeekdayNeed,
  needByWeekday,
  shifts,
  unitCount,
  onChange,
  onChangeWeekday,
  onAlignAllToUnits,
}: {
  data: NeedPerShiftSetup;
  useWeekdayNeed: boolean;
  needByWeekday: NeedByWeekdaySetup;
  shifts: ShiftTimeSetup[];
  unitCount: number;
  onChange: (data: NeedPerShiftSetup) => void;
  onChangeWeekday: (useWeekday: boolean, map: NeedByWeekdaySetup) => void;
  onAlignAllToUnits: (target: number) => void;
}) {
  const enabledShifts = shifts.filter((s) => s.enabled);
  const countableShifts = enabledShifts.filter((s) => s.counts !== false);
  const nonCountShifts = shifts.filter((s) => !s.enabled || s.counts === false);

  const setCount = (shiftId: ShiftId, value: number) => {
    onChange({ ...data, [shiftId]: clampCount(value) });
  };

  const weekdayRowFor = (shift: ShiftTimeSetup): WeekdayCounts => {
    if (!shift.enabled || shift.counts === false) return [0, 0, 0, 0, 0, 0, 0];
    return needByWeekday[shift.id] ?? defaultWeekRow(data[shift.id] ?? 0);
  };

  const handleToggleWeekdayMode = (checked: boolean) => {
    if (checked) {
      const next: NeedByWeekdaySetup = { ...needByWeekday };
      for (const s of countableShifts) {
        if (!next[s.id]) {
          next[s.id] = defaultWeekRow(data[s.id] ?? 0);
        }
      }
      onChangeWeekday(true, next);
    } else {
      onChangeWeekday(false, needByWeekday);
    }
  };

  const setWeekdayCell = (shift: ShiftTimeSetup, wdIdx: number, value: number) => {
    const row = [...weekdayRowFor(shift)] as WeekdayCounts;
    row[wdIdx] = clampCount(value);
    onChangeWeekday(true, { ...needByWeekday, [shift.id]: row });
  };

  const handleAlignToUnits = () => {
    const target = Math.max(1, Math.min(20, unitCount));
    onAlignAllToUnits(target);
  };

  const totalPerDay = countableShifts.reduce(
    (sum, s) => sum + (data[s.id] ?? 0),
    0
  );

  const weekdayTotals = WEEKDAYS.map((_, wdIdx) =>
    countableShifts.reduce((sum, s) => sum + weekdayRowFor(s)[wdIdx], 0)
  );
  const weekdayMin = weekdayTotals.length > 0 ? Math.min(...weekdayTotals) : 0;
  const weekdayMax = weekdayTotals.length > 0 ? Math.max(...weekdayTotals) : 0;
  const isAllZero = useWeekdayNeed ? weekdayMax === 0 : totalPerDay === 0;

  return (
    <div>
      <div className="step-head-row">
        <h2>毎日の必要人数を教えてください</h2>
        {!SETUP_USAGE.needPerShift && (
          <span className="chip-muted">{usageChipLabel(false)}</span>
        )}
      </div>
      <p className="setup-description">
        {SETUP_USAGE.needPerShift
          ? 'それぞれの勤務帯に、1日あたり何人の職員が必要かを設定します（0〜20人）。シフト作成では、この人数ちょうどになるように割り当てます。'
          : 'それぞれの勤務帯に、1日あたり何人の職員が必要かを設定します（0〜20人）。シフト作成につないだあとは、この人数ちょうどになるように割り当てます。いまはまだ使っていません。'}
      </p>

      <div className="notice-box">
        <strong>仮の人数が入っています</strong><br />
        施設の実態に合わせて直してください。
      </div>

      <div className="need-mode-bar">
        <div className="need-mode-left">
          <label className="shift-toggle-label">
            <input
              type="checkbox"
              className="shift-toggle-input"
              checked={useWeekdayNeed}
              onChange={(e) => handleToggleWeekdayMode((e.target as HTMLInputElement).checked)}
            />
            <span className="shift-toggle-track" aria-hidden="true">
              <span className="shift-toggle-thumb" />
            </span>
            <span className="need-mode-title">曜日で変える</span>
          </label>
          {!SETUP_USAGE.needByWeekday && (
            <span className="chip-muted">{usageChipLabel(false)}</span>
          )}
        </div>
        <span className="need-mode-hint">
          {useWeekdayNeed
            ? '曜日の列ごとに人数を直せます。祝日は「日曜」と同じ人数になります。'
            : 'いまは全曜日同じ人数です。土日だけ少なくしたいときなどに開きます。'}
        </span>
      </div>

      {!useWeekdayNeed ? (
        <div className="need-list">
          {shifts.map((shift) => {
            const isCountable = shift.enabled && shift.counts !== false;
            const count = isCountable ? (data[shift.id] ?? 0) : 0;
            const crossesMidnight =
              shift.endTime <= shift.startTime && shift.endTime !== '24:00';

            return (
              <div
                key={shift.id}
                className={`need-row ${isCountable ? '' : 'disabled'}`}
              >
                <div className="need-row-info">
                  <div className="need-row-title">
                    <span className="need-shift-name">{shift.name || shift.id}</span>
                    {!shift.enabled ? (
                      <span className="chip-muted">前の画面で「使わない」設定</span>
                    ) : shift.counts === false ? (
                      <span className="chip-muted">人数に数えない設定</span>
                    ) : null}
                  </div>
                  <span className="need-shift-time">
                    {isCountable
                      ? `${shift.startTime} 〜 ${shift.endTime}${crossesMidnight ? '（翌日）' : ''}`
                      : '必要人数には数えません（0人で固定）'}
                  </span>
                </div>

                <div className="need-stepper">
                  <button
                    type="button"
                    className="stepper-btn"
                    disabled={!isCountable || count <= 0}
                    onClick={() => setCount(shift.id, count - 1)}
                    aria-label={`${shift.name || shift.id}の人数を1減らす`}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    className="need-input"
                    value={count}
                    disabled={!isCountable}
                    aria-label={`${shift.name || shift.id}の必要人数`}
                    onInput={(e) => {
                      const n = parseInt((e.target as HTMLInputElement).value, 10);
                      setCount(shift.id, Number.isNaN(n) ? 0 : n);
                    }}
                  />
                  <span className="need-unit-label">人</span>
                  <button
                    type="button"
                    className="stepper-btn"
                    disabled={!isCountable || count >= 20}
                    onClick={() => setCount(shift.id, count + 1)}
                    aria-label={`${shift.name || shift.id}の人数を1増やす`}
                  >
                    ＋
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : countableShifts.length === 0 ? (
        <div className="empty-inline">
          前の画面で人数に数える勤務の種類が選ばれていません（「勤務の種類」で1つ以上オンにしてください）。
        </div>
      ) : (
        <div className="need-weekday-section">
          <div className="need-weekday-wrap">
            <table className="need-weekday-table">
              <thead>
                <tr>
                  <th className="need-wd-shift-col">勤務の種類</th>
                  {WEEKDAYS.map((w, idx) => (
                    <th
                      key={w}
                      className={`need-wd-col ${idx === 0 ? 'wd-sun' : idx === 6 ? 'wd-sat' : ''}`}
                    >
                      {w}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {countableShifts.map((shift) => {
                  const row = weekdayRowFor(shift);
                  return (
                    <tr key={shift.id}>
                      <th scope="row" className="need-wd-shift-cell">
                        <span className="need-wd-shift-name">{shift.name || shift.id}</span>
                      </th>
                      {WEEKDAYS.map((w, wdIdx) => (
                        <td key={w} className="need-wd-cell">
                          <input
                            type="number"
                            min={0}
                            max={20}
                            className="need-weekday-input"
                            value={row[wdIdx]}
                            aria-label={`${shift.name || shift.id} ${w}曜日の必要人数`}
                            onInput={(e) => {
                              const n = parseInt((e.target as HTMLInputElement).value, 10);
                              setWeekdayCell(shift, wdIdx, Number.isNaN(n) ? 0 : n);
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="need-weekday-total-row">
                  <th scope="row">合計</th>
                  {weekdayTotals.map((tot, wdIdx) => (
                    <td key={WEEKDAYS[wdIdx]} className="need-wd-total-cell">
                      <strong>{tot}</strong>人
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          {nonCountShifts.length > 0 && (
            <p className="table-hint-below">
              ※ 前の画面で「使わない」または「人数に数えない」設定の勤務（{nonCountShifts.map((s) => s.name || s.id).join('・')}）は対象外になります。
            </p>
          )}
        </div>
      )}

      <div className="need-summary-bar">
        <div className="need-total">
          {useWeekdayNeed ? (
            weekdayMin === weekdayMax ? (
              <>
                1日あたりの合計必要人数: <strong>{weekdayMin}</strong>人
              </>
            ) : (
              <>
                1日あたりの合計必要人数: <strong>{weekdayMin}〜{weekdayMax}</strong>人
              </>
            )
          ) : (
            <>
              1日あたりの合計必要人数: <strong>{totalPerDay}</strong>人
            </>
          )}
        </div>
        {unitCount > 0 && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={handleAlignToUnits}
          >
            {useWeekdayNeed
              ? `使う勤務帯の全曜日を ${unitCount}人（ユニット数）にそろえる`
              : `使う勤務帯をすべて ${unitCount}人（ユニット数）にそろえる`}
          </button>
        )}
      </div>

      {countableShifts.length > 0 && isAllZero && (
        <div className="notice-warn">
          {useWeekdayNeed
            ? 'すべての曜日で合計必要人数が0人になっています。このまま先に進むこともできますが、シフトを作るにはいずれかの勤務帯・曜日に1人以上を設定してください。'
            : '1日の合計必要人数が0人になっています。このまま先に進むこともできますが、シフトを作るにはいずれかの勤務帯に1人以上を設定してください。'}
        </div>
      )}
    </div>
  );
}
