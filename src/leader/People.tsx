import { useState } from 'preact/hooks';
import { RESIDENTS, SKILLS, STAFF, UNITS, unitName } from '../core/facility';
import type { SkillId, ShiftCode } from '../core/types';
import type { State } from '../core/store';
import { Icon, Modal } from '../shared/ui';
import { SkillMini } from './util';
import { ResidentDetailModal, StaffDetailModal, type StaffTab } from './PeopleDetail';
import { residentDetail_, staffDetail_ } from '../core/detail';

export function People({ s }: { s: State }) {
  const [tab, setTab] = useState<'staff' | 'res'>('staff');
  return (
    <div class="page scroll">
      <div class="row spread" style="margin-bottom:12px;flex-wrap:wrap"><div class="seg"><button aria-pressed={tab === 'staff'} onClick={() => setTab('staff')}>職員</button><button aria-pressed={tab === 'res'} onClick={() => setTab('res')}>入居者</button></div><span class="chip warn"><Icon n="lock" sm /> すべて架空の合成データ・リーダーのみ閲覧</span></div>
      {tab === 'staff' ? <Staff s={s} /> : <Residents />}
    </div>
  );
}

function Staff({ s }: { s: State }) {
  const [q, setQ] = useState(''); const [unit, setUnit] = useState(''); const [shift, setShift] = useState(''); const [skill, setSkill] = useState(''); const [pf, setPf] = useState<{ id: string; tab: StaffTab } | null>(null); const [fo, setFo] = useState(false);
  const list = STAFF.filter((x) => x.shifts.length > 0 && (!q || x.name.includes(q) || x.kana.includes(q)) && (!unit || x.homeUnit === unit) && (!shift || x.shifts.includes(shift as ShiftCode)) && (!skill || x.skills.includes(skill as SkillId)));
  const nf = [unit, shift, skill].filter(Boolean).length;
  return (<>
    <div class="row" style="margin-bottom:12px">
      <input class="input" style="flex:1" placeholder="名前で検索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="名前で検索" />
      <button class="btn" onClick={() => setFo(true)}><Icon n="tune" sm /> 絞り込み{nf ? `（${nf}）` : ''}</button>
    </div>
    <p class="muted" style="margin-bottom:8px">{list.length}名</p>
    <div class="cards">{list.map((x) => { const pr = s.prefs[x.id]; const d = staffDetail_(x.id)!; return (
      <div key={x.id} class="card pcard">
        <button class="pmain" onClick={() => setPf({ id: x.id, tab: '希望' })}>
          <div class="row spread"><b>{x.name}</b><span class="chip">{unitName(x.homeUnit)}</span></div>
          <div class="small">{x.role}・{x.employment}・{d.empNo}</div>
          <div style="margin-top:6px"><SkillMini s={x} max={3} /></div>
          <div class="small" style="margin-top:6px">勤務可：{x.shifts.join('・')}{pr.leaveBy ? `／${pr.leaveBy}まで` : ''}</div>
          <div class="small">希望：{d.wish.shifts}・{d.wish.nights}</div>
          <div class="small">契約：{d.hr.contract.split('（')[0]}・{d.hr.pay}</div>
        </button>
        <div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn sm" onClick={() => setPf({ id: x.id, tab: '希望' })}>希望</button><button class="btn sm" onClick={() => setPf({ id: x.id, tab: '勤務実績' })}>履歴</button><button class="btn sm" onClick={() => setPf({ id: x.id, tab: '人事' })}>人事</button></div>
      </div>); })}</div>
    {!list.length && <div class="empty">条件に合う職員がいません。絞り込みを解除してください。</div>}
    {fo && <Modal title="絞り込み" onClose={() => setFo(false)} footer={<><button class="btn" onClick={() => { setUnit(''); setShift(''); setSkill(''); }}>解除</button><button class="btn pri" onClick={() => setFo(false)}>{list.length}名を表示</button></>}>
      <div class="stack">
        <div class="field"><label>ユニット</label><select class="input" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}><option value="">すべて</option>{UNITS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div class="field"><label>勤務帯</label><select class="input" value={shift} onChange={(e) => setShift((e.target as HTMLSelectElement).value)}><option value="">すべて</option>{['早番', '日勤', '遅番', '夜勤'].map((x) => <option key={x}>{x}</option>)}</select></div>
        <div class="field"><label>スキル</label><select class="input" value={skill} onChange={(e) => setSkill((e.target as HTMLSelectElement).value)}><option value="">すべて</option>{(Object.keys(SKILLS) as SkillId[]).map((k) => <option key={k} value={k}>{SKILLS[k].label}</option>)}</select></div>
      </div></Modal>}
    {pf && <StaffDetailModal id={pf.id} s={s} tab={pf.tab} onClose={() => setPf(null)} />}
  </>);
}

