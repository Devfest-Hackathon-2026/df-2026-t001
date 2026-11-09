import { useEffect, useState } from 'preact/hooks';
import { composeEmployee, type ComposeIn } from '../core/aiintent';
import { proposeFromText } from '../core/shiftmaker';
import type { State } from '../core/store';
import { askShiftMaker } from '../core/store';
import { MY_ID, SHIFTS, TASKS, TASK_GROUPS, unitName } from '../core/facility';
import { buildDay } from '../core/roster';
import { addDays, fmtHM, fmtMD, fmtMin } from '../core/dates';
import { Icon, Modal } from '../shared/ui';
import { MiniCal, ShiftChip, myAssign } from './common';
import { mySkillShifts } from './Avail';

export type K = '休み' | '遅刻' | '早退' | '希望休' | '休憩' | '退勤' | '入れる日' | '来月の希望';
export const ACTIONS: { k: K; label: string; icon: string; hint: string; legacy?: boolean }[] = [
  { k: '来月の希望', label: '来月の希望', icon: 'edit_calendar', hint: '休み希望・入れる日をカレンダーで' },
  { k: '休み', label: '休み', icon: 'event_busy', hint: '勤務日を休む' },
  { k: '遅刻', label: '遅刻', icon: 'schedule', hint: '出勤が遅れる' },
  { k: '早退', label: '早退', icon: 'logout', hint: '早めに帰る' },
  { k: '希望休', label: '希望休', icon: 'beach_access', hint: '休みを希望する', legacy: true },
  { k: '休憩', label: '休憩の希望', icon: 'free_breakfast', hint: '休憩の時間帯' },
  { k: '退勤', label: '退勤時刻の希望', icon: 'directions_car', hint: '帰る時刻の上限' },
  { k: '入れる日', label: '入れる日を出す', icon: 'event_available', hint: '欠員が出たら優先して連絡', legacy: true },
];
const REASONS = ['体調不良', '子どもの送迎', '子どもの熱', '通院', '家族の事情', '私用'];

export function ActionGrid({ onPick }: { onPick: (k: K) => void }) {
  return (
    <div class="agrid">
      {ACTIONS.filter((a) => !a.legacy).map((a) => <button key={a.k} class="abtn" onClick={() => onPick(a.k)}><span class="aic"><Icon n={a.icon} /></span><b>{a.label}</b><span class="small">{a.hint}</span></button>)}
    </div>
  );
}

