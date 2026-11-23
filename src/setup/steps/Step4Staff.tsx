import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import {
  CountRange,
  FacilitySetup,
  ShiftId,
  ShiftTimeSetup,
  StaffLimitsSetup,
  StaffSetupItem,
} from '../types';
import { DEFAULT_SETUP_STATE, normalizeShiftItem } from '../defaults';
import { allowedShiftsFor, isExcludedByLeaveBy } from '../solverRequest';
import { SETUP_USAGE, usageChipLabel } from '../usage';

const ROLES = ['主任', '介護福祉士', '介護職員', '新人'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const MAX_STAFF = 80;

function nextStaffId(list: StaffSetupItem[]): string {
  let maxNum = 0;
  for (const s of list) {
    const m = /^S(\d+)$/.exec(s.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `S${String(maxNum + 1).padStart(3, '0')}`;
}

const DEFAULT_NAMES = new Set(DEFAULT_SETUP_STATE.staff.map((s) => s.name));

function normalizeTime(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (hhmm) {
    const h = Math.min(23, Math.max(0, parseInt(hhmm[1], 10)));
    const m = Math.min(59, Math.max(0, parseInt(hhmm[2], 10)));
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const jp = /^(\d{1,2})時/.exec(trimmed);
  if (jp) {
    const h = Math.min(23, Math.max(0, parseInt(jp[1], 10)));
    return `${String(h).padStart(2, '0')}:00`;
  }
  return '';
}

function parseOptionalCount(raw: string): number | null {
  const half = raw
    .trim()
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[日回\s]/g, '');
  if (!half || half === '-' || half === '—' || half === 'なし') return null;
  if (!/^\d+$/.test(half)) return null;
  return Math.max(0, Math.min(31, parseInt(half, 10)));
}

function parseShiftsCell(raw: string, enabledShifts: Required<ShiftTimeSetup>[]): ShiftId[] {
  const t = raw.trim();
  const fallback = enabledShifts.map((s) => s.id);
  if (!t) return fallback;
  const result: ShiftId[] = [];
  for (const s of enabledShifts) {
    if (
      t.includes(s.id) ||
      (s.short && t.includes(s.short)) ||
      (s.name && t.includes(s.name))
    ) {
      result.push(s.id);
    }
  }
  return result.length > 0 ? result : fallback;
}

function parseWeekdaysCell(raw: string): number[] {
  const t = raw.trim();
  if (!t) return [];
  const res: number[] = [];
  WEEKDAYS.forEach((w, idx) => {
    if (t.includes(w)) res.push(idx);
  });
  return res;
}

function cleanRange(r?: CountRange): CountRange | undefined {
  if (!r) return undefined;
  const min = r.min ?? null;
  const max = r.max ?? null;
  if (min === null && max === null) return undefined;
  const out: CountRange = {};
  if (min !== null) out.min = Math.max(0, Math.min(31, Math.round(min)));
  if (max !== null) out.max = Math.max(0, Math.min(31, Math.round(max)));
  return out;
}

function cleanLimits(raw?: StaffLimitsSetup, validShiftIds?: string[]): StaffLimitsSetup | undefined {
  if (!raw) return undefined;
  const workDays = cleanRange(raw.workDays);
  const byShift: Partial<Record<ShiftId, CountRange>> = {};
  if (raw.byShift) {
    const keys = validShiftIds ?? Object.keys(raw.byShift);
    keys.forEach((sh) => {
      const cleaned = cleanRange(raw.byShift?.[sh]);
      if (cleaned) byShift[sh] = cleaned;
    });
  }
  const hasShift = Object.keys(byShift).length > 0;
  if (!workDays && !hasShift) return undefined;
  return {
    ...(workDays ? { workDays } : {}),
    ...(hasShift ? { byShift } : {}),
  };
}

function hasRangeConflict(r?: CountRange): boolean {
  return r?.min != null && r?.max != null && r.min > r.max;
}

function countOtherShiftLimits(limits: StaffLimitsSetup | undefined, otherShiftIds: ShiftId[]): number {
  if (!limits?.byShift) return 0;
  return otherShiftIds.filter((id) => {
    const r = limits.byShift?.[id];
    return r && (r.min != null || r.max != null);
  }).length;
}

export function Step4Staff({
  data,
  facility,
  shifts,
  onChange,
}: {
  data: StaffSetupItem[];
  facility: FacilitySetup;
  shifts: ShiftTimeSetup[];
  onChange: (data: StaffSetupItem[]) => void;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteMode, setPasteMode] = useState<'append' | 'replace'>('append');
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [pasteRoleWarn, setPasteRoleWarn] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const normalizedShifts = shifts.map(normalizeShiftItem);
  const allShiftIds = normalizedShifts.map((s) => s.id);
  const enabledShifts = normalizedShifts.filter((s) => s.enabled);
  const enabledShiftIds = enabledShifts.map((s) => s.id);
  const nightShifts = enabledShifts.filter((s) => s.group === '夜勤系');
  const singleNightShift = nightShifts.length === 1 ? nightShifts[0] : null;
  const nightEnabled = singleNightShift !== null;
  const otherEnabledShifts = singleNightShift
    ? enabledShifts.filter((s) => s.id !== singleNightShift.id)
    : enabledShifts;
  const otherEnabledIds = otherEnabledShifts.map((s) => s.id);
  const unitNames = facility.units.map((u) => u.name).filter((n) => n.trim().length > 0);

  const updateRow = (index: number, patch: Partial<StaffSetupItem>) => {
    onChange(data.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  };

  const updateWorkDaysLimit = (index: number, bound: 'min' | 'max', val: number | null) => {
    const cur = data[index].limits ?? {};
    const nextWork: CountRange = { ...(cur.workDays ?? {}), [bound]: val };
    updateRow(index, { limits: cleanLimits({ ...cur, workDays: nextWork }, allShiftIds) });
  };

  const updateShiftLimit = (index: number, shiftId: ShiftId, bound: 'min' | 'max', val: number | null) => {
    const cur = data[index].limits ?? {};
    const nextByShift = { ...(cur.byShift ?? {}) };
    nextByShift[shiftId] = { ...(nextByShift[shiftId] ?? {}), [bound]: val };
    updateRow(index, { limits: cleanLimits({ ...cur, byShift: nextByShift }, allShiftIds) });
  };

  const toggleShift = (index: number, shiftId: ShiftId) => {
    const row = data[index];
    const has = row.shifts.includes(shiftId);
    const next = has
      ? row.shifts.filter((s) => s !== shiftId)
      : [...row.shifts, shiftId];
    updateRow(index, { shifts: next });
  };

  const toggleWeekday = (index: number, dayIdx: number) => {
    const row = data[index];
    const has = row.unavailableDaysOfWeek.includes(dayIdx);
    const next = has
      ? row.unavailableDaysOfWeek.filter((d) => d !== dayIdx)
      : [...row.unavailableDaysOfWeek, dayIdx].sort((a, b) => a - b);
    updateRow(index, { unavailableDaysOfWeek: next });
  };

  const toggleDetail = (staffId: string) => {
    setExpandedIds((prev) => ({ ...prev, [staffId]: !prev[staffId] }));
  };

  const handleAddRow = () => {
    if (data.length >= MAX_STAFF) return;
    const newRow: StaffSetupItem = {
      id: nextStaffId(data),
      name: '',
      role: '介護職員',
      employment: '常勤',
      shifts: enabledShiftIds.length > 0 ? [...enabledShiftIds] : [...allShiftIds],
      canMedicalCare: false,
      homeUnit: unitNames[0] ?? '',
      leaveBy: '',
      unavailableDaysOfWeek: [],
    };
    onChange([...data, newRow]);
  };

  const handleRemoveRow = (index: number) => {
    onChange(data.filter((_, idx) => idx !== index));
  };

  const handleImportPaste = () => {
    const lines = pasteText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      setPasteNotice('貼り付け欄が空です。Excel や表からコピーした行を貼り付けてください。');
      setPasteRoleWarn(null);
      return;
    }

    const baseList: StaffSetupItem[] = pasteMode === 'replace' ? [] : [...data];
    const imported: StaffSetupItem[] = [];
    let unknownRoleCount = 0;
    const unknownRoles = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].includes('\t')
        ? lines[i].split('\t')
        : lines[i].split(',');
      const name = (cols[0] ?? '').trim();
      if (!name) continue;
      if (i === 0 && (name === '名前' || name === '氏名' || name === '職員名')) {
        continue;
      }

      const rawRole = (cols[1] ?? '').trim();
      const role = rawRole || '介護職員';

      const rawEmp = (cols[2] ?? '').trim();
      const employment: '常勤' | 'パート' = rawEmp.includes('パート') ? 'パート' : '常勤';

      const parsedShifts = parseShiftsCell(
        cols[3] ?? '',
        enabledShifts.length > 0 ? enabledShifts : normalizedShifts
      );

      const rawMed = (cols[4] ?? '').trim().toLowerCase();
      const canMedicalCare =
        rawMed === '可' ||
        rawMed === '○' ||
        rawMed === '〇' ||
        rawMed === 'あり' ||
        rawMed === '1' ||
        rawMed === 'true';

      const rawUnit = (cols[5] ?? '').trim();
      const homeUnit = rawUnit || unitNames[0] || '';

      const leaveBy = normalizeTime(cols[6] ?? '');
      const unavailableDaysOfWeek = parseWeekdaysCell(cols[7] ?? '');

      const workDaysMin = parseOptionalCount(cols[8] ?? '');
      const workDaysMax = parseOptionalCount(cols[9] ?? '');
      const nightMin = parseOptionalCount(cols[10] ?? '');
      const nightMax = parseOptionalCount(cols[11] ?? '');

      const pasteNightId = singleNightShift?.id ?? nightShifts[0]?.id ?? '夜勤';
      const limits = cleanLimits({
        workDays:
          workDaysMin !== null || workDaysMax !== null
            ? { min: workDaysMin, max: workDaysMax }
            : undefined,
        byShift:
          nightMin !== null || nightMax !== null
            ? { [pasteNightId]: { min: nightMin, max: nightMax } }
            : undefined,
      }, allShiftIds);

      if (baseList.length + imported.length >= MAX_STAFF) {
        break;
      }

      if (rawRole && !ROLES.includes(rawRole)) {
        unknownRoleCount += 1;
        unknownRoles.add(rawRole);
      }

      imported.push({
        id: nextStaffId([...baseList, ...imported]),
        name,
        role,
        employment,
        shifts: parsedShifts,
        canMedicalCare,
        homeUnit,
        leaveBy,
        unavailableDaysOfWeek,
        ...(limits ? { limits } : {}),
      });
    }

    if (imported.length === 0) {
      setPasteNotice('取り込める行が見つかりませんでした。1列目に職員の名前を入れてください。');
      setPasteRoleWarn(null);
      return;
    }

    onChange([...baseList, ...imported]);
    setPasteText('');
    setPasteNotice(`${imported.length}人を取り込みました。下の表で確認・修正できます。`);
    if (unknownRoleCount > 0) {
      setPasteRoleWarn(
        `見慣れない役割が${unknownRoleCount}人います（${Array.from(unknownRoles).join('・')}）。主任と同じ扱い（休日数・勤務回数をそろえる対象から外す）にするなら、役割を「主任」にしてください。`
      );
    } else {
      setPasteRoleWarn(null);
    }
  };

  const fullTimeCount = data.filter((s) => s.employment === '常勤').length;
  const partTimeCount = data.filter((s) => s.employment === 'パート').length;
  const medCount = data.filter((s) => s.canMedicalCare).length;
  const hasPlaceholder = data.some((s) => DEFAULT_NAMES.has(s.name));
  const noShiftCount = data.filter((s) => allowedShiftsFor(s, shifts).length === 0).length;

  return (
    <div>
      <div className="step-head-row">
        <h2>職員の一覧を教えてください</h2>
        {!SETUP_USAGE.staff && (
          <span className="chip-muted">{usageChipLabel(false)}</span>
        )}
      </div>
      <p className="setup-description">
        シフトに入る職員を登録します（最大{MAX_STAFF}人）。表を直接直すか、Excel やスプレッドシートからコピーして貼り付けられます。
      </p>

      <div className="notice-box">
        <strong>名前の扱いと仮の値について</strong><br />
        {SETUP_USAGE.staff
          ? '職員の「名前」は画面の表示にだけ使い、シフト作成の計算には送信しません。'
          : 'シフト作成につないだあとは、職員の「名前」は画面の表示にだけ使い、計算には送信しません。いまは職員の一覧もシフト作成にはまだ使っていません。'}
        {hasPlaceholder && (
          <span> あらかじめ仮の職員（職員A〜）が入っています。実際の職員に書き換えるか、不要な行を削除してください。</span>
        )}
      </div>

      <div className="staff-toolbar">
        <div className="staff-counts">
          <span>
            登録人数: <strong>{data.length}</strong> / {MAX_STAFF}人
          </span>
          <span className="chip-muted">常勤 {fullTimeCount}人</span>
          <span className="chip-muted">パート {partTimeCount}人</span>
          <span className="chip-muted">医療的ケア可 {medCount}人</span>
          {noShiftCount > 0 && (
            <span className="chip-warn-inline">どの勤務にも入れない {noShiftCount}人</span>
          )}
        </div>

        <div className="staff-toolbar-actions">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              setPasteOpen((v) => !v);
              setPasteNotice(null);
              setPasteRoleWarn(null);
            }}
          >
            {pasteOpen ? '貼り付け欄を閉じる' : 'Excel から貼り付け'}
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={data.length >= MAX_STAFF}
            onClick={handleAddRow}
          >
            ＋ 職員を1人足す
          </button>
        </div>
      </div>

      {pasteOpen && (
        <div className="paste-panel">
          <p className="paste-panel-title">Excel やスプレッドシートから貼り付け</p>
          <p className="form-hint">
            左から「名前、役割、常勤/パート、入れる勤務帯（例: 早日遅夜）、医療的ケア（可）、所属ユニット、退勤上限（例: 16:00）、入れない曜日（例: 土日）、勤務日数下限、勤務日数上限、夜勤下限、夜勤上限」の順に並べてコピーしてください。名前だけの1列貼り付けや、8列までの貼り付けもできます。
          </p>
          <textarea
            className="paste-textarea"
            value={pasteText}
            placeholder={'例：\n佐藤 花子\t介護福祉士\t常勤\t早日遅夜\t可\tひなた\t\t\t\t\t4\t8\n鈴木 太郎\t介護職員\tパート\t早\t\tひなた\t16:00\t土日\t8\t12\t\t'}
            onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)}
          />
          <div className="paste-panel-footer">
            <div className="paste-mode-group">
              <label>
                <input
                  type="radio"
                  name="paste-mode"
                  checked={pasteMode === 'append'}
                  onChange={() => setPasteMode('append')}
                />
                いまの表の下に追加する
              </label>
              <label>
                <input
                  type="radio"
                  name="paste-mode"
                  checked={pasteMode === 'replace'}
                  onChange={() => setPasteMode('replace')}
                />
                いまの表をすべて入れ替える
              </label>
            </div>
            <div className="staff-toolbar-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={handleImportPaste}
              >
                貼り付けを取り込む
              </button>
            </div>
          </div>
          {pasteNotice && (
            <p className="form-hint" style={{ marginTop: '10px', color: '#174EA6' }}>
              {pasteNotice}
            </p>
          )}
          {pasteRoleWarn && (
            <p className="form-hint" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: '#202124' }}>
              <span className="chip-warn-inline">役割の確認</span>
              <span>{pasteRoleWarn}</span>
            </p>
          )}
        </div>
      )}

      <div className="staff-limits-note">
        <span>
          <strong>勤務日数（月）・夜勤（月）と「詳細」の勤務帯ごと回数</strong>：空欄にすると施設の決まりに従います。
        </span>
        {!SETUP_USAGE.staffLimits && (
          <span className="chip-muted">{usageChipLabel(false)}</span>
        )}
      </div>

      {data.length === 0 ? (
        <div className="empty-inline">
          職員がまだ登録されていません。「＋ 職員を1人足す」か「Excel から貼り付け」で登録してください（あとで足せます）。
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table className="setup-table">
              <thead>
                <tr>
                  <th>名前（表示用）</th>
                  <th>役割</th>
                  <th>雇用</th>
                  <th>入れる勤務帯</th>
                  <th>医療的ケア</th>
                  <th>所属ユニット</th>
                  <th>退勤上限</th>
                  <th>入れない曜日</th>
                  <th>
                    <div className="th-stack">
                      <span>勤務日数（月）</span>
                      <span className="th-sub">下限 〜 上限</span>
                    </div>
                  </th>
                  <th>
                    <div className="th-stack">
                      <span>{singleNightShift ? `${singleNightShift.name}（月）` : '夜勤（月）'}</span>
                      <span className="th-sub">{nightShifts.length > 1 ? '詳細から設定' : '下限 〜 上限'}</span>
                    </div>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.map((staff, idx) => {
                  const roleOptions =
                    staff.role && !ROLES.includes(staff.role)
                      ? [staff.role, ...ROLES]
                      : ROLES;
                  const unitOptions =
                    staff.homeUnit && !unitNames.includes(staff.homeUnit)
                      ? [staff.homeUnit, ...unitNames]
                      : unitNames;
                  const workRange = staff.limits?.workDays;
                  const nightRange = singleNightShift ? staff.limits?.byShift?.[singleNightShift.id] : undefined;
                  const otherCount = countOtherShiftLimits(staff.limits, otherEnabledIds);
                  const isExpanded = Boolean(expandedIds[staff.id]);
                  const staffLabel = staff.name || `職員${idx + 1}`;

                  return (
                    <Fragment key={staff.id}>
                      <tr>
                        <td>
                          <input
                            type="text"
                            className="cell-input cell-input-name"
                            value={staff.name}
                            placeholder="名前"
                            aria-label={`職員${idx + 1}の名前`}
                            onInput={(e) =>
                              updateRow(idx, { name: (e.target as HTMLInputElement).value })
                            }
                          />
                        </td>
                        <td>
                          <select
                            className="cell-select"
                            value={staff.role}
                            aria-label={`${staffLabel}の役割`}
                            onChange={(e) =>
                              updateRow(idx, { role: (e.target as HTMLSelectElement).value })
                            }
                          >
                            {roleOptions.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="cell-select"
                            value={staff.employment}
                            aria-label={`${staffLabel}の雇用形態`}
                            onChange={(e) =>
                              updateRow(idx, {
                                employment: (e.target as HTMLSelectElement).value as '常勤' | 'パート',
                              })
                            }
                          >
                            <option value="常勤">常勤</option>
                            <option value="パート">パート</option>
                          </select>
                        </td>
                        <td>
                          <div className="chip-toggle-group">
                            {enabledShifts.length === 0 ? (
                              <span className="chip-muted">勤務帯なし</span>
                            ) : (
                              enabledShifts.map((sh) => {
                                const selected = staff.shifts.includes(sh.id);
                                const excluded = selected && isExcludedByLeaveBy(sh, staff.leaveBy);
                                return (
                                  <button
                                    key={sh.id}
                                    type="button"
                                    className={`chip-toggle ${selected ? 'selected' : ''} ${excluded ? 'excluded' : ''}`}
                                    title={
                                      excluded
                                        ? SETUP_USAGE.staff
                                          ? `${sh.name}（終了 ${sh.endTime}）は退勤上限（${staff.leaveBy}）より後のため作成時に自動で外れます`
                                          : `${sh.name}（終了 ${sh.endTime}）は退勤上限（${staff.leaveBy}）より後のため、つないだあとの作成時に自動で外れます`
                                        : `${sh.name}に入れる`
                                    }
                                    onClick={() => toggleShift(idx, sh.id)}
                                  >
                                    {sh.short || sh.id.slice(0, 2)}
                                  </button>
                                );
                              })
                            )}
                          </div>
                          {enabledShifts.length > 0 && allowedShiftsFor(staff, shifts).length === 0 && (
                            <div className="staff-row-warn">
                              {staff.shifts.some((id) => enabledShiftIds.includes(id))
                                ? 'どの勤務にも入れません（退勤上限を確認）'
                                : 'どの勤務にも入れません'}
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <label className="cell-checkbox-label">
                            <input
                              type="checkbox"
                              checked={staff.canMedicalCare}
                              onChange={(e) =>
                                updateRow(idx, {
                                  canMedicalCare: (e.target as HTMLInputElement).checked,
                                })
                              }
                            />
                            <span>可</span>
                          </label>
                        </td>
                        <td>
                          <select
                            className="cell-select"
                            value={staff.homeUnit}
                            aria-label={`${staffLabel}の所属ユニット`}
                            onChange={(e) =>
                              updateRow(idx, { homeUnit: (e.target as HTMLSelectElement).value })
                            }
                          >
                            <option value="">指定なし</option>
                            {unitOptions.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="time"
                            className="cell-input cell-input-time"
                            value={staff.leaveBy ?? ''}
                            aria-label={`${staffLabel}の退勤上限`}
                            onInput={(e) =>
                              updateRow(idx, { leaveBy: (e.target as HTMLInputElement).value })
                            }
                          />
                        </td>
                        <td>
                          <div className="chip-toggle-group">
                            {WEEKDAYS.map((w, wIdx) => {
                              const isOff = staff.unavailableDaysOfWeek.includes(wIdx);
                              return (
                                <button
                                  key={w}
                                  type="button"
                                  className={`chip-toggle ${isOff ? 'day-off' : ''}`}
                                  title={`${w}曜日は入れない`}
                                  onClick={() => toggleWeekday(idx, wIdx)}
                                >
                                  {w}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                        <td>
                          <div className="cell-range-pair">
                            <input
                              type="number"
                              min={0}
                              max={31}
                              placeholder="下限"
                              className="cell-input cell-input-num"
                              value={workRange?.min ?? ''}
                              aria-label={`${staffLabel}の勤務日数（月）下限`}
                              onInput={(e) =>
                                updateWorkDaysLimit(idx, 'min', parseOptionalCount((e.target as HTMLInputElement).value))
                              }
                            />
                            <span className="cell-range-sep">〜</span>
                            <input
                              type="number"
                              min={0}
                              max={31}
                              placeholder="上限"
                              className="cell-input cell-input-num"
                              value={workRange?.max ?? ''}
                              aria-label={`${staffLabel}の勤務日数（月）上限`}
                              onInput={(e) =>
                                updateWorkDaysLimit(idx, 'max', parseOptionalCount((e.target as HTMLInputElement).value))
                              }
                            />
                          </div>
                          {hasRangeConflict(workRange) && (
                            <div className="staff-row-warn">下限が上限を超えています</div>
                          )}
                        </td>
                        <td>
                          <div className="cell-range-pair">
                            <input
                              type="number"
                              min={0}
                              max={31}
                              placeholder="下限"
                              disabled={!nightEnabled}
                              className="cell-input cell-input-num"
                              value={nightRange?.min ?? ''}
                              aria-label={`${staffLabel}の夜勤（月）下限`}
                              onInput={(e) =>
                                singleNightShift && updateShiftLimit(idx, singleNightShift.id, 'min', parseOptionalCount((e.target as HTMLInputElement).value))
                              }
                            />
                            <span className="cell-range-sep">〜</span>
                            <input
                              type="number"
                              min={0}
                              max={31}
                              placeholder="上限"
                              disabled={!nightEnabled}
                              className="cell-input cell-input-num"
                              value={nightRange?.max ?? ''}
                              aria-label={`${staffLabel}の夜勤（月）上限`}
                              onInput={(e) =>
                                singleNightShift && updateShiftLimit(idx, singleNightShift.id, 'max', parseOptionalCount((e.target as HTMLInputElement).value))
                              }
                            />
                          </div>
                          {hasRangeConflict(nightRange) && (
                            <div className="staff-row-warn">下限が上限を超えています</div>
                          )}
                        </td>
                        <td>
                          <div className="cell-actions">
                            <button
                              type="button"
                              className={`cell-detail-btn ${isExpanded ? 'open' : ''}`}
                              aria-expanded={isExpanded}
                              onClick={() => toggleDetail(staff.id)}
                            >
                              {isExpanded ? '閉じる' : otherCount > 0 ? `詳細 (${otherCount})` : '詳細'}
                            </button>
                            <button
                              type="button"
                              className="cell-remove-btn"
                              onClick={() => handleRemoveRow(idx)}
                              aria-label={`${staffLabel}を削除`}
                            >
                              削除
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="staff-detail-row">
                          <td colSpan={11}>
                            <div className="staff-detail-panel">
                              <div className="staff-detail-head">
                                <div className="staff-detail-title-group">
                                  <strong>{staffLabel} の勤務帯ごとの回数（月）</strong>
                                  {!SETUP_USAGE.staffLimits && (
                                    <span className="chip-muted">{usageChipLabel(false)}</span>
                                  )}
                                </div>
                                <span className="staff-detail-hint">
                                  空欄は施設の決まりに従います。上限は必ず守り、下限はできるだけ守ります。
                                </span>
                              </div>
                              {otherEnabledShifts.length === 0 ? (
                                <p className="form-hint">夜勤以外の使う勤務帯はありません。</p>
                              ) : (
                                <div className="staff-detail-grid">
                                  {otherEnabledShifts.map((sh) => {
                                    const range = staff.limits?.byShift?.[sh.id];
                                    return (
                                      <div key={sh.id} className="staff-detail-item">
                                        <span className="staff-detail-shift">{sh.name}</span>
                                        <div className="cell-range-pair">
                                          <input
                                            type="number"
                                            min={0}
                                            max={31}
                                            placeholder="下限"
                                            className="cell-input cell-input-num"
                                            value={range?.min ?? ''}
                                            aria-label={`${staffLabel}の${sh.name}下限`}
                                            onInput={(e) =>
                                              updateShiftLimit(idx, sh.id, 'min', parseOptionalCount((e.target as HTMLInputElement).value))
                                            }
                                          />
                                          <span className="cell-range-sep">〜</span>
                                          <input
                                            type="number"
                                            min={0}
                                            max={31}
                                            placeholder="上限"
                                            className="cell-input cell-input-num"
                                            value={range?.max ?? ''}
                                            aria-label={`${staffLabel}の${sh.name}上限`}
                                            onInput={(e) =>
                                              updateShiftLimit(idx, sh.id, 'max', parseOptionalCount((e.target as HTMLInputElement).value))
                                            }
                                          />
                                          <span className="staff-detail-unit">回</span>
                                        </div>
                                        {hasRangeConflict(range) && (
                                          <div className="staff-row-warn">下限が上限を超えています</div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="table-hint-below">
            {SETUP_USAGE.staff && SETUP_USAGE.staffLimits
              ? `※ 退勤上限より後に終わる勤務帯（夜勤を除く）は取り消し線で表示され、作成時に自動で外されます。入れない曜日はその月の日付に変換して必ず休みにします。勤務日数・夜勤などの月間回数は空欄にすると施設の決まりに従います（上限は必ず守り、下限はできるだけ守ります）。${SETUP_USAGE.units ? '' : '所属ユニットはまだ作成に使っていません。'}`
              : '※ シフト作成につないだあとは、退勤上限より後に終わる勤務帯（夜勤を除く）は取り消し線で表示され作成時に自動で外され、入れない曜日はその月の日付に変換して必ず休みにします。勤務日数・夜勤などの月間回数は空欄にすると施設の決まりに従います（上限は必ず守り、下限はできるだけ守ります）。いまはどの項目もシフト作成にはまだ使っていません。'}
          </p>
        </>
      )}

      {data.length === 0 && (
        <div className="notice-warn">
          職員が0人です。このまま先に進むこともできますが、シフトを作るには1人以上の職員が必要です。
        </div>
      )}
    </div>
  );
}
