import { useCallback, useEffect, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import './sv.css';
import { FACILITIES, MONTHS, errText, get } from './api';
import type { FacilityDetail, RosterRes } from './api';
import { RosterView } from './RosterView';
import { VacancyView } from './VacancyView';
import { AssistView } from './AssistView';
import { LearnView } from './LearnView';

export interface Ctx { fid: string; month: string; fac: FacilityDetail | null; roster: RosterRes | null; reload: () => Promise<void>; err: string }
type Tab = 'roster' | 'vac' | 'assist' | 'learn';
const TABS: { k: Tab; label: string; icon: string }[] = [
  { k: 'roster', label: 'シフト（CP-SAT）', icon: 'calendar_month' }, { k: 'vac', label: '欠員と応諾見込み', icon: 'person_search' },
  { k: 'assist', label: 'AIアシスタント', icon: 'auto_awesome' }, { k: 'learn', label: '学習の状況', icon: 'school' },
];

export function AiHub() {
  const [tab, setTab] = useState<Tab>('roster');
  const [fid, setFid] = useState<string>(FACILITIES[0].id);
  const [month, setMonth] = useState<string>(MONTHS[0]);
  const [fac, setFac] = useState<FacilityDetail | null>(null);
  const [roster, setRoster] = useState<RosterRes | null>(null);
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    setErr('');
    try {
      const [f, r] = await Promise.all([get<FacilityDetail>(`/api/v1/facilities/${fid}`), get<RosterRes>(`/api/v1/facilities/${fid}/rosters/${month}`)]);
      setFac(f); setRoster(r);
    } catch (e) { setErr(errText(e)); }
  }, [fid, month]);
  useEffect(() => { setFac(null); setRoster(null); void reload(); }, [reload]);

  const ctx: Ctx = { fid, month, fac, roster, reload, err };
  const info = FACILITIES.find((f) => f.id === fid)!;
  return (
    <div class="page scroll">
      <div class="sv-banner">デモ用の架空データです。ルールの数値はすべて「デモ用の仮値」で、法令・施設基準の数値ではありません。公開デモのため、操作内容は他の閲覧者にも見えます。</div>
      <div class="sv-head">
        <div class="seg" role="tablist" aria-label="施設">{FACILITIES.map((f) => <button key={f.id} role="tab" aria-selected={fid === f.id} onClick={() => setFid(f.id)}>{f.name}</button>)}</div>
        <div class="row" style="gap:8px"><span class="sv-note">{info.kind}・{info.note}</span>
          <div class="seg" aria-label="月">{MONTHS.map((m) => <button key={m} aria-pressed={month === m} onClick={() => setMonth(m)}>{Number(m.slice(5))}月</button>)}</div></div>
      </div>
      <div class="subtabs" style="margin-bottom:12px"><div class="seg" role="tablist">{TABS.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}><Icon n={t.icon} sm /> {t.label}</button>)}</div></div>
      {err && <div class="sv-err" role="alert">{err} <button class="btn sm" onClick={() => void reload()}>再読み込み</button></div>}
      {tab === 'roster' && <RosterView ctx={ctx} />}
      {tab === 'vac' && <VacancyView ctx={ctx} />}
      {tab === 'assist' && <AssistView ctx={ctx} />}
      {tab === 'learn' && <LearnView ctx={ctx} />}
    </div>
  );
}