export function AiSheet({ s, kind, onClose, onSent }: { s: State; kind: K; onClose: () => void; onSent: () => void }) {
  const [month, setMonth] = useState(s.today.slice(0, 7) + '-01');
  const [dates, setDates] = useState<string[]>([]);
  const [mins, setMins] = useState<number | null>(null); // 遅刻の分数
  const [time, setTime] = useState<string>(''); // 早退・休憩・退勤の時刻
  const [reason, setReason] = useState('');
  const [shiftSel, setShiftSel] = useState<string>(''); // 入れる日：勤務帯（空＝どれでも）
  const needDate = kind === '休み' || kind === '遅刻' || kind === '早退' || kind === '希望休' || kind === '入れる日';
  const date = dates[0];
  const asg = date ? myAssign(s, date) : undefined;
  const row = date ? buildDay(s.assignments, date).find((r) => r.staff.id === MY_ID && !r.tail) : undefined;
  const night = asg?.shift === '夜勤';
  const ymd = (d: string) => fmtMD(d).replace(/（.）/, '');
  const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

  const pick = (d: string) => {
    if (kind === '希望休' || kind === '入れる日') setDates(dates.includes(d) ? dates.filter((x) => x !== d) : [...dates, d].sort());
    else { setDates([d]); setMins(null); setTime(''); }
  };
  const why = reason ? `理由は${reason}です。` : '';
  const sentence = (() => {
    if (kind === '休憩') return time ? `休憩は${time}ごろがいい。` : '';
    if (kind === '入れる日') return dates.length ? `${dates.map(md).join('と')}${shiftSel ? `の${shiftSel}` : ''}は入れます。` : '';
    if (kind === '退勤') return time ? `いつも${time}までに帰りたい。${why}` : '';
    if (!date) return '';
    const sh = asg ? asg.shift : '';
    if (kind === '休み') return `${md(date)}の${sh}を休ませてください。${why}`;
    if (kind === '希望休') return dates.length ? `${dates.map(md).join('と')}を希望休にしたい。${why}` : '';
    if (kind === '遅刻') { if (!mins) return ''; if (night && mins > 180) return `${md(date)}の${sh}、${fmtHM(SHIFTS.夜勤.start + mins)}から出勤します（遅刻）。${why}`; return `${md(date)}の${sh}、${mins}分遅れます。${why}`; }
    if (kind === '早退') return time ? `${md(date)}の${sh}は${night && time < '12:00' ? '翌' : ''}${time}に早退したい（早退）。${why}` : '';
    return '';
  })();

  // Gemini が整えた文。取得中・失敗・無効のときは定型文（sentence）をそのまま使う
  const cKind = kind === '休み' || kind === '遅刻' || kind === '早退' ? kind : null;
  const cReq: ComposeIn | null = cKind && sentence && date && asg && reason ? { kind: cKind, date, shift: asg.shift, reason, ...(kind === '遅刻' && mins ? { detail: `${mins}分遅れ` } : {}), ...(kind === '早退' && time ? { detail: `${time}退勤` } : {}) } : null;
  const cKey = cReq ? JSON.stringify(cReq) : '';
  const [composed, setComposed] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!cReq) { setBusy(false); return; }
    const ctl = new AbortController(); let live = true; setBusy(true);
    composeEmployee(cReq, ctl.signal).then((t) => { if (!live) return; setBusy(false); if (t) setComposed({ key: cKey, text: t }); });
    return () => { live = false; ctl.abort(); };
  }, [cKey]);
  // 既存のルールで定型文と同じ内容（種類・日付）に読めない文は使わず、定型文に戻す
  const sig = (t: string) => proposeFromText(t, MY_ID, s.today, s.assignments, s.collection.month).items.map((i) => `${i.type}${i.kind ?? ''}${i.date ?? ''}`).join();
  const aiText = composed && composed.key === cKey && cReq && sig(composed.text) === sig(sentence) ? composed.text : '';
  const shown = aiText || sentence;

  const title = ACTIONS.find((a) => a.k === kind)!.label;
  const canPickDay = (d: string) => (kind === '入れる日' ? d > s.today && !(myAssign(s, d) && myAssign(s, d)!.status !== 'absent') : kind === '希望休' ? d > s.today : d >= s.today && !!myAssign(s, d) && myAssign(s, d)!.status !== 'absent');
  // 早退時刻候補：その日の業務ブロックの開始（夜勤は日付をまたがない範囲）
  const blockTimes = (row?.blocks ?? []).filter((b) => b.kind !== 'break' && b.kind !== 'nap' && b.start > (asg ? SHIFTS[asg.shift].start : 0));

  const send = () => { askShiftMaker(MY_ID, shown); onSent(); };
  return (
    <Modal title={title} onClose={onClose} footer={<><button class="btn" onClick={onClose}>やめる</button><button class="btn pri" disabled={!sentence} onClick={send}>シフト作成君に送る</button></>}>
      <div class="stack">
        {needDate && (
          <div>
            <div class="sec-title" style="margin-top:0">1. 日にちを選ぶ{kind === '希望休' ? '（複数選べます）' : kind === '入れる日' ? '（勤務のない日。複数選べます）' : '（勤務のある日）'}</div>
            <MiniCal month={month} onMonth={setMonth} today={s.today} minMonth={s.today.slice(0, 7) + '-01'}
              cell={(d) => { const a = myAssign(s, d); const ok = canPickDay(d); return { disabled: !ok, selected: dates.includes(d), content: a && a.status !== 'absent' ? <ShiftChip shift={a.shift} /> : <span class="off">休</span> }; }}
              onPick={pick} />
          </div>
        )}
        {kind === '入れる日' && (
          <div>
            <div class="sec-title" style="margin-top:0">2. 入れる勤務帯</div>
            <div class="row" style="flex-wrap:wrap"><button class={`opt${shiftSel === '' ? ' on' : ''}`} aria-pressed={shiftSel === ''} onClick={() => setShiftSel('')}>どれでも</button>{mySkillShifts().map((k) => <button key={k} class={`opt${shiftSel === k ? ' on' : ''}`} aria-pressed={shiftSel === k} onClick={() => setShiftSel(k)}>{k}</button>)}</div>
            <p class="small" style="margin-top:8px">欠員が出たとき、この日・勤務帯なら優先して連絡します。出勤の確定ではなく、断っても評価に影響しません。</p>
          </div>
        )}
        {kind === '遅刻' && date && asg && (
          <div>
            <div class="sec-title" style="margin-top:0">2. どのくらい遅れる？</div>
            <div class="row" style="flex-wrap:wrap">{[15, 30, 60].map((m) => <button key={m} class={`opt${mins === m ? ' on' : ''}`} aria-pressed={mins === m} onClick={() => setMins(m)}>{m === 60 ? '1時間' : `${m}分`}</button>)}</div>
            {night && <><p class="small" style="margin:8px 0 4px">もっと遅れる場合は、出勤できる時刻を選ぶ</p><div class="row" style="flex-wrap:wrap">{[1260, 1320, 1380, 1440, 1500].map((t) => <button key={t} class={`opt${mins === t - SHIFTS.夜勤.start ? ' on' : ''}`} aria-pressed={mins === t - SHIFTS.夜勤.start} onClick={() => setMins(t - SHIFTS.夜勤.start)}>{fmtMin(t)}から</button>)}</div></>}
            <p class="small" style="margin:8px 0 4px">または、その日の予定から「ここから出勤する」時刻を選ぶ</p>
            <Sched blocks={blockTimes.filter((b) => b.start - SHIFTS[asg.shift].start <= 180)} sel={mins !== null ? SHIFTS[asg.shift].start + mins : null} onPick={(t) => setMins(t - SHIFTS[asg.shift].start)} />
          </div>
        )}
        {kind === '早退' && date && asg && (
          <div>
            <div class="sec-title" style="margin-top:0">2. 何時に帰る？（予定から選ぶ）</div>
            {night && <p class="small">夜勤は翌朝（09:30）までの時刻を選べます。</p>}
            <div class="row" style="flex-wrap:wrap;margin-bottom:8px">{[1, 2, 3].map((h) => { const t = SHIFTS[asg.shift].end - h * 60; const lbl = fmtHM(t); return <button key={h} class={`opt${time === lbl ? ' on' : ''}`} onClick={() => setTime(lbl)}>{h}時間早く（{lbl}）</button>; })}</div>
            <Sched blocks={blockTimes} sel={time ? undefined : null} selLabel={time} onPick={(t) => setTime(fmtHM(t))} />
          </div>
        )}
        {kind === '休憩' && (
          <div>
            <div class="sec-title" style="margin-top:0">1. 休憩したい時間帯</div>
            <p class="small">日勤帯・夜勤の仮眠、それぞれ選べます。</p>
            <div class="row" style="flex-wrap:wrap;margin:8px 0">{['12:00', '12:30', '13:00', '13:30', '14:00'].map((t) => <button key={t} class={`opt${time === t ? ' on' : ''}`} onClick={() => setTime(t)}>{t}</button>)}</div>
            <div class="small">夜勤の仮眠</div>
            <div class="row" style="flex-wrap:wrap;margin-top:4px">{['23:00', '00:30', '02:00', '03:00'].map((t) => <button key={t} class={`opt${time === t ? ' on' : ''}`} onClick={() => setTime(t)}>{t}</button>)}</div>
          </div>
        )}
        {kind === '退勤' && (
          <div>
            <div class="sec-title" style="margin-top:0">1. 帰りたい時刻（これ以降は勤務できない）</div>
            <div class="row" style="flex-wrap:wrap">{['15:00', '16:00', '17:00', '18:00'].map((t) => <button key={t} class={`opt${time === t ? ' on' : ''}`} onClick={() => setTime(t)}>{t}</button>)}</div>
          </div>
        )}
        {kind !== '休憩' && kind !== '入れる日' && (
          <div>
            <div class="sec-title" style="margin-top:0">{needDate ? (kind === '休み' || kind === '希望休' ? '2' : '3') : '2'}. 理由（任意）</div>
            <div class="row" style="flex-wrap:wrap">{REASONS.map((r) => <button key={r} class={`opt${reason === r ? ' on' : ''}`} aria-pressed={reason === r} onClick={() => setReason(reason === r ? '' : r)}>{r}</button>)}</div>
          </div>
        )}
        <div class="sum"><div class="small">シフト作成君に送る内容</div><div>{shown || '選ぶとここに文章が表示されます'}</div>{aiText ? <div class="small" style="margin-top:4px"><Icon n="auto_awesome" sm /> AIが作成</div> : busy && sentence ? <div class="small" style="margin-top:4px;opacity:.6">AIで整えています…</div> : null}</div>
        <p class="small">送ると読み取り結果が表示されます。内容を確認して{kind === '入れる日' ? '「この内容で反映」を押すと登録されます（リーダーの承認は不要です）。' : '「この内容で反映」を押すまで、シフトは変わりません。'}</p>
        {void unitName}{void ymd}{void addDays}
      </div>
    </Modal>
  );
}

/** 縦のミニ時間割：ブロックをタップして時刻を選ぶ */
function Sched({ blocks, sel, selLabel, onPick }: { blocks: { start: number; end: number; kind: keyof typeof TASKS; label: string }[]; sel?: number | null; selLabel?: string; onPick: (t: number) => void }) {
  return (
    <ol class="tl mini">
      {blocks.map((b, i) => { const t = TASKS[b.kind]; const g = TASK_GROUPS[t.group]; const on = sel === b.start || (selLabel && selLabel === fmtHM(b.start)); return (
        <li key={i}><button class={`tl-i${on ? ' cur' : ''}`} style={`--tc:${t.fg};--tb:${t.bg};--bar:${g.bar};width:100%;text-align:left`} onClick={() => onPick(b.start)}>
          <div class="tl-time">{fmtMin(b.start)}</div><div class="tl-body"><b>{b.label}</b></div>{on && <Icon n="check" sm />}
        </button></li>); })}
      {blocks.length === 0 && <li class="small">選べる時間帯がありません。</li>}
    </ol>
  );
}
