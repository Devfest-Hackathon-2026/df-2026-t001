import { useState } from 'preact/hooks';
import { DEMO_TODAY, FACILITY } from '../core/facility';
import { readAll, readNotice, useStore } from '../core/store';
import { Icon, Modal, ResidentModal, StaffModal } from '../shared/ui';
import type { Go, Nav, View } from './util';
import { useWidth } from './util';
import { Dashboard } from './Dashboard';
import { Month } from './Month';
import { Day } from './Day';
import { Vacancies } from './Vacancies';
import { Requests } from './Requests';
import { People } from './People';
import { Labor } from './Labor';
import { Collect } from './Collect';
import { Health } from './Health';
import { Chat, unreadCount } from './Chat';
import { PrintRoster } from './Print';
import { AutoSettings } from './Auto';
import { Plan } from './Plan';
import { DemoMenu } from './DemoMenu';
import { AiHub } from './ai/AiHub';

type G = 'dash' | 'shift' | 'todo' | 'people' | 'health' | 'chat' | 'settings';
const NAV: { g: G; to: View; icon: string; label: string }[] = [
  { g: 'dash', to: 'dash', icon: 'dashboard', label: 'ホーム' }, { g: 'shift', to: 'month', icon: 'calendar_month', label: 'シフト' }, { g: 'todo', to: 'vac', icon: 'task_alt', label: '要対応' },
  { g: 'people', to: 'people', icon: 'groups', label: '職員' }, { g: 'health', to: 'health', icon: 'monitor_heart', label: '体調' }, { g: 'chat', to: 'chat', icon: 'chat', label: 'チャット' },
];
const SETTINGS = { g: 'settings' as G, to: 'auto' as View, icon: 'settings', label: '設定' };
const groupOf = (v: View): G => (v === 'month' || v === 'day' || v === 'plan' ? 'shift' : v === 'auto' || v === 'ai' ? 'settings' : v === 'vac' || v === 'req' ? 'todo' : v === 'people' || v === 'labor' || v === 'collect' ? 'people' : v);

