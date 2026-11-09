import { useState } from 'preact/hooks';
import type { State } from '../core/store';
import { savePrefs, saveSettings } from '../core/store';
import { MY_ID, SHIFT_ORDER, UNITS, staffById, unitName } from '../core/facility';
import type { ShiftCode } from '../core/types';
import { DemoBar, SkillChips } from '../shared/ui';
import type { Ctx } from './common';

const Sw = ({ on, onChange, label, help }: { on: boolean; onChange: (v: boolean) => void; label: string; help?: string }) => (
  <button class="line sw-line" style="width:100%" role="switch" aria-checked={on} onClick={() => onChange(!on)}><span style="flex:1;text-align:left"><b style="font-weight:500">{label}</b>{help && <span class="small">{help}</span>}</span><span class={`sw${on ? ' on' : ''}`}><i /></span></button>
);

export function Settings({ s, c }: { s: State; c: Ctx }) {
  const me = staffById(MY_ID); const st = s.settings[MY_ID]; const pr = s.prefs[MY_ID];
  const [brk, setBrk] = useState(pr.breakPref ?? '');
  const [lv, setLv] = useState(pr.leaveBy ?? '');
  const [lr, setLr] = useState(pr.leaveReason ?? '');
  const [hope, setHope] = useState<ShiftCode[]>(pr.shiftHope);
  const dirty = brk !== (pr.breakPref ?? '') || lv !== (pr.leaveBy ?? '') || lr !== (pr.leaveReason ?? '') || hope.join() !== pr.shiftHope.join();
  const save = () => {
    const parts: string[] = [];
    if (brk !== (pr.breakPref ?? '')) parts.push(`休憩希望「${pr.breakPref ?? '未設定'}」→「${brk || '未設定'}」`);
    if (lv !== (pr.leaveBy ?? '') || lr !== (pr.leaveReason ?? '')) parts.push(`退勤上限「${pr.leaveBy ?? '未設定'}${pr.leaveReason ? `（${pr.leaveReason}）` : ''}」→「${lv || '未設定'}${lr ? `（${lr}）` : ''}」`);
    if (hope.join() !== pr.shiftHope.join()) parts.push(`勤務帯希望「${pr.shiftHope.join('・') || '未設定'}」→「${hope.join('・') || '未設定'}」`);
    savePrefs(MY_ID, { breakPref: brk || undefined, leaveBy: lv || undefined, leaveReason: lr || undefined, shiftHope: hope }, `${parts.join(' ／ ')}（本人が設定から変更）`);
    c.toast('希望を保存しました。次回以降の案に反映されます');
  };
  return (
    <div class="pg">
      <h1 class="ptitle">設定</h1>
      <section class="card"><h2 class="h2">プロフィール</h2>
        <dl class="kv" style="margin-top:8px"><dt>氏名</dt><dd>{me.name}（{MY_ID}）</dd><dt>役職・雇用</dt><dd>{me.role}／{me.employment}</dd><dt>資格</dt><dd>{me.license}</dd><dt>所属</dt><dd>{unitName(me.homeUnit)}（{UNITS.find((u) => u.id === me.homeUnit)?.floor}階）</dd><dt>勤続</dt><dd>{me.years}年</dd></dl>
        <div class="sec-title">スキル（変更はリーダーに依頼）</div><SkillChips ids={me.skills} />
      </section>
      <section class="card" style="padding:4px 16px"><h2 class="h2" style="padding:12px 0 0">通知</h2>
        <Sw label="アプリへの通知" help="シフトの変更や打診が届きます" on={st.push} onChange={(v) => saveSettings(MY_ID, { push: v })} />
        <Sw label="メールでも受け取る" help="登録のメールアドレスにも送ります" on={st.mail} onChange={(v) => saveSettings(MY_ID, { mail: v })} />
        <Sw label="夜間は通知を抑える" help="22:00〜7:00。この時間は代わりの出勤の打診も届きません" on={st.quietNight} onChange={(v) => saveSettings(MY_ID, { quietNight: v })} />
      </section>
      <section class="card"><h2 class="h2">表示</h2><p class="small">見やすい大きさを選べます。</p><div class="field" style="margin-top:8px"><label>文字サイズ</label><div class="seg"><button aria-pressed={st.textSize === 'standard'} onClick={() => saveSettings(MY_ID, { textSize: 'standard' })}>標準</button><button aria-pressed={st.textSize === 'large'} onClick={() => saveSettings(MY_ID, { textSize: 'large' })}>大きい</button></div></div></section>
      <section class="card stack"><div><h2 class="h2">勤務条件・希望</h2>
        <p class="small">希望は月次の案づくりで考慮されます（必須条件ではありません）。</p></div>
        <div class="field"><label>休憩の希望</label><input class="input" value={brk} placeholder="例：02:00ごろ（夜勤）" onInput={(e) => setBrk((e.target as HTMLInputElement).value)} /></div>
        <div class="field"><label>退勤の上限時刻</label><input class="input" type="time" value={lv} onInput={(e) => setLv((e.target as HTMLInputElement).value)} /></div>
        <div class="field"><label>退勤上限の理由（任意）</label><input class="input" value={lr} placeholder="例：送迎のため" onInput={(e) => setLr((e.target as HTMLInputElement).value)} /></div>
        <div class="field"><label>勤務帯の希望</label><div class="row" style="flex-wrap:wrap">{SHIFT_ORDER.map((x) => <button key={x} class={`opt${hope.includes(x) ? ' on' : ''}`} aria-pressed={hope.includes(x)} onClick={() => setHope(hope.includes(x) ? hope.filter((y) => y !== x) : [...hope, x])}>{x}</button>)}</div></div>
        <button class="btn pri block" disabled={!dirty} onClick={save}>変更を保存</button>
        <div class="sec-title" style="margin:8px 0 0">変更履歴</div>
        {pr.history.length ? <ul class="hist">{pr.history.map((h, i) => <li key={i}><span class="small">{h.at}</span><br />{h.text}</li>)}</ul> : <p class="muted">まだ変更はありません。チャットの「シフト作成君」に伝えても保存できます。</p>}
      </section>
      <DemoBar role="employee" />
    </div>
  );
}
