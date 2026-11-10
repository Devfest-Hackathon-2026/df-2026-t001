import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { SKILLS, TASK_GROUPS, UNITS, residentsOf, staffById, unitName } from '../core/facility';
import type { Resident, SkillId, Staff } from '../core/types';
import { resetDemo } from '../core/store';

export const Icon = ({ n, fill, sm }: { n: string; fill?: boolean; sm?: boolean }) => <span class={`ms${fill ? ' fill' : ''}${sm ? ' sm' : ''}`} aria-hidden="true">{n}</span>;

const modalStack: object[] = [];
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; wide?: boolean }) {
  useEffect(() => { const me = {}; modalStack.push(me); const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && modalStack[modalStack.length - 1] === me) onClose(); }; window.addEventListener('keydown', f); const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { const i = modalStack.indexOf(me); if (i >= 0) modalStack.splice(i, 1); window.removeEventListener('keydown', f); document.body.style.overflow = prev; }; }, []);
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-h"><h2>{title}</h2><button class="iconbtn" onClick={onClose} aria-label="閉じる"><Icon n="close" /></button></div>
        <div class="modal-b">{children}</div>
        {footer && <div style="padding:12px 24px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">{footer}</div>}
      </div>
    </div>
  );
}

export const SkillChips = ({ ids }: { ids: SkillId[] }) => <span class="row" style="flex-wrap:wrap;gap:4px">{ids.length ? ids.map((k) => <span key={k} class={`chip ${k === 'medical' ? 'bad' : 'pri'}`}>{SKILLS[k].label}</span>) : <span class="muted">特記スキルなし</span>}</span>;


export function Legend() {
  return <div class="row" style="flex-wrap:wrap;gap:6px">{(Object.keys(TASK_GROUPS) as (keyof typeof TASK_GROUPS)[]).map((g) => <span key={g} class="chip" style={`background:${TASK_GROUPS[g].bg};color:${TASK_GROUPS[g].fg}${g === 'rest' ? ';border:1px dashed var(--line)' : ''}`}>{TASK_GROUPS[g].label}</span>)}</div>;
}

export function StaffModal({ id, onClose, onOpenResident }: { id: string; onClose: () => void; onOpenResident?: (id: string) => void }) {
  const s: Staff = staffById(id);
  return (
    <Modal title={s.name} onClose={onClose}>
      <p class="muted">{s.kana}　{s.role}／{s.employment}</p>
      <dl class="kv" style="margin-top:16px">
        <dt>年齢・勤続</dt><dd>{s.age}歳・勤続{s.years}年</dd>
        <dt>資格</dt><dd>{s.license}</dd>
        <dt>所属ユニット</dt><dd>{unitName(s.homeUnit)}（{UNITS.find((u) => u.id === s.homeUnit)?.floor}階）</dd>
        <dt>勤務可能</dt><dd>{s.shifts.length ? s.shifts.join('・') : '—（外部応募）'}</dd>
        <dt>退勤上限</dt><dd>{s.leaveBy ? `${s.leaveBy}（${s.leaveReason ?? '理由未記入'}）` : '制約なし'}</dd>
        <dt>休憩希望</dt><dd>{s.breakPref ?? '特になし'}</dd>
      </dl>
      <div class="sec-title">スキル（医療的ケアは要件確認済みの職員のみ）</div>
      <SkillChips ids={s.skills} />
      <ul class="muted" style="margin:8px 0 0 20px">{s.skills.map((k) => <li key={k}>{SKILLS[k].label}：{SKILLS[k].note}</li>)}</ul>
      <p class="small" style="margin-top:16px">年齢だけで担当や候補から外しません。すべて架空のデータです。</p>
      {onOpenResident && <span />}
    </Modal>
  );
}

const lvChip = (l: string) => (l === '全介助' ? 'bad' : l === '一部介助' ? 'warn' : l === '見守り' ? 'pri' : '');
export function ResidentModal({ id, onClose }: { id: string; onClose: () => void }) {
  const r: Resident | undefined = residentsOf('U1').concat(residentsOf('U2'), residentsOf('U3'), residentsOf('U4')).find((x) => x.id === id);
  if (!r) return null;
  return (
    <Modal title={`${r.name}さん（${r.room}号室）`} onClose={onClose}>
      <p class="muted">{r.age}歳・{r.sex}／{unitName(r.unitId)}／要介護{r.careLevel}</p>
      <div class="sec-title">介助区分</div>
      <div class="row" style="flex-wrap:wrap">
        {(['meal', 'excretion', 'bath', 'transfer'] as const).map((k) => <span key={k} class={`chip ${lvChip(r.adl[k])}`}>{{ meal: '食事', excretion: '排泄', bath: '入浴', transfer: '移乗' }[k]}：{r.adl[k]}</span>)}
      </div>
      <div class="sec-title">医療的ケア</div>
      {r.medical.length ? <div class="row" style="flex-wrap:wrap">{r.medical.map((m) => <span class="chip bad" key={m}>{m}</span>)}</div> : <p class="muted">なし</p>}
      <div class="sec-title">注意点</div>
      <ul style="margin-left:20px">{r.notes.length ? r.notes.map((n) => <li key={n}>{n}</li>) : <li class="muted">特記なし</li>}</ul>
      <dl class="kv" style="margin-top:16px"><dt>転倒リスク</dt><dd>{{ low: '低', mid: '中', high: '高' }[r.fallRisk]}</dd><dt>夜間の見回り</dt><dd>{r.nightCheck}</dd></dl>
      <p class="small" style="margin-top:16px">配置の根拠となる最小限の架空情報です。記録・申し送り・ナースコールは扱いません。</p>
    </Modal>
  );
}

/** デモ用操作領域（実際の職員・リーダー画面とは別枠） */
export function DemoBar({ role }: { role: 'employee' | 'leader' }) {
  const [ok, setOk] = useState(false);
  return (
    <div class="demo-bar">
      <span>デモ（架空データ）</span>
      <button onClick={() => { if (confirm('架空データを初期状態に戻します。よろしいですか？')) { resetDemo(); setOk(true); setTimeout(() => setOk(false), 1500); } }}>最初からやり直す</button>
      <a href={role === 'employee' ? './' : './employee.html'} style="color:var(--tx2)">{role === 'employee' ? 'リーダー画面を開く' : '従業員画面を開く'}</a>
      {ok && <span>初期化しました</span>}
    </div>
  );
}

export function useToast() {
  const [msg, setMsg] = useState('');
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 2600); return () => clearTimeout(t); }, [msg]);
  return [msg ? <div class="toast" role="status">{msg}</div> : null, setMsg] as const;
}
