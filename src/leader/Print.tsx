import { useState } from 'preact/hooks';
import { STAFF, SHIFTS, UNITS } from '../core/facility';
import { DOW_JA, daysInRange, dow, parseYmd } from '../core/dates';
import type { State } from '../core/store';
import { Icon } from '../shared/ui';

export function PrintRoster({ s, ym: ym0, onClose }: { s: State; ym: string; onClose: () => void }) {
  const [ym, setYm] = useState(ym0);
  const [yy, mm] = ym.split('-').map(Number);
  const days = daysInRange(`${ym}-01`, `${ym}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`);
  const staff = STAFF.filter((x) => x.shifts.length > 0);
  return (
    <div class="print-overlay" role="dialog" aria-label="勤務表の印刷">
      <div class="noprint ptool">
        <button class="btn" onClick={onClose}><Icon n="close" sm /> 閉じる</button>
        <div class="seg">{['2026-11', '2026-12'].map((m) => <button key={m} aria-pressed={ym === m} onClick={() => setYm(m)}>{Number(m.slice(5))}月</button>)}</div>
        <button class="btn pri" onClick={() => window.print()}><Icon n="print" sm /> 印刷 / PDFで保存</button>
      </div>
      <div class="print-sheet">
        <h2 style="font-size:16px;font-weight:500;margin-bottom:4px">{yy}年{mm}月 勤務表（さくら苑・架空データ）</h2>
        <p class="small" style="margin-bottom:6px">早=早番 日=日勤 遅=遅番 夜=夜勤　数字=ユニット（{UNITS.map((u) => `${u.id.slice(1)}:${u.name}`).join(' ')}）　×=欠勤</p>
        <table class="ptbl"><thead><tr><th class="pn">職員</th>{days.map((d) => <th key={d} class={dow(d) === 0 ? 'su' : dow(d) === 6 ? 'sa' : ''}>{parseYmd(d).getDate()}<br />{DOW_JA[dow(d)]}</th>)}</tr></thead>
          <tbody>{staff.map((x) => <tr key={x.id}><th class="pn">{x.name}</th>{days.map((d) => { const a = s.assignments.find((y) => y.staffId === x.id && y.date === d); return <td key={d} class={a?.status === 'absent' ? 'ab' : ''}>{a ? (a.status === 'absent' ? '×' : `${SHIFTS[a.shift].short}${a.unitId.slice(1)}`) : ''}</td>; })}</tr>)}</tbody></table>
      </div>
    </div>
  );
}
