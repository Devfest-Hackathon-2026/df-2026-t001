import { useState } from 'preact/hooks';
import { normalizeShiftItem } from '../defaults';
import { CarryInSetup, HistorySetup, ShiftId, ShiftTimeSetup, StaffSetupItem } from '../types';
import { SETUP_USAGE, usageChipLabel } from '../usage';

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

interface PrevDayCol {
  dateShort: string;
  weekday: string;
  wdIdx: number;
  isLast: boolean;
}

function getPrevLast7Days(): {
  targetMonthLabel: string;
  cols: PrevDayCol[];
} {
  const now = new Date();
  const targetYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const targetMonth = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  const lastDay = new Date(targetYear, targetMonth - 1, 0);
  const cols: PrevDayCol[] = [];
  for (let offset = -6; offset <= 0; offset += 1) {
    const d = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + offset);
    cols.push({
      dateShort: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: WEEKDAY_JA[d.getDay()],
      wdIdx: d.getDay(),
      isLast: offset === 0,
    });
  }
  return {
    targetMonthLabel: `${targetYear}年${targetMonth}月`,
    cols,
  };
}

function normalizeSeq(seq: string[] | undefined, validShifts: Set<string>, fallbackLast?: string): string[] {
  if (seq && seq.length > 0) {
    const clipped = seq.slice(-7).map((v) => (validShifts.has(v) ? v : ''));
    while (clipped.length < 7) clipped.unshift('');
    return clipped;
  }
  const last = fallbackLast && validShifts.has(fallbackLast) ? fallbackLast : '';
  return ['', '', '', '', '', '', last];
}

function parseShiftToken(raw: string, enabledShifts: Required<ShiftTimeSetup>[]): string {
  const t = raw.trim();
  if (!t || t === '-' || t === 'ー' || t === '—' || t === '休' || t === '公' || t === '明' || t === '〇') {
    return '';
  }
  const exact = enabledShifts.find(
    (s) => s.id === t || s.short === t || s.name === t
  );
  if (exact) return exact.id;
  if (/^e$/i.test(t)) {
    const eShift = enabledShifts.find((s) => s.id === '早番');
    if (eShift) return eShift.id;
  }
  if (/^n$/i.test(t)) {
    const nShift = enabledShifts.find((s) => s.group === '夜勤系');
    if (nShift) return nShift.id;
  }
  if (/^d$/i.test(t)) {
    const dShift = enabledShifts.find((s) => s.id === '日勤' || s.id === '日');
    if (dShift) return dShift.id;
  }
  const partial = enabledShifts.find(
    (s) => t.includes(s.id) || (s.short && t.includes(s.short)) || (s.name && t.includes(s.name))
  );
  return partial ? partial.id : '';
}

function getHistoryEffect(row: string[], akeIds: Set<string>): { text: string; highlight: boolean } {
  const last = row[6] ?? '';
  // 明けを含む末尾連勤数
  let runCov = 0;
  for (let j = row.length - 1; j >= 0; j -= 1) {
    const worked = Boolean(row[j]);
    const ake = j > 0 && akeIds.has(row[j - 1]);
    if (worked || ake) {
      runCov += 1;
    } else {
      break;
    }
  }
  if (akeIds.has(last)) {
    return { text: '1日は休み（夜勤明け）になります', highlight: true };
  }
  if (last === '遅番') {
    if (runCov >= 5) {
      return { text: '5連勤済み・1日休み／早番不可', highlight: true };
    }
    return { text: '1日に早番は入りません', highlight: true };
  }
  if (runCov >= 5) {
    return { text: `${runCov}連勤済み（1日は休みになります）`, highlight: true };
  }
  if (runCov === 4) {
    return { text: '4連勤中（2日までに休みが必要です）', highlight: true };
  }
  if (runCov > 0) {
    return { text: `連勤 ${runCov}日目（1日は勤務可）`, highlight: false };
  }
  return { text: '影響なし', highlight: false };
}

