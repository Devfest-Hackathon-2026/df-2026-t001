import type { Assignment, ShiftCode } from '../core/types';
import type { ComponentChildren } from 'preact';
import { MY_ID, SHIFTS, staffById } from '../core/facility';
import { addDays, dow, DOW_JA, parseYmd, toYmd } from '../core/dates';
import { Icon } from '../shared/ui';
import type { State } from '../core/store';

export const SHIFT_STYLE: Record<ShiftCode, { bg: string; fg: string }> = {
  早番: { bg: '#F5EFE3', fg: '#6E5426' }, 日勤: { bg: '#E8EEF7', fg: '#2F4A73' }, 遅番: { bg: '#E7F1EC', fg: '#2D6248' }, 夜勤: { bg: '#E4E6EF', fg: '#363F66' },
};
export const ShiftChip = ({ shift, full, strike }: { shift: ShiftCode; full?: boolean; strike?: boolean }) => (
  <span class="shift-chip" style={`background:${SHIFT_STYLE[shift].bg};color:${SHIFT_STYLE[shift].fg};${strike ? 'text-decoration:line-through;opacity:.6' : ''}`}>{full ? shift : SHIFTS[shift].short}</span>
);
export const myAssign = (s: State, date: string): Assignment | undefined => s.assignments.find((a) => a.staffId === MY_ID && a.date === date);
/** デモの時計（state.now）の「時:分」。メッセージ・時間割の現在位置と揃える */
export const simMin = (s: State) => { const [h, m] = s.now.slice(11, 16).split(':').map(Number); return h * 60 + m; };
export const senderName = (id: string) => (id === 'leader' ? 'リーダー' : id === 'ai' ? 'シフト作成君' : staffById(id)?.name ?? id);
export interface CalCell { content?: ComponentChildren; disabled?: boolean; selected?: boolean }
/** 月カレンダー（日付を選ぶ用）。cell() で各日の中身・選択可否・選択状態を渡す */
export function MiniCal({ month, onMonth, cell, onPick, today, minMonth }: { month: string; onMonth?: (m: string) => void; cell: (d: string) => CalCell; onPick: (d: string) => void; today: string; minMonth?: string }) {
  const m0 = parseYmd(month); const n = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate();
  const move = (k: number) => onMonth?.(toYmd(new Date(m0.getFullYear(), m0.getMonth() + k, 1)));
  const cells: (string | null)[] = [...Array(dow(month)).fill(null), ...Array.from({ length: n }, (_, i) => addDays(month, i))];
  return (
    <div>
      <div class="row spread" style="margin-bottom:4px">
        {onMonth ? <button class="iconbtn" aria-label="前の月" disabled={!!minMonth && month <= minMonth} onClick={() => move(-1)}><Icon n="chevron_left" /></button> : <span />}
        <b style="font-size:17px">{m0.getFullYear()}年{m0.getMonth() + 1}月</b>
        {onMonth ? <button class="iconbtn" aria-label="次の月" onClick={() => move(1)}><Icon n="chevron_right" /></button> : <span />}
      </div>
      <div class="cal">
        {DOW_JA.map((d, i) => <div key={d} class="cal-h" style={i === 0 ? 'color:var(--bad)' : i === 6 ? 'color:var(--pri)' : ''}>{d}</div>)}
        {cells.map((d, i) => { if (!d) return <div key={`b${i}`} />; const c = cell(d); return (
          <button key={d} class={`cal-d${d === today ? ' today' : ''}${c.selected ? ' sel' : ''}`} disabled={c.disabled} onClick={() => onPick(d)} aria-pressed={c.selected}>
            <span class="n">{+d.slice(8)}</span>{c.content ?? <span class="off" />}
          </button>); })}
      </div>
    </div>
  );
}
export type Tab = 'home' | 'shift' | 'health' | 'chat' | 'settings';
export interface Ctx {
  go: (t: Tab) => void; openNotices: () => void; openStaff: (id: string) => void; openResident: (id: string) => void; openUnitResidents: (unitId: string) => void; openUnitStaff: (unitId: string) => void; toast: (m: string) => void;
}
export const timeOfStamp = (at: string, _today: string) => at.slice(11, 16);