function Residents() {
  const [u, setU] = useState(''); const [q, setQ] = useState(''); const [lv, setLv] = useState(''); const [cond, setCond] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const match = (r: typeof RESIDENTS[number]) => {
    const d = residentDetail_(r.id)!;
    if (q && !(r.name.includes(q) || r.room.includes(q))) return false;
    if (lv && String(r.careLevel) !== lv) return false;
    if (cond === 'medical') return r.medical.length > 0;
    if (cond === 'fall') return r.fallRisk === 'high';
    if (cond === 'swallow') return d.risks.aspiration.startsWith('高');
    if (cond === 'dementia') return ['Ⅲa', 'Ⅲb', 'Ⅳ'].includes(d.independence.dementia);
    if (cond === 'night') return d.sleep.night.includes('不穏');
    return true;
  };
  const n = RESIDENTS.filter((r) => (!u || r.unitId === u) && match(r)).length;
  return (<div class="stack" style="gap:16px">
    <div class="row" style="flex-wrap:wrap">
      <input class="input" style="flex:1;min-width:160px" placeholder="名前・居室で検索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="名前・居室で検索" />
      <select class="input" style="width:auto" value={u} onChange={(e) => setU((e.target as HTMLSelectElement).value)} aria-label="ユニット"><option value="">ユニット：すべて</option>{UNITS.map((x) => <option key={x.id} value={x.id}>{x.floor}階 {x.name}</option>)}</select>
      <select class="input" style="width:auto" value={lv} onChange={(e) => setLv((e.target as HTMLSelectElement).value)} aria-label="要介護度"><option value="">要介護度：すべて</option>{[1, 2, 3, 4, 5].map((x) => <option key={x} value={x}>要介護{x}</option>)}</select>
      <select class="input" style="width:auto" value={cond} onChange={(e) => setCond((e.target as HTMLSelectElement).value)} aria-label="状態"><option value="">状態：すべて</option><option value="medical">医療的ケアあり</option><option value="fall">転倒リスク高</option><option value="swallow">誤嚥に注意</option><option value="dementia">認知症 Ⅲ以上</option><option value="night">夜間不穏</option></select>
    </div>
    <p class="muted">{n}名</p>
    {UNITS.filter((x) => !u || x.id === u).map((x) => { const rs = RESIDENTS.filter((r) => r.unitId === x.id && match(r)); return rs.length ? <section key={x.id}><h3 class="h3" style="margin-bottom:8px">{x.floor}階 {x.name}</h3>
      <div class="rgrid">{rs.map((r) => { const d = residentDetail_(r.id)!; return <button key={r.id} class="rcard" onClick={() => setOpen(r.id)}>
        <div class="row spread"><b style="font-weight:500">{r.room}</b><span class="small">要介護{r.careLevel}</span></div><div>{r.name}さん</div>
        <div class="small">{r.age}歳・{r.sex}</div>
        <div class="small">食事：{d.meal.form}</div>
        <div class="row wrap" style="gap:4px;margin-top:4px">{r.medical.length > 0 && <span class="mini bad">医療的ケア</span>}{r.fallRisk === 'high' && <span class="mini warn">転倒注意</span>}{d.risks.aspiration.startsWith('高') && <span class="mini warn">誤嚥注意</span>}{['Ⅲa', 'Ⅲb', 'Ⅳ'].includes(d.independence.dementia) && <span class="mini">認知症 {d.independence.dementia}</span>}</div></button>; })}</div></section> : null; })}
    {n === 0 && <div class="empty">条件に合う入居者がいません。絞り込みを変えてください。</div>}
    <p class="small"><Icon n="info" sm /> すべて架空の合成データです。リーダー画面でのみ閲覧できます。</p>
    {open && <ResidentDetailModal id={open} onClose={() => setOpen(null)} />}
  </div>);
}