export function Step6CarryIn({
  data,
  history,
  staff,
  shifts,
  onChange,
}: {
  data: CarryInSetup;
  history: HistorySetup;
  staff: StaffSetupItem[];
  shifts: ShiftTimeSetup[];
  onChange: (carryIn: CarryInSetup, history: HistorySetup) => void;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const { targetMonthLabel, cols } = getPrevLast7Days();
  const normalizedShifts = shifts.map(normalizeShiftItem);
  const enabledShifts = normalizedShifts.filter((s) => s.enabled);
  const enabledShiftIds: ShiftId[] = enabledShifts.map((s) => s.id);
  const validShifts = new Set<string>(enabledShiftIds);
  const akeIds = new Set<string>(
    enabledShifts.filter((s) => s.nextDay === '明け').map((s) => s.id)
  );
  const nightIds = new Set<string>(
    enabledShifts.filter((s) => s.group === '夜勤系').map((s) => s.id)
  );
  const firstShort = `${cols[0].dateShort}（${cols[0].weekday}）`;
  const lastShort = `${cols[6].dateShort}（${cols[6].weekday}）`;

  const rowFor = (staffId: string): string[] =>
    normalizeSeq(history[staffId], validShifts, data[staffId]);

  const setCell = (staffId: string, dayIdx: number, val: string) => {
    const nextRow = rowFor(staffId);
    nextRow[dayIdx] = validShifts.has(val) ? val : '';
    const nextHistory: HistorySetup = { ...history };
    if (nextRow.some((v) => v !== '')) {
      nextHistory[staffId] = nextRow;
    } else {
      delete nextHistory[staffId];
    }
    const nextCarry: CarryInSetup = {
      ...data,
      [staffId]: nextRow[6] || '休',
    };
    onChange(nextCarry, nextHistory);
  };

  const handleResetAllOff = () => {
    const nextCarry: CarryInSetup = {};
    for (const s of staff) {
      nextCarry[s.id] = '休';
    }
    onChange(nextCarry, {});
    setPasteNotice(null);
  };

  const handleImportPaste = () => {
    const lines = pasteText
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      setPasteNotice('貼り付け欄が空です。Excel や表からコピーした7日分を貼り付けてください。');
      return;
    }

    const byName = new Map<string, StaffSetupItem>();
    for (const s of staff) {
      const n = s.name.trim();
      if (n) {
        byName.set(n, s);
        byName.set(n.replace(/\s+/g, ''), s);
      }
    }

    const nextHistory: HistorySetup = { ...history };
    const nextCarry: CarryInSetup = { ...data };
    const enabledSet = new Set<string>(enabledShiftIds);
    let applied = 0;
    let orderIdx = 0;
    const unmatched: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const cells = lines[i].includes('\t') ? lines[i].split('\t') : lines[i].split(',');
      const c0 = (cells[0] ?? '').trim();
      const c1 = (cells[1] ?? '').trim();
      if (
        i === 0 &&
        (['名前', '氏名', '職員', '職員名'].includes(c0) || /^\d{1,2}\/\d{1,2}/.test(c0) || /^\d{1,2}\/\d{1,2}/.test(c1))
      ) {
        continue;
      }

      let targetMember: StaffSetupItem | undefined;
      let rawSeq: string[];

      if (cells.length >= 8) {
        const keyNoSpace = c0.replace(/\s+/g, '');
        targetMember = byName.get(c0) ?? byName.get(keyNoSpace);
        if (!targetMember) {
          if (c0) unmatched.push(c0);
          continue;
        }
        rawSeq = cells.slice(1, 8);
      } else {
        targetMember = staff[orderIdx];
        orderIdx += 1;
        if (!targetMember) break;
        rawSeq = [...cells];
        while (rawSeq.length < 7) rawSeq.push('');
      }

      const seq = rawSeq.slice(0, 7).map((tok) => {
        const sh = parseShiftToken(tok, enabledShifts);
        return sh && enabledSet.has(sh) ? sh : '';
      });
      if (seq.some((v) => v !== '')) {
        nextHistory[targetMember.id] = seq;
      } else {
        delete nextHistory[targetMember.id];
      }
      nextCarry[targetMember.id] = seq[6] || '休';
      applied += 1;
    }

    if (applied === 0) {
      setPasteNotice('取り込める行が見つかりませんでした。7列（または1列目に名前＋7列）で貼り付けてください。');
      return;
    }

    onChange(nextCarry, nextHistory);
    setPasteText('');
    const warn = unmatched.length > 0 ? `（名前が一致しなかった行: ${unmatched.slice(0, 3).join('・')}${unmatched.length > 3 ? ' ほか' : ''}）` : '';
    setPasteNotice(`${applied}人分の7日勤務を取り込みました。下の表で確認できます。${warn}`);
  };

  const rows = staff.map((s) => rowFor(s.id));
  const anyInputCount = rows.filter((r) => r.some((v) => v !== '')).length;
  const nightCount = rows.filter((r) => nightIds.has(r[6])).length;
  const lateCount = rows.filter((r) => r[6] === '遅番').length;

  return (
    <div>
      <div className="step-head-row">
        <h2>前月の最後の7日の勤務を教えてください</h2>
        {!SETUP_USAGE.history && (
          <span className="chip-muted">{usageChipLabel(false)}</span>
        )}
      </div>
      <p className="history-auto-note">
        来月からは、作った表から自動で引き継ぎます。
      </p>
      <p className="setup-description">
        {targetMonthLabel}の1日目以降の連勤や夜勤明けを正しくつなげるため、その前の7日間（<strong>{firstShort} 〜 {lastShort}</strong>）を職員ごとに入れます。分からない場合は「休」のままでも先に進めます。
      </p>

      <div className="notice-box">
        <strong>はじめは全員「休」になっています（最初の月だけの入力です）</strong><br />
        {SETUP_USAGE.history
          ? '「夜勤」の翌日は休み（夜勤明け）になり、「遅番」の翌日に早番は入りません。また前月末からの連勤も5日までとして月初につなぎます。'
          : 'シフト作成につないだあとは、夜勤明け・遅番の翌日の早番禁止に加えて、前月末からの連勤（5日まで）も月初につなぎます。いまはまだシフト作成に使っていません。'}
      </div>

      {staff.length === 0 ? (
        <div className="empty-inline">
          職員が登録されていないため、前月末の入力対象がありません（前の画面「職員の一覧」で追加できます）。
        </div>
      ) : (
        <>
          <div className="staff-toolbar">
            <div className="staff-counts">
              <span>
                対象職員: <strong>{staff.length}</strong>人
              </span>
              <span className="chip-muted">入力あり {anyInputCount}人</span>
              <span className="chip-muted">最終日 夜勤 {nightCount}人</span>
              <span className="chip-muted">最終日 遅番 {lateCount}人</span>
            </div>
            <div className="staff-toolbar-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm btn-paste-history"
                onClick={() => {
                  setPasteOpen((v) => !v);
                  setPasteNotice(null);
                }}
              >
                {pasteOpen ? '貼り付け欄を閉じる' : 'Excel から7列を貼り付け'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={handleResetAllOff}
              >
                全員を「休」にする
              </button>
            </div>
          </div>

          {pasteOpen && (
            <div className="paste-panel">
              <p className="paste-panel-title">Excel やスプレッドシートから7日分を貼り付け</p>
              <p className="form-hint">
                古い日から順に7列（例：<code>{cols.map((c) => c.dateShort).join('\t')}</code> の「早・日・遅・夜・休」）、または先頭に職員名を付けた8列を貼り付けられます。空欄や「-」「休」は休みになります。
              </p>
              <textarea
                className="paste-textarea"
                value={pasteText}
                placeholder={'例（名前＋7日、または7日だけ）：\n佐藤 健一\t早\t日\t休\t日\t日\t遅\t休\n鈴木 美咲\t日\t遅\t休\t夜\t休\t休\t日'}
                onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)}
              />
              <div className="paste-panel-footer">
                <span className="form-hint">取り込むと下の7日表に反映されます。</span>
                <div className="staff-toolbar-actions">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={handleImportPaste}
                  >
                    7日分を取り込む
                  </button>
                </div>
              </div>
              {pasteNotice && (
                <p className="form-hint" style={{ marginTop: '10px', color: '#174EA6' }}>
                  {pasteNotice}
                </p>
              )}
            </div>
          )}

          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th className="history-col-staff">職員</th>
                  {cols.map((col) => (
                    <th
                      key={col.dateShort}
                      className={`history-col-day ${col.isLast ? 'history-col-last' : ''} ${col.wdIdx === 0 ? 'wd-sun' : col.wdIdx === 6 ? 'wd-sat' : ''}`}
                    >
                      <div className="history-th-date">{col.dateShort}</div>
                      <div className="history-th-wd">（{col.weekday}）</div>
                    </th>
                  ))}
                  <th className="history-col-effect">{targetMonthLabel}月初への影響</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((member, idx) => {
                  const row = rows[idx];
                  const effect = getHistoryEffect(row, akeIds);
                  const staffLabel = member.name || `職員 ${idx + 1}`;
                  return (
                    <tr key={member.id}>
                      <td className="history-col-staff">
                        <div className="carry-staff-name">{staffLabel}</div>
                        <div className="carry-staff-meta">
                          {member.role}・{member.employment}
                        </div>
                      </td>
                      {cols.map((col, dIdx) => {
                        const val = row[dIdx] ?? '';
                        return (
                          <td
                            key={col.dateShort}
                            className={`history-col-day ${col.isLast ? 'history-col-last' : ''}`}
                          >
                            <select
                              className={`history-cell-select ${val ? 'has-shift' : ''}`}
                              value={val}
                              aria-label={`${staffLabel} ${col.dateShort}の勤務`}
                              onChange={(e) =>
                                setCell(member.id, dIdx, (e.target as HTMLSelectElement).value)
                              }
                            >
                              <option value="">休</option>
                              {enabledShiftIds.map((sh) => (
                                <option key={sh} value={sh}>
                                  {sh}
                                </option>
                              ))}
                            </select>
                          </td>
                        );
                      })}
                      <td className="history-col-effect">
                        <span className={`carry-effect ${effect.highlight ? 'highlight' : ''}`}>
                          {effect.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
