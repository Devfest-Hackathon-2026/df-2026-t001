import { useEffect, useState } from 'preact/hooks';
import { readAll, readNotice, useStore } from '../core/store';
import { FACILITY, MY_ID, SHIFTS, residentsOf, unitName } from '../core/facility';
import { fmtLong } from '../core/dates';
import { buildDay } from '../core/roster';
import { Icon, Modal, ResidentModal, StaffModal, useToast } from '../shared/ui';
import { Chat } from './Chat';
import { OfferCard } from './Offer';
import { Ctx, Tab } from './common';
import { Health } from './Health';
import { Home } from './Home';
import { Settings } from './Settings';
import { Shift } from './Shift';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'ホーム', icon: 'home' }, { id: 'shift', label: 'シフト', icon: 'calendar_month' }, { id: 'health', label: '体調', icon: 'favorite' },
  { id: 'chat', label: 'チャット', icon: 'chat' }, { id: 'settings', label: '設定', icon: 'settings' },
];
const fromHash = (): Tab => { const h = location.hash.replace('#', '') as Tab; return TABS.some((t) => t.id === h) ? h : 'home'; };

export function App() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>(fromHash);
  const [notices, setNotices] = useState(false);
  const [offer, setOffer] = useState<string | null>(null);
  const [staff, setStaff] = useState<string | null>(null);
  const [res, setRes] = useState<string | null>(null);
  const [unitList, setUnitList] = useState<string | null>(null);
  const [unitStaff, setUnitStaff] = useState<string | null>(null);
  const [toastNode, toast] = useToast();
  useEffect(() => { const f = () => setTab(fromHash()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => { document.documentElement.dataset.text = s.settings[MY_ID].textSize === 'large' ? 'large' : ''; }, [s.settings[MY_ID].textSize]);
  const go = (t: Tab) => { location.hash = t; setTab(t); setNotices(false); };
  const c: Ctx = { go, openNotices: () => setNotices(true), openStaff: setStaff, openResident: setRes, openUnitResidents: setUnitList, openUnitStaff: setUnitStaff, toast };
  const mine = s.notices.filter((n) => n.to === MY_ID).sort((a, b) => (a.at < b.at ? 1 : -1));
  const unread = mine.filter((n) => !n.read).length;

  const openLeaderChat = () => { setNotices(false); try { localStorage.setItem('emp-open-thread', 'leader'); } catch { /* ignore */ } go('chat'); setTimeout(() => window.dispatchEvent(new CustomEvent('emp-open-thread', { detail: 'leader' })), 0); };
  const open = (n: (typeof mine)[number]) => {
    readNotice(n.id);
    if (n.link?.startsWith('offer:')) { setNotices(false); setOffer(n.link.slice(6)); }
    else if (n.link === 'health') go('health'); else if (n.link === 'shift') go('shift');
  };

  return (
    <div class="emp">
      <header class="top">
        <div style="flex:1;min-width:0"><div class="fac">{FACILITY.name}</div><div class="small">{fmtLong(s.today)}</div></div>
        <button class="iconbtn" aria-label={`お知らせ${unread ? `（未読${unread}件）` : ''}`} onClick={() => setNotices(true)}><Icon n="notifications" />{unread > 0 && <span class="badge bell">{unread}</span>}</button>
      </header>
      <main class={`main${tab === 'chat' ? ' chat-mode' : ''}`}>
        {tab === 'home' && <Home s={s} c={c} />}
        {tab === 'shift' && <Shift s={s} c={c} />}
        {tab === 'health' && <Health s={s} c={c} />}
        {tab === 'chat' && <Chat s={s} c={c} />}
        {tab === 'settings' && <Settings s={s} c={c} />}
      </main>
      <nav class="nav" aria-label="メインメニュー">
        {TABS.map((t) => <button key={t.id} class={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}><span class="pill"><Icon n={t.icon} fill={tab === t.id} /></span><span>{t.label}</span></button>)}
      </nav>

      {notices && (
        <Modal title="お知らせ" onClose={() => setNotices(false)} footer={mine.length ? <button class="btn" onClick={() => readAll(MY_ID)}>すべて既読にする</button> : undefined}>
          {mine.length === 0 && <p class="muted">お知らせはまだありません。</p>}
          {mine.map((n) => { const adj = n.kind === 'shift' && n.title.includes('調整'); return (
            <div key={n.id} class="nrow">
              <button class="line" style="width:100%;align-items:flex-start" onClick={() => open(n)}>{n.read ? <span style="width:8px" /> : <span class="dot" style="margin-top:8px" />}<span style="text-align:left"><b>{n.title}</b><br /><span class="muted">{n.body}</span><br /><span class="small">{n.at.slice(5, 16)}</span></span></button>
              {adj && <div class="nact"><p class="small">欠員への対応として、あなたの勤務の一部が変わりました。内容を確認してください。</p><div class="row" style="flex-wrap:wrap"><button class="btn sm" onClick={() => { readNotice(n.id); go('shift'); }}>シフトを見る</button><button class="btn sm tonal" onClick={() => { readNotice(n.id); openLeaderChat(); }}>都合が悪い場合はリーダーに相談</button></div></div>}
            </div>); })}
        </Modal>
      )}
      {offer && (
        <Modal title="勤務の打診" onClose={() => setOffer(null)}>
          <OfferCard s={s} vid={offer} toast={toast} after={() => setOffer(null)} />
          <p class="small" style="margin-top:12px">この打診はあなたの承諾ではなく、回答後にシフトへ反映されます。</p>
        </Modal>
      )}
      {staff && <StaffModal id={staff} onClose={() => setStaff(null)} />}
      {unitList && (
        <Modal title={`${unitName(unitList)}の入居者`} onClose={() => setUnitList(null)}>
          {residentsOf(unitList).map((r) => <button key={r.id} class="line" style="width:100%" onClick={() => setRes(r.id)}><span style="flex:1;text-align:left"><b>{r.name}</b>　<span class="muted">{r.room}号室・要介護{r.careLevel}</span></span>{r.medical.length > 0 && <span class="chip bad">医療的ケア</span>}<Icon n="chevron_right" /></button>)}
        </Modal>
      )}
      {unitStaff && (
        <Modal title={`${unitName(unitStaff)}の今日のメンバー`} onClose={() => setUnitStaff(null)}>
          {buildDay(s.assignments, s.today).filter((r) => !r.tail && r.assignment.status !== 'absent' && r.assignment.unitId === unitStaff).map((r) => <button key={r.assignment.id} class="line" style="width:100%" onClick={() => setStaff(r.staff.id)}><span style="flex:1;text-align:left"><b>{r.staff.name}</b>{r.staff.id === MY_ID ? '（自分）' : ''}<br /><span class="small">{r.assignment.shift} {SHIFTS[r.assignment.shift].label}</span></span><Icon n="chevron_right" /></button>)}
        </Modal>
      )}
      {res && <ResidentModal id={res} onClose={() => setRes(null)} />}
      {toastNode}
    </div>
  );
}
