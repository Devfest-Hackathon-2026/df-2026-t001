import { useState } from 'preact/hooks';
import type { State } from '../core/store';
import { submitHealth } from '../core/store';
import { MY_ID } from '../core/facility';
import { fmtLong } from '../core/dates';
import type { HealthCheck } from '../core/types';
import { Icon } from '../shared/ui';
import type { Ctx } from './common';

const SYM = ['発熱', '咳', 'のどの痛み', '下痢', '嘔吐', '倦怠感', '味覚・嗅覚の異常', 'なし'];
const HOUSE = ['症状なし', '症状あり', '検査中'];
const SLEEP: HealthCheck['sleep'][] = ['十分', 'やや不足', '不足'];

export function Health({ s, c }: { s: State; c: Ctx }) {
  const rec = s.health.find((h) => h.staffId === MY_ID && h.date === s.today);
  const [edit, setEdit] = useState(false);
  const [temp, setTemp] = useState(rec ? rec.temp.toFixed(1) : '');
  const [sym, setSym] = useState<string[]>(rec ? (rec.symptoms.length ? rec.symptoms : ['なし']) : []);
  const [house, setHouse] = useState(rec?.household ?? '');
  const [sleep, setSleep] = useState<string>(rec?.sleep ?? '');
  const [note, setNote] = useState(rec?.note ?? '');
  const [consult, setConsult] = useState(rec?.consult ?? false);
  const t = parseFloat(temp);
  const valid = t >= 34 && t <= 42 && sym.length > 0 && !!house && !!sleep;
  const step = (d: number) => setTemp((isNaN(t) ? 36.5 : Math.min(42, Math.max(34, Math.round((t + d) * 10) / 10))).toFixed(1));
  const toggle = (x: string) => setSym(x === 'なし' ? (sym.includes('なし') ? [] : ['なし']) : (sym.includes(x) ? sym.filter((y) => y !== x) : [...sym.filter((y) => y !== 'なし'), x]));
  const save = () => { submitHealth({ staffId: MY_ID, date: s.today, temp: t, symptoms: sym.filter((x) => x !== 'なし'), household: house, sleep: sleep as HealthCheck['sleep'], note: note.trim() || undefined, consult }); setEdit(false); c.toast('体調チェックを保存しました'); };
  const notes = (
    <p class="small">就業可否は本人とリーダーが相談して決めます。診断ではありません。入力内容は本人と許可された担当者だけが見られます（架空データ）。</p>
  );
  if (rec && !edit) {
    return (
      <div class="pg">
        <h1 class="ptitle">体調チェック</h1>
        <section class="card">
          <div class="row spread"><span class="muted">{fmtLong(s.today)}</span><span class="chip ok">入力済み {rec.at.slice(11)}</span></div>
          <dl class="kv" style="margin-top:12px"><dt>体温</dt><dd>{rec.temp.toFixed(1)}℃</dd><dt>症状</dt><dd>{rec.symptoms.length ? rec.symptoms.join('・') : 'なし'}</dd><dt>同居家族</dt><dd>{rec.household}</dd><dt>睡眠</dt><dd>{rec.sleep}</dd><dt>メモ</dt><dd>{rec.note ?? '—'}</dd><dt>相談</dt><dd>{rec.consult ? 'リーダーに相談したい' : '特になし'}</dd></dl>
          <button class="btn block" style="margin-top:16px" onClick={() => setEdit(true)}><Icon n="edit" />修正する</button>
        </section>
        {notes}
      </div>
    );
  }
  return (
    <div class="pg">
      <h1 class="ptitle">体調チェック</h1>
      <p class="muted">{fmtLong(s.today)}　出勤前に入力してください（1分ほど）。未入力は「問題なし」とは扱いません。</p>
      <section class="card stack" style="gap:0">
        <div class="q"><div class="lbl">1. 検温（℃）</div><p class="help">出勤前に測った体温を入れてください。</p>
          <div class="row"><button class="iconbtn step" aria-label="0.1下げる" onClick={() => step(-0.1)}><Icon n="remove" /></button>
            <input class="input temp" type="number" inputMode="decimal" step="0.1" min="34" max="42" placeholder="例：36.5" value={temp} onInput={(e) => setTemp((e.target as HTMLInputElement).value)} />
            <button class="iconbtn step" aria-label="0.1上げる" onClick={() => step(0.1)}><Icon n="add" /></button></div>
          {temp !== '' && !(t >= 34 && t <= 42) && <span class="small" style="color:var(--bad)">34.0〜42.0 の範囲で入力してください</span>}
        </div>
        <div class="q"><div class="lbl">2. 症状</div><p class="help">当てはまるものをすべて選びます。ない場合は「なし」。</p><div class="row" style="flex-wrap:wrap">{SYM.map((x) => <button key={x} class={`opt${sym.includes(x) ? ' on' : ''}`} aria-pressed={sym.includes(x)} onClick={() => toggle(x)}>{x}</button>)}</div></div>
        <div class="q"><div class="lbl">3. 同居家族の症状</div><p class="help">発熱・嘔吐・下痢など、感染症が疑われる症状。</p><div class="row" style="flex-wrap:wrap">{HOUSE.map((x) => <button key={x} class={`opt${house === x ? ' on' : ''}`} aria-pressed={house === x} onClick={() => setHouse(x)}>{x}</button>)}</div></div>
        <div class="q"><div class="lbl">4. 睡眠</div><div class="row" style="flex-wrap:wrap">{SLEEP.map((x) => <button key={x} class={`opt${sleep === x ? ' on' : ''}`} aria-pressed={sleep === x} onClick={() => setSleep(x)}>{x}</button>)}</div></div>
        <div class="q"><div class="lbl">5. メモ（任意）</div><textarea class="input" rows={2} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} /></div>
        <div class="q"><button class={`opt wide${consult ? ' on' : ''}`} aria-pressed={consult} onClick={() => setConsult(!consult)}><Icon n={consult ? 'check_circle' : 'radio_button_unchecked'} fill={consult} />リーダーに相談したい</button><p class="help" style="margin-top:6px">チェックすると、リーダーにだけ通知が届きます。</p></div>
      </section>
      <div class="sticky-act"><button class="btn pri block" disabled={!valid} onClick={save}>保存する</button>{!valid && <p class="small" style="margin-top:6px">体温・症状・同居家族・睡眠を選ぶと保存できます。</p>}</div>
      {notes}
    </div>
  );
}
