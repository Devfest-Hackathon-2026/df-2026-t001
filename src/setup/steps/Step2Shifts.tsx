import { useRef } from 'preact/hooks';
import {
  inferNextDay,
  inferShiftGroup,
  normalizeShiftItem,
} from '../defaults';
import { NextDayKindJa, ShiftGroupJa, ShiftTimeSetup } from '../types';
import { SETUP_USAGE, usageChipLabel } from '../usage';

const MAX_SHIFTS = 12;
const RESERVED_IDS = new Set(['休', '有給', 'paid', 'off', '勤務', '']);

export function Step2Shifts({
  data,
  onChange,
  onApplyPreset,
  onRenameId,
}: {
  data: ShiftTimeSetup[];
  onChange: (data: ShiftTimeSetup[]) => void;
  onApplyPreset?: (preset: '2shift' | '3shift') => void;
  onRenameId?: (oldId: string, newId: string) => void;
}) {
  const rowKeysRef = useRef<string[]>([]);
  if (rowKeysRef.current.length !== data.length) {
    rowKeysRef.current = data.map((s, idx) => rowKeysRef.current[idx] ?? `row-${idx}-${s.id}`);
  }

  const normalized = data.map(normalizeShiftItem);

  const updateRow = (index: number, patch: Partial<ShiftTimeSetup>) => {
    onChange(
      data.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    );
  };

  const handleToggle = (index: number, enabled: boolean) => {
    updateRow(index, { enabled });
  };

  const handleTimeChange = (
    index: number,
    field: 'startTime' | 'endTime',
    value: string
  ) => {
    const cur = normalized[index];
    const nextStart = field === 'startTime' ? value : cur.startTime;
    const nextEnd = field === 'endTime' ? value : cur.endTime;
    updateRow(index, {
      [field]: value,
      nextDay: inferNextDay(nextStart, nextEnd),
    });
  };

  const handleIdChange = (index: number, raw: string) => {
    const oldId = data[index].id;
    const newId = raw.slice(0, 4);
    const trimmed = newId.trim();
    const isDuplicate =
      trimmed !== '' &&
      data.some((s, idx) => idx !== index && s.id.trim() === trimmed);

    const cur = normalized[index];
    const patch: Partial<ShiftTimeSetup> = { id: newId };
    if (cur.name === oldId || cur.name === '') {
      patch.name = newId;
    }
    if (cur.short === oldId.slice(0, 2) || cur.short === '') {
      patch.short = newId.slice(0, 2);
    }
    updateRow(index, patch);
    if (
      onRenameId &&
      oldId &&
      trimmed &&
      oldId !== trimmed &&
      !isDuplicate &&
      !RESERVED_IDS.has(trimmed)
    ) {
      onRenameId(oldId, trimmed);
    }
  };

  const handleAddRow = () => {
    if (data.length >= MAX_SHIFTS) return;
    const used = new Set(data.map((d) => d.id.trim()));
    let n = 1;
    let newId = `勤${n}`;
    while (used.has(newId)) {
      n += 1;
      newId = `勤${n}`;
    }
    rowKeysRef.current = [...rowKeysRef.current, `row-${Date.now()}-${n}`];
    const startTime = '09:00';
    const endTime = '17:00';
    onChange([
      ...data,
      {
        id: newId,
        name: `勤務${n}`,
        short: newId.slice(0, 2),
        enabled: true,
        startTime,
        endTime,
        group: inferShiftGroup(newId, startTime, endTime),
        counts: true,
        nextDay: 'なし',
      },
    ]);
  };

  const handleRemoveRow = (index: number) => {
    if (data.length <= 1) return;
    rowKeysRef.current = rowKeysRef.current.filter((_, idx) => idx !== index);
    onChange(data.filter((_, idx) => idx !== index));
  };

  const enabledCount = normalized.filter((s) => s.enabled).length;
  const idCounts = new Map<string, number>();
  for (const s of data) {
    const k = s.id.trim();
    idCounts.set(k, (idCounts.get(k) ?? 0) + 1);
  }
  const hasInvalidId = data.some((s) => {
    const k = s.id.trim();
    return RESERVED_IDS.has(k) || (idCounts.get(k) ?? 0) > 1;
  });

  const is2Shift =
    data.length === 4 &&
    data.map((d) => d.id).join(',') === '早番,日勤,遅番,夜勤';
  const is3Shift =
    data.length === 3 &&
    data.map((d) => d.id).join(',') === '日,準,深';

  return (
    <div>
      <div className="step-head-row">
        <h2>使う勤務の種類と時刻を教えてください</h2>
        {!SETUP_USAGE.shifts && (
          <span className="chip-muted">{usageChipLabel(false)}</span>
        )}
      </div>
      <p className="setup-description">
        施設にある勤務の種類を最大{MAX_SHIFTS}個まで設定できます（使わない種類はオフにできます）。「翌日は明け」をオンにした勤務の翌日は休みになり、「夜勤の仲間」に選んだ勤務は夜勤の回数上限などでまとめて数えます。
      </p>

      <div className="notice-box">
        <strong>時刻・分け方の見かた（仮の値が入っています）</strong><br />
        {SETUP_USAGE.shifts
          ? '「人数に数える」を外すと、研修や見学など毎日の必要人数に含めない勤務として扱えます。終了が翌日5:00より後の勤務は「翌日は明け」が自動で入ります。'
          : '「人数に数える」を外すと研修など必要人数に数えない勤務にでき、終了が翌日5:00より後の勤務は「翌日は明け」が自動で入ります。いまはまだどの設定もシフト作成には使っていません。'}
      </div>

      <div className="staff-toolbar">
        <div className="preset-bar">
          <span className="preset-label">雛形から入れる：</span>
          <button
            type="button"
            className={`btn btn-outline btn-sm preset-btn ${is2Shift ? 'active' : ''}`}
            onClick={() => onApplyPreset?.('2shift')}
          >
            2交代（4区分）
          </button>
          <button
            type="button"
            className={`btn btn-outline btn-sm preset-btn ${is3Shift ? 'active' : ''}`}
            onClick={() => onApplyPreset?.('3shift')}
          >
            3交代（日・準・深）
          </button>
        </div>

        <div className="staff-toolbar-actions">
          <span className="chip-muted">
            {data.length} / {MAX_SHIFTS} 種類
          </span>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={data.length >= MAX_SHIFTS}
            onClick={handleAddRow}
          >
            ＋ 勤務の種類を足す
          </button>
        </div>
      </div>

      <div className="table-scroll">
        <table className="setup-table shift-table">
          <thead>
            <tr>
              <th>使う</th>
              <th>記号（1〜4文字）</th>
              <th>名前</th>
              <th>開始</th>
              <th>終了</th>
              <th>勤務のグループ</th>
              <th>人数に数える</th>
              <th>翌日は明け</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {normalized.map((shift, idx) => {
              const rawId = data[idx].id;
              const trimmedId = rawId.trim();
              const idErr =
                trimmedId === ''
                  ? '記号を入れてください'
                  : RESERVED_IDS.has(trimmedId)
                    ? `「${trimmedId}」は使えません`
                    : (idCounts.get(trimmedId) ?? 0) > 1
                      ? '同じ記号があります'
                      : '';
              const nextDayHint =
                shift.endTime <= shift.startTime && shift.endTime !== '24:00'
                  ? '（翌日）'
                  : '';

              return (
                <tr
                  key={rowKeysRef.current[idx] ?? idx}
                  className={shift.enabled ? '' : 'shift-row-off'}
                >
                  <td>
                    <label className="shift-toggle-label shift-toggle-compact">
                      <input
                        type="checkbox"
                        className="shift-toggle-input"
                        checked={shift.enabled}
                        aria-label={`${shift.name || rawId}を使う`}
                        onChange={(e) =>
                          handleToggle(idx, (e.target as HTMLInputElement).checked)
                        }
                      />
                      <span className="shift-toggle-track" aria-hidden="true">
                        <span className="shift-toggle-thumb" />
                      </span>
                    </label>
                  </td>
                  <td>
                    <input
                      type="text"
                      maxLength={4}
                      className={`cell-input shift-id-input ${idErr ? 'has-error' : ''}`}
                      value={rawId}
                      placeholder="例: 日"
                      aria-label={`${idx + 1}行目の記号`}
                      onInput={(e) =>
                        handleIdChange(idx, (e.target as HTMLInputElement).value)
                      }
                    />
                    {idErr && <div className="staff-row-warn">{idErr}</div>}
                  </td>
                  <td>
                    <input
                      type="text"
                      maxLength={12}
                      className="cell-input shift-name-input"
                      value={data[idx].name}
                      placeholder="例: 日勤"
                      aria-label={`${idx + 1}行目の名前`}
                      onInput={(e) =>
                        updateRow(idx, {
                          name: (e.target as HTMLInputElement).value,
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      className="cell-input shift-time-cell"
                      value={shift.startTime}
                      disabled={!shift.enabled}
                      aria-label={`${shift.name}の開始時刻`}
                      onInput={(e) =>
                        handleTimeChange(
                          idx,
                          'startTime',
                          (e.target as HTMLInputElement).value
                        )
                      }
                    />
                  </td>
                  <td>
                    <div className="shift-end-wrap">
                      <input
                        type="time"
                        className="cell-input shift-time-cell"
                        value={shift.endTime}
                        disabled={!shift.enabled}
                        aria-label={`${shift.name}の終了時刻`}
                        onInput={(e) =>
                          handleTimeChange(
                            idx,
                            'endTime',
                            (e.target as HTMLInputElement).value
                          )
                        }
                      />
                      {nextDayHint && (
                        <span className="shift-next-hint">{nextDayHint}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <select
                      className="cell-select"
                      value={shift.group}
                      disabled={!shift.enabled}
                      aria-label={`${shift.name}の勤務のグループ`}
                      onChange={(e) =>
                        updateRow(idx, {
                          group: (e.target as HTMLSelectElement)
                            .value as ShiftGroupJa,
                        })
                      }
                    >
                      <option value="日勤系">日勤系</option>
                      <option value="夜勤系">夜勤の仲間</option>
                      <option value="その他">その他</option>
                    </select>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <label className="cell-checkbox-label">
                      <input
                        type="checkbox"
                        checked={shift.counts}
                        disabled={!shift.enabled}
                        aria-label={`${shift.name}を人数に数える`}
                        onChange={(e) =>
                          updateRow(idx, {
                            counts: (e.target as HTMLInputElement).checked,
                          })
                        }
                      />
                      <span>数える</span>
                    </label>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <label className="cell-checkbox-label">
                      <input
                        type="checkbox"
                        checked={shift.nextDay === '明け'}
                        disabled={!shift.enabled}
                        aria-label={`${shift.name}の翌日は明け`}
                        onChange={(e) =>
                          updateRow(idx, {
                            nextDay: ((e.target as HTMLInputElement).checked
                              ? '明け'
                              : 'なし') as NextDayKindJa,
                          })
                        }
                      />
                      <span>明け</span>
                    </label>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="cell-remove-btn"
                      disabled={data.length <= 1}
                      aria-label={`${shift.name || rawId}を削除`}
                      onClick={() => handleRemoveRow(idx)}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasInvalidId && (
        <div className="notice-warn">
          勤務の記号が空欄、重複、または「休」「有給」「勤務」などの予約語になっています。別の1〜4文字の記号に変えてください。
        </div>
      )}

      {enabledCount === 0 && (
        <div className="notice-warn">
          使う勤務の種類が1つも選ばれていません。このまま先に進むこともできますが、シフトを作るには1つ以上が必要です（あとで戻って選べます）。
        </div>
      )}
    </div>
  );
}