export function App() {
  const s = useStore();
  const w = useWidth(); const side = w >= 900; const compact = w < 640;
  const [nav, setNav] = useState<Nav>({ view: 'dash', date: DEMO_TODAY });
  const [staff, setStaff] = useState<string | null>(null);
  const [res, setRes] = useState<string | null>(null);
  const [bell, setBell] = useState(false);
  const [more, setMore] = useState(false);
  const [print, setPrint] = useState<string | null>(null);
  const go: Go = (view, o = {}) => { setNav((n) => ({ ...n, view, ...o })); setBell(false); setMore(false); };
  // 画面への移動（お知らせのリンク・チャットのリンク共通）
  const openTarget = (t: string) => {
    const i = t.indexOf(':'); const k = i < 0 ? t : t.slice(0, i); const arg = i < 0 ? '' : t.slice(i + 1);
    switch (k) {
      case 'vacancies': case 'vacancy': return go('vac', { vacId: arg || undefined });
      case 'autopilot': return go('vac', { vacId: arg || undefined });
      case 'requests': return go('req');
      case 'health': return go('health');
      case 'collection': return go('collect');
      case 'plan': return go('plan');
      case 'shift': return go('month');
      case 'chat': return go('chat');
      case 'day': return go('day', { date: arg || s.today });
      default: setBell(false);
    }
  };
  const mine = s.notices.filter((n) => n.to === 'leader').sort((a, b) => b.at.localeCompare(a.at));
  const unread = mine.filter((n) => !n.read).length;
  const pending = s.requests.filter((r) => r.status === 'pending').length;
  const open = s.vacancies.filter((v) => v.state !== 'filled').length;
  const chatUn = unreadCount(s);
  const active = groupOf(nav.view);
  const badge = (g: G) => (g === 'todo' ? pending + open : g === 'chat' ? chatUn : 0);
  const body = (() => {
    switch (nav.view) {
      case 'dash': return <Dashboard s={s} go={go} openStaff={setStaff} />;
      case 'month': return <Month s={s} date={nav.date} go={go} openStaff={setStaff} />;
      case 'day': return <Day s={s} date={nav.date} go={go} openStaff={setStaff} openResident={setRes} />;
      case 'plan': return <Plan s={s} onOpen={openTarget} go={go} openStaff={setStaff} openResident={setRes} />;
      case 'vac': return <Vacancies s={s} vacId={nav.vacId} go={go} openStaff={setStaff} />;
      case 'req': return <Requests s={s} openStaff={setStaff} />;
      case 'auto': return <AutoSettings s={s} />;
      case 'people': return <People s={s} openStaff={setStaff} openResident={setRes} />;
      case 'labor': return <Labor s={s} openStaff={setStaff} onPrint={setPrint} />;
      case 'collect': return <Collect s={s} openStaff={setStaff} />;
      case 'health': return <Health s={s} openStaff={setStaff} />;
      case 'ai': return <AiHub />;
      case 'chat': return <Chat s={s} thread={nav.thread} setThread={(t) => setNav((n) => ({ ...n, thread: t }))} {...({ onOpen: openTarget } as object)} />;
    }
  })();
  const sub = (() => {
    if (active === 'shift') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'month'} onClick={() => go('month')}>1ヶ月</button><button role="tab" aria-selected={nav.view === 'day'} onClick={() => go('day')}>1日</button><button role="tab" aria-selected={nav.view === 'plan'} onClick={() => go('plan')}>シフト作成</button></div>
      {nav.view !== 'plan' && <button class="btn sm" onClick={() => setPrint(nav.date.slice(0, 7))}><Icon n="print" sm />{compact ? <span class="sr">勤務表を印刷</span> : ' 勤務表を印刷'}</button>}</div>;
    if (active === 'todo') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'vac'} onClick={() => go('vac', { vacId: undefined })}>欠員 {open}</button><button role="tab" aria-selected={nav.view === 'req'} onClick={() => go('req')}>申請 {pending}</button></div></div>;
    if (active === 'settings') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'auto'} onClick={() => go('auto')}>自動対応</button><button role="tab" aria-selected={nav.view === 'ai'} onClick={() => go('ai')}>学習AI（CP-SAT・応諾予測）</button></div></div>;
    if (active === 'people') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'people'} onClick={() => go('people')}>職員・入居者</button><button role="tab" aria-selected={nav.view === 'labor'} onClick={() => go('labor')}>労務</button><button role="tab" aria-selected={nav.view === 'collect'} onClick={() => go('collect')}>希望休</button></div></div>;
    return null;
  })();
  const items = side ? NAV : NAV.filter((n) => ['dash', 'shift', 'todo', 'chat'].includes(n.g));
  return (
    <div class={`app${side ? '' : ' narrow'}`}>
      <header class="top"><div class="row" style="gap:10px;min-width:0"><b class="logo">助っ人ケア</b><span class="muted ell">{FACILITY.name}</span></div>
        <div class="row">{!compact && <span class="muted">小林（リーダー）</span>}<DemoMenu s={s} />
          <button class="iconbtn" onClick={() => setBell(!bell)} aria-label={`お知らせ ${unread}件の未読`} aria-expanded={bell}><Icon n="notifications" fill={unread > 0} />{unread > 0 && <span class="badge" style="position:absolute;top:4px;right:2px">{unread}</span>}</button></div></header>
      <nav class={side ? 'side-nav' : 'bottom-nav'} aria-label="メイン">
        {items.map((n) => { const on = active === n.g; const cnt = badge(n.g);
          return <button key={n.g} class={`nv${on ? ' on' : ''}`} onClick={() => go(on ? nav.view : n.to)} aria-current={on ? 'page' : undefined}><span class="pill"><Icon n={n.icon} fill={on} />{cnt > 0 && <span class="badge" style="position:absolute;top:-4px;right:-2px">{cnt}</span>}</span><span>{n.label}</span></button>; })}
        {side && <button class={`nv settings${active === 'settings' ? ' on' : ''}`} onClick={() => go(SETTINGS.to)} aria-current={active === 'settings' ? 'page' : undefined}><span class="pill"><Icon n={SETTINGS.icon} fill={active === 'settings'} /></span><span>{SETTINGS.label}</span></button>}
        {!side && <button class={`nv${active === 'people' || active === 'health' || active === 'settings' ? ' on' : ''}`} onClick={() => setMore(true)}><span class="pill"><Icon n="more_horiz" /></span><span>その他</span></button>}
      </nav>
      <main class="content">{sub}<div class="body">{body}</div></main>
      {bell && <div class="pop" role="dialog" aria-label="お知らせ"><div class="row spread" style="padding:12px 16px"><b style="font-weight:500">お知らせ</b><button class="btn sm" onClick={() => readAll('leader')}>すべて既読</button></div>
        <div class="scroll" style="max-height:60vh">{mine.map((n) => <button key={n.id} class={`nitem${n.read ? '' : ' un'}`} onClick={() => { readNotice(n.id); openTarget(n.link ?? ''); setBell(false); }}><div class="row spread"><b style="font-weight:500">{n.title}</b>{!n.read && <span class="dot" />}</div><div class="small">{n.body}</div><div class="small">{n.at}</div></button>)}
          {!mine.length && <div class="empty">お知らせはありません。</div>}</div></div>}
      {more && <Modal title="その他" onClose={() => setMore(false)}><div class="stack" style="gap:8px">
        <button class="listbtn" onClick={() => go('people')}><span><Icon n="groups" /> 職員・入居者</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('labor')}><span><Icon n="rule" /> 労務チェック・集計</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('collect')}><span><Icon n="event_available" /> 希望休の収集</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('health')}><span><Icon n="monitor_heart" /> 体調チェック</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('auto')}><span><Icon n="settings" /> 設定（自動対応）</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('ai')}><span><Icon n="auto_awesome" /> 学習AI（CP-SAT・応諾予測）</span><Icon n="chevron_right" /></button></div></Modal>}
      {staff && <StaffModal id={staff} onClose={() => setStaff(null)} />}
      {res && <ResidentModal id={res} onClose={() => setRes(null)} />}
      {print && <PrintRoster s={s} ym={print} onClose={() => setPrint(null)} />}
    </div>
  );
}
