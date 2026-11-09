import { useState } from 'preact/hooks';
import { RESIDENTS, SKILLS, STAFF, UNITS, unitName } from '../core/facility';
import type { SkillId, ShiftCode } from '../core/types';
import type { State } from '../core/store';
import { Icon, Modal } from '../shared/ui';
import { SkillMini } from './util';

export function People({ s, openStaff, openResident }: { s: State; openStaff: (id: string) => void; openResident: (id: string) => void }) {
  const [tab, setTab] = useState<'staff' | 'res'>('staff');
  return (
    <div class="page scroll">
      <div class="seg" style="margin-bottom:12px"><button aria-pressed={tab === 'staff'} onClick={() => setTab('staff')}>職員</button><button aria-pressed={tab === 'res'} onClick={() => setTab('res')}>入居者</button></div>
      {tab === 'staff' ? <Staff s={s} openStaff={openStaff} /> : <Residents openResident={openResident} />}
    </div>
  );
}

function Staff({ s, openStaff }: { s: State; openStaff: (id: string) => void }) {
  const [q, setQ] = useState(''); const [unit, setUnit] = useState(''); const [shift, setShift] = useState(''); const [skill, setSkill] = useState(''); const [pf, setPf] = useState<string | null>(null); const [fo, setFo] = useState(false);
  const list = STAFF.filter((x) => x.shifts.length > 0 && (!q || x.name.includes(q) || x.kana.includes(q)) && (!unit || x.homeUnit === unit) && (!shift || x.shifts.includes(shift as ShiftCode)) && (!skill || x.skills.includes(skill as SkillId)));
  const nf = [unit, shift, skill].filter(Boolean).length;
  const p = pf ? s.prefs[pf] : null;
  return (<>
    <div class="row" style="margin-bottom:12px">
      <input class="input" style="flex:1" placeholder="名前で検索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="名前で検索" />
      <button class="btn" onClick={() => setFo(true)}><Icon n="tune" sm /> 絞り込み{nf ? `（${nf}）` : ''}</button>
    </div>
    <p class="muted" style="margin-bottom:8px">{list.length}名</p>
    <div class="cards">{list.map((x) => { const pr = s.prefs[x.id]; return (
      <div key={x.id} class="card pcard">
        <button class="pmain" onClick={() => openStaff(x.id)}>
          <div class="row spread"><b>{x.name}</b><span class="chip">{unitName(x.homeUnit)}</span></div>
          <div class="small">{x.role}・{x.employment}</div>
          <div style="margin-top:6px"><SkillMini s={x} max={3} /></div>
          <div class="small" style="margin-top:6px">勤務可：{x.shifts.join('・')}{pr.leaveBy ? `／${pr.leaveBy}まで` : ''}</div>
        </button>
        <button class="btn sm" onClick={() => setPf(x.id)}>希望と履歴</button>
      </div>); })}</div>
    {!list.length && <div class="empty">条件に合う職員がいません。絞り込みを解除してください。</div>}
    {fo && <Modal title="絞り込み" onClose={() => setFo(false)} footer={<><button class="btn" onClick={() => { setUnit(''); setShift(''); setSkill(''); }}>解除</button><button class="btn pri" onClick={() => setFo(false)}>{list.length}名を表示</button></>}>
      <div class="stack">
        <div class="field"><label>ユニット</label><select class="input" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}><option value="">すべて</option>{UNITS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div class="field"><label>勤務帯</label><select class="input" value={shift} onChange={(e) => setShift((e.target as HTMLSelectElement).value)}><option value="">すべて</option>{['早番', '日勤', '遅番', '夜勤'].map((x) => <option key={x}>{x}</option>)}</select></div>
        <div class="field"><label>スキル</label><select class="input" value={skill} onChange={(e) => setSkill((e.target as HTMLSelectElement).value)}><option value="">すべて</option>{(Object.keys(SKILLS) as SkillId[]).map((k) => <option key={k} value={k}>{SKILLS[k].label}</option>)}</select></div>
      </div></Modal>}
    {pf && p && <Modal title={`${STAFF.find((x) => x.id === pf)!.name}さんの希望`} onClose={() => setPf(null)}>
      <dl class="kv"><dt>休憩希望</dt><dd>{p.breakPref ?? '未登録'}</dd><dt>退勤上限</dt><dd>{p.leaveBy ? `${p.leaveBy}（${p.leaveReason ?? '理由未記入'}）` : '未登録'}</dd><dt>勤務帯希望</dt><dd>{p.shiftHope.length ? p.shiftHope.join('・') : '未登録'}</dd></dl>
      <p class="small" style="margin-top:8px">希望と必須制約は区別します。希望は次回以降の月次案・打診の順位付けに反映されます。</p>
      <div class="sec-title">変更履歴</div>
      {p.history.length ? <ul class="issues">{p.history.map((h, i) => <li key={i}><span class="small">{h.at}</span><br />{h.text}</li>)}</ul> : <p class="muted">履歴はまだありません。</p>}
    </Modal>}
  </>);
}

function Residents({ openResident }: { openResident: (id: string) => void }) {
  const [u, setU] = useState('');
  return (<div class="stack" style="gap:16px">
    <div class="field" style="max-width:240px"><select class="input" value={u} onChange={(e) => setU((e.target as HTMLSelectElement).value)} aria-label="ユニット"><option value="">ユニット：すべて</option>{UNITS.map((x) => <option key={x.id} value={x.id}>{x.floor}階 {x.name}</option>)}</select></div>
    {UNITS.filter((x) => !u || x.id === u).map((x) => <section key={x.id}><h3 class="h3" style="margin-bottom:8px">{x.floor}階 {x.name}</h3>
      <div class="rgrid">{RESIDENTS.filter((r) => r.unitId === x.id).map((r) => <button key={r.id} class="rcard" onClick={() => openResident(r.id)}>
        <div class="row spread"><b style="font-weight:500">{r.room}</b><span class="small">要介護{r.careLevel}</span></div><div>{r.name}さん</div>
        <div class="row wrap" style="gap:4px;margin-top:4px">{r.medical.length > 0 && <span class="mini bad">医療的ケア</span>}{r.fallRisk === 'high' && <span class="mini warn">転倒注意</span>}</div></button>)}</div></section>)}
    <p class="small"><Icon n="info" sm /> 配置の根拠になる最小限の架空情報のみ表示します。</p>
  </div>);
}
