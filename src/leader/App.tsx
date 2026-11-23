import { useEffect, useRef, useState } from 'preact/hooks';
import { DEMO_TODAY, FACILITY } from '../core/facility';
import { readAll, readNotice, useStore } from '../core/store';
import { Icon, Modal, ResidentModal, StaffModal } from '../shared/ui';
import type { Go, Nav, SetupSection, View } from './util';
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
  { g: 'people', to: 'people', icon: 'groups', label: '職員' }, { g: 'chat', to: 'chat', icon: 'chat', label: 'チャット' },
];
const SETTINGS = { g: 'settings' as G, to: 'auto' as View, icon: 'settings', label: '設定' };
const groupOf = (v: View): G => (v === 'month' || v === 'day' || v === 'plan' ? 'shift' : v === 'auto' || v === 'ai' ? 'settings' : v === 'vac' || v === 'req' ? 'todo' : v === 'people' || v === 'labor' || v === 'collect' ? 'people' : v === 'health' ? 'dash' : v);

export function App() {
  const s = useStore();
  const w = useWidth(); const side = w >= 900; const compact = w < 640;
  const [nav, setNav] = useState<Nav>({ view: 'dash', date: DEMO_TODAY });
  const navRef = useRef(nav);
  navRef.current = nav;
  const [staff, setStaff] = useState<string | null>(null);
  const [res, setRes] = useState<string | null>(null);
  const [bell, setBell] = useState(false);
  const [more, setMore] = useState(false);
  const [print, setPrint] = useState<string | null>(null);
  const navigate = (view: View, o: Partial<Nav> = {}, replace = false) => {
    const cur = navRef.current;
    const next: Nav = { ...cur, view, ...o };
    if (view !== 'auto') delete next.setupSection;
    const same =
      next.view === cur.view &&
      next.date === cur.date &&
      next.vacId === cur.vacId &&
      next.thread === cur.thread &&
      next.setupSection === cur.setupSection;
    navRef.current = next;
    setNav(next);
    setBell(false);
    setMore(false);
    if (typeof window !== 'undefined') {
      if (replace) {
        window.history.replaceState({ nav: next }, '', window.location.href);
      } else if (!same) {
        window.history.pushState({ nav: next }, '', window.location.href);
      }
    }
  };
  const go: Go = (view, o = {}) => navigate(view, o, false);
  // 画面への移動（お知らせのリンク・チャットのリンク・設定やシフト作成の行き来共通）
  const openTarget = (t: string, opts?: { replace?: boolean }) => {
    const i = t.indexOf(':'); const k = i < 0 ? t : t.slice(0, i); const arg = i < 0 ? '' : t.slice(i + 1);
    const rep = !!opts?.replace;
    switch (k) {
      case 'vacancies': case 'vacancy': return navigate('vac', { vacId: arg || undefined }, rep);
      case 'autopilot': return navigate('vac', { vacId: arg || undefined }, rep);
      case 'requests': return navigate('req', {}, rep);
      case 'health': return navigate('health', {}, rep);
      case 'collection': return navigate('collect', {}, rep);
      case 'plan': return navigate('plan', {}, rep);
      case 'shift': return navigate('month', {}, rep);
      case 'chat': return navigate('chat', {}, rep);
      case 'day': return navigate('day', { date: arg || s.today }, rep);
      case 'settings': {
        const sec: SetupSection | undefined =
          arg === 'facility' || arg === 'shifts' || arg === 'need' || arg === 'rules' ? arg : undefined;
        return navigate('auto', { setupSection: sec }, rep);
      }
      case 'people': return navigate('people', {}, rep);
      case 'labor': return navigate('labor', {}, rep);
      // AIのしくみ（説明用。ナビには出さない）。ai:insights のように中のタブも指定できる
      case 'ai': return navigate('ai', { aiTab: arg === 'insights' || arg === 'learned' ? arg : 'learn' }, rep);
      default: setBell(false);
    }
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const openParam = url.searchParams.get('open');
    if (url.searchParams.has('open')) {
      url.searchParams.delete('open');
      const cleanSearch = url.searchParams.toString().replace(/(^|&)demo=(?=&|$)/g, '$1demo');
      const cleanUrl = url.pathname + (cleanSearch ? `?${cleanSearch}` : '') + url.hash;
      window.history.replaceState({ nav: navRef.current }, '', cleanUrl);
    } else {
      window.history.replaceState({ nav: navRef.current }, '', window.location.href);
    }
    if (openParam) {
      openTarget(openParam, { replace: true });
    }
    const onPop = (e: PopStateEvent) => {
      const st = (e.state as { nav?: Nav } | null)?.nav;
      if (st?.view) {
        navRef.current = st;
        setNav(st);
        setBell(false);
        setMore(false);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
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
      case 'auto': return <AutoSettings s={s} onOpen={openTarget} initialOpen={nav.setupSection} />;
      case 'people': return <People s={s} />;
      case 'labor': return <Labor s={s} openStaff={setStaff} onPrint={setPrint} />;
      case 'collect': return <Collect s={s} openStaff={setStaff} />;
      case 'health': return <Health s={s} openStaff={setStaff} />;
      case 'ai': return <AiHub initialTab={nav.aiTab} />;
      case 'chat': return <Chat s={s} thread={nav.thread} setThread={(t) => setNav((n) => ({ ...n, thread: t }))} {...({ onOpen: openTarget } as object)} />;
    }
  })();
  const sub = (() => {
    if (active === 'shift') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'month'} onClick={() => go('month')}>1ヶ月</button><button role="tab" aria-selected={nav.view === 'day'} onClick={() => go('day')}>1日</button><button role="tab" aria-selected={nav.view === 'plan'} onClick={() => go('plan')}>シフト作成</button></div>
      {nav.view !== 'plan' && <button class="btn sm" onClick={() => setPrint(nav.date.slice(0, 7))}><Icon n="print" sm />{compact ? <span class="sr">勤務表を印刷</span> : ' 勤務表を印刷'}</button>}</div>;
    if (active === 'todo') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'vac'} onClick={() => go('vac', { vacId: undefined })}>欠員 {open}</button><button role="tab" aria-selected={nav.view === 'req'} onClick={() => go('req')}>申請 {pending}</button></div></div>;
    if (active === 'people') return <div class="subtabs"><div class="seg" role="tablist"><button role="tab" aria-selected={nav.view === 'people'} onClick={() => go('people')}>職員・入居者</button><button role="tab" aria-selected={nav.view === 'labor'} onClick={() => go('labor')}>労務</button><button role="tab" aria-selected={nav.view === 'collect'} onClick={() => go('collect')}>希望休</button></div></div>;
    return null;
  })();
  const items = side ? NAV : NAV.filter((n) => ['dash', 'shift', 'todo', 'chat'].includes(n.g));
  return (
    <div class={`app${side ? '' : ' narrow'}`}>
      <header class="top"><div class="row" style="gap:10px;min-width:0"><b class="logo">助っ人ケア</b><span class="muted ell">{FACILITY.name}</span></div>
        <div class="row">{!compact && <span class="muted">小林（リーダー）</span>}<DemoMenu s={s} onAi={() => openTarget('ai')} />
          <button class="iconbtn" onClick={() => setBell(!bell)} aria-label={`お知らせ ${unread}件の未読`} aria-expanded={bell}><Icon n="notifications" fill={unread > 0} />{unread > 0 && <span class="badge" style="position:absolute;top:4px;right:2px">{unread}</span>}</button></div></header>
      <nav class={side ? 'side-nav' : 'bottom-nav'} aria-label="メイン">
        {items.map((n) => { const on = active === n.g; const cnt = badge(n.g);
          return <button key={n.g} class={`nv${on ? ' on' : ''}`} onClick={() => go(on ? nav.view : n.to)} aria-current={on ? 'page' : undefined}><span class="pill"><Icon n={n.icon} fill={on} />{cnt > 0 && <span class="badge" style="position:absolute;top:-4px;right:-2px">{cnt}</span>}</span><span>{n.label}</span></button>; })}
        {side && <button class={`nv settings${active === 'settings' ? ' on' : ''}`} onClick={() => go(SETTINGS.to, { setupSection: undefined })} aria-current={active === 'settings' ? 'page' : undefined}><span class="pill"><Icon n={SETTINGS.icon} fill={active === 'settings'} /></span><span>{SETTINGS.label}</span></button>}
        {!side && <button class={`nv${active === 'people' || active === 'settings' ? ' on' : ''}`} onClick={() => setMore(true)}><span class="pill"><Icon n="more_horiz" /></span><span>その他</span></button>}
      </nav>
      <main class="content">{sub}<div class="body">{body}</div></main>
      {bell && <div class="pop" role="dialog" aria-label="お知らせ"><div class="row spread" style="padding:12px 16px"><b style="font-weight:500">お知らせ</b><button class="btn sm" onClick={() => readAll('leader')}>すべて既読</button></div>
        <div class="scroll" style="max-height:60vh">{mine.map((n) => <button key={n.id} class={`nitem${n.read ? '' : ' un'}`} onClick={() => { readNotice(n.id); openTarget(n.link ?? ''); setBell(false); }}><div class="row spread"><b style="font-weight:500">{n.title}</b>{!n.read && <span class="dot" />}</div><div class="small">{n.body}</div><div class="small">{n.at}</div></button>)}
          {!mine.length && <div class="empty">お知らせはありません。</div>}</div></div>}
      {more && <Modal title="その他" onClose={() => setMore(false)}><div class="stack" style="gap:8px">
        <button class="listbtn" onClick={() => go('people')}><span><Icon n="groups" /> 職員・入居者</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('labor')}><span><Icon n="rule" /> 労務チェック・集計</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('collect')}><span><Icon n="event_available" /> 希望休の収集</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => { location.href = './setup.html'; }}><span><Icon n="tune" /> はじめの条件</span><Icon n="chevron_right" /></button>
        <button class="listbtn" onClick={() => go('auto', { setupSection: undefined })}><span><Icon n="settings" /> 設定</span><Icon n="chevron_right" /></button></div></Modal>}
      {staff && <StaffModal id={staff} onClose={() => setStaff(null)} />}
      {res && <ResidentModal id={res} onClose={() => setRes(null)} />}
      {print && <PrintRoster s={s} ym={print} onClose={() => setPrint(null)} />}
    </div>
  );
}
