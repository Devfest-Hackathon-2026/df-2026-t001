import { useState } from 'preact/hooks';
import { SHIFT_ORDER } from '../core/facility';
import { addEvent, removeEvent, updateEvent } from '../core/store';
import type { EventKind, FacilityEvent } from '../core/events';
import type { ShiftCode } from '../core/types';
import { fmtLong } from '../core/dates';
import { Icon, Modal } from '../shared/ui';

export const KINDS: EventKind[] = ['行事', '訓練', '研修', '面会', '誕生会', 'その他'];
// 行事の種類ごとの色（淡色のみ）
export const EVENT_STYLE: Record<EventKind, { bg: string; fg: string }> = {
  行事: { bg: '#E8EEF7', fg: '#2F4A73' }, 訓練: { bg: '#FEF3E0', fg: '#8A5200' }, 研修: { bg: '#E7F1EC', fg: '#2D6248' },
  面会: { bg: '#F1ECF7', fg: '#5B3F86' }, 誕生会: { bg: '#F7ECEF', fg: '#8A3F55' }, その他: { bg: '#EEEFF1', fg: '#4A4F57' },
};
export const effectText = (e: FacilityEvent) => {
  if (!e.effect) return '';
  const sh = e.effect.shifts.join('・');
  const parts: string[] = [];
  if (e.effect.allStaff) parts.push(`${sh}は全員参加`);
  if (e.effect.extra > 0) parts.push(`${sh} +${e.effect.extra}名`);
  return parts.join('／');
};

type Mode = 'none' | 'extra' | 'all';
/** 行事の追加・編集 */
export function EventForm({ date, event, onClose }: { date: string; event?: FacilityEvent; onClose: () => void }) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [kind, setKind] = useState<EventKind>(event?.kind ?? '行事');
  const [note, setNote] = useState(event?.note ?? '');
  const [mode, setMode] = useState<Mode>(event?.effect ? (event.effect.allStaff ? 'all' : 'extra') : 'none');
  const [shifts, setShifts] = useState<ShiftCode[]>(event?.effect?.shifts ?? ['日勤']);
  const [extra, setExtra] = useState(Math.max(1, event?.effect?.extra ?? 1));
  const toggle = (k: ShiftCode) => setShifts((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]));
  const valid = title.trim().length > 0 && (mode === 'none' || shifts.length > 0);
  const save = () => {
    const effect = mode === 'none' ? undefined : mode === 'extra' ? { shifts, extra } : { shifts, extra: 0, allStaff: true };
    const v = { date: event?.date ?? date, title: title.trim(), kind, note: note.trim() || undefined, effect };
    if (event) updateEvent(event.id, v); else addEvent(v);
    onClose();
  };
  return (
    <Modal title={event ? '行事を編集' : '行事を追加'} onClose={onClose} footer={<>
      {event && <button class="btn danger" style="margin-right:auto" onClick={() => { if (confirm('この行事を削除します。よろしいですか？')) { removeEvent(event.id); onClose(); } }}>削除</button>}
      <button class="btn" onClick={onClose}>やめる</button><button class="btn pri" disabled={!valid} onClick={save}>{event ? '保存' : '追加'}</button></>}>
      <p class="muted">{fmtLong(event?.date ?? date)}</p>
      <div class="stack" style="margin-top:12px">
        <div class="field"><label>行事の名前</label><input class="input" value={title} placeholder="例：避難訓練" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></div>
        <div class="field"><label>種類</label><div class="row wrap" role="radiogroup" aria-label="種類">{KINDS.map((k) => <button key={k} role="radio" aria-checked={kind === k} class={`opt${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{k}</button>)}</div></div>
        <div class="field"><label>メモ（任意）</label><textarea class="input" rows={2} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} /></div>
        <div class="field"><label>必要人数への影響</label>
          <div class="row wrap" role="radiogroup" aria-label="必要人数への影響">
            <button role="radio" aria-checked={mode === 'none'} class={`opt${mode === 'none' ? ' on' : ''}`} onClick={() => setMode('none')}>影響なし</button>
            <button role="radio" aria-checked={mode === 'extra'} class={`opt${mode === 'extra' ? ' on' : ''}`} onClick={() => setMode('extra')}>人数を増やす</button>
            <button role="radio" aria-checked={mode === 'all'} class={`opt${mode === 'all' ? ' on' : ''}`} onClick={() => setMode('all')}>参加必須</button></div></div>
        {mode !== 'none' && <div class="field"><label>{mode === 'extra' ? '人数を増やす勤務帯' : '全員参加の勤務帯'}</label>
          <div class="row wrap">{SHIFT_ORDER.map((k) => <button key={k} role="checkbox" aria-checked={shifts.includes(k)} class={`opt${shifts.includes(k) ? ' on' : ''}`} onClick={() => toggle(k)}>{k}</button>)}</div></div>}
        {mode === 'extra' && <div class="field"><label>追加する人数（勤務帯ごと）</label>
          <div class="row" style="gap:4px"><button class="iconbtn" aria-label="減らす" disabled={extra <= 1} onClick={() => setExtra(extra - 1)}><Icon n="remove" /></button><b style="min-width:28px;text-align:center;font-weight:500">+{extra}</b><button class="iconbtn" aria-label="増やす" disabled={extra >= 3} onClick={() => setExtra(extra + 1)}><Icon n="add" /></button></div></div>}
        <p class="small">{mode === 'extra' ? '月間・日次の必要人数が増え、足りない日は「要確認」になります。シフト作成でも追加配置されます。' : mode === 'all' ? '該当の勤務帯の職員は全員参加の行事です。人数の追加はありません。' : '表示のみで、必要人数は変わりません。'}</p>
      </div>
    </Modal>
  );
}
