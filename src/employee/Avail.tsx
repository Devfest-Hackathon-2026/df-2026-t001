import { useState } from 'preact/hooks';
import type { State } from '../core/store';
import { setAvailability } from '../core/store';
import { MY_ID, SHIFTS, SHIFT_ORDER, staffById } from '../core/facility';
import { canWork } from '../core/roster';
import { fmtMD } from '../core/dates';
import type { ShiftCode } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { Ctx, MiniCal, ShiftChip, myAssign } from './common';

type Item = { date: string; shifts: ShiftCode[] };
export const myAvail = (s: State): Item[] => s.availability[MY_ID] ?? [];
/** シフトが入った日は「入れる日」の対象外 */
export const availInvalid = (s: State, d: string) => { const a = myAssign(s, d); return !!a && a.status !== 'absent'; };
export const mySkillShifts = () => SHIFT_ORDER.filter((k) => canWork(staffById(MY_ID), k));
const shiftText = (sh: ShiftCode[]) => (sh.length ? sh.join('・') : 'どの勤務帯でも');

/** 欠員が出たとき優先して連絡してほしい日・勤務帯を出す */
export function AvailSheet({ s, onClose, c }: { s: State; onClose: () => void; c: Ctx }) {
  const [items, setItems] = useState<Item[]>(myAvail(s));
  const [month, setMonth] = useState(s.today.slice(0, 7) + '-01');
  const [day, setDay] = useState<string | null>(null);
  const [sel, setSel] = useState<ShiftCode[]>([]);
  const can = mySkillShifts();
  const pick = (d: string) => { setDay(d); setSel(items.find((x) => x.date === d)?.shifts ?? []); };
  const add = () => { if (!day) return; setItems([...items.filter((x) => x.date !== day), { date: day, shifts: sel }].sort((a, b) => a.date.localeCompare(b.date))); setDay(null); };
  const dirty = JSON.stringify(items) !== JSON.stringify(myAvail(s));
  return (
    <Modal title="入れる日を出す" onClose={onClose} footer={<><button class="btn" onClick={onClose}>閉じる</button><button class="btn pri" disabled={!dirty} onClick={() => { setAvailability(MY_ID, items); c.toast(`入れる日を${items.length}件登録しました`); onClose(); }}>保存する</button></>}>
      <div class="stack">
        <p class="muted">欠員が出たとき、この日・勤務帯なら優先して連絡します。出勤の確定ではなく、断っても評価に影響しません。</p>
        <MiniCal month={month} onMonth={setMonth} today={s.today} minMonth={s.today.slice(0, 7) + '-01'}
          cell={(d) => { const a = myAssign(s, d); const has = a && a.status !== 'absent'; const reg = items.find((x) => x.date === d);
            return { disabled: d <= s.today || !!has, selected: day === d, content: has ? <ShiftChip shift={a!.shift} /> : reg ? <span class="avmark">入れる</span> : <span class="off">休</span> }; }}
          onPick={pick} />
        {day && (
          <div class="sum">
            <b>{fmtMD(day)}は、どの勤務帯なら入れますか？</b>
            <div class="row" style="flex-wrap:wrap;margin:8px 0">
              {can.map((k) => <button key={k} class={`opt${sel.includes(k) ? ' on' : ''}`} aria-pressed={sel.includes(k)} onClick={() => setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k])}>{k}<span class="small">{SHIFTS[k].label}</span></button>)}
            </div>
            <p class="small">選ばないと「どの勤務帯でも」になります。</p>
            <div class="row" style="margin-top:8px"><button class="btn pri" onClick={add}>{items.some((x) => x.date === day) ? '更新する' : '追加する'}</button><button class="btn" onClick={() => setDay(null)}>やめる</button></div>
          </div>
        )}
        <div>
          <div class="sec-title" style="margin-top:0">登録中（{items.length}件）</div>
          {items.length === 0 && <p class="muted">まだありません。カレンダーの日付をタップして追加できます。</p>}
          {items.map((x) => { const bad = availInvalid(s, x.date); return (
            <div key={x.date} class="line" style="width:100%">
              <div style="flex:1;min-width:0"><b>{fmtMD(x.date)}</b>　<span class="muted">{shiftText(x.shifts)}</span>{bad && <div class="small">シフトが入ったため対象外です</div>}{x.date <= s.today && <div class="small">日付が過ぎました</div>}</div>
              {bad && <span class="chip warn">対象外</span>}
              <button class="btn sm" onClick={() => setItems(items.filter((y) => y.date !== x.date))} aria-label={`${fmtMD(x.date)}を外す`}>外す</button>
            </div>); })}
        </div>
      </div>
    </Modal>
  );
}

export function AvailCard({ s, onOpen }: { s: State; onOpen: () => void }) {
  const items = myAvail(s).filter((x) => x.date > s.today);
  return (
    <section class="card row spread" style="gap:12px">
      <div style="min-width:0"><b>入れる日を出す</b><div class="muted">{items.length ? `登録中：${items.slice(0, 3).map((x) => `${fmtMD(x.date)} ${shiftText(x.shifts)}`).join('、')}${items.length > 3 ? ` ほか${items.length - 3}件` : ''}` : '欠員が出たとき、入れる日・勤務帯を優先して連絡します。出勤の確定ではなく、断っても評価に影響しません。'}</div></div>
      <button class={`btn sm${items.length ? '' : ' tonal'}`} onClick={onOpen}>{items.length ? '変更する' : '登録する'}</button>
    </section>
  );
}
export { Icon };
