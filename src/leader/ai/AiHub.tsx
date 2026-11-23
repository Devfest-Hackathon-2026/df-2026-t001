// 「AIのしくみ」：シフト作成君の裏で動いている学習（Vertex AI Pipelines・BigQuery ML）と分析（BigQuery）を見せる説明用の画面。
// ナビには出さない。設定（候補の選び方）・ホームの欠員の見込み・デモメニューから開く（?open=ai / ?open=ai:insights でも開ける）。
// データは care-solver-api 側の学習用の架空施設（3施設）で、勤務表の画面のデータとは別。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import './sv.css';
import { FACILITIES, MONTHS, errText, get } from './api';
import type { FacilityDetail } from './api';
import { LearnView } from './LearnView';
import { InsightsView } from './InsightsView';
import { LearnedRules } from './LearnedRules';
import type { AiTab } from '../util';

export interface Ctx { fid: string; month: string; fac: FacilityDetail | null; reload: () => Promise<void>; err: string }
const TABS: { k: AiTab; label: string; icon: string }[] = [
  { k: 'learn', label: '学習の状況', icon: 'school' },
  { k: 'learned', label: 'ルール候補', icon: 'lightbulb' },
];
// 分析タブは API で有効なとき（INSIGHTS_ENABLED=1）だけ出す
const INSIGHTS_TAB = { k: 'insights' as AiTab, label: '欠員の分析', icon: 'insights' };

export function AiHub({ initialTab }: { initialTab?: AiTab }) {
  const [tab, setTab] = useState<AiTab>(initialTab ?? 'learn');
  const [fid, setFid] = useState<string>(FACILITIES[0].id);
  const [month, setMonth] = useState<string>(MONTHS[0]);
  const [fac, setFac] = useState<FacilityDetail | null>(null);
  const [err, setErr] = useState('');
  const [insightsOn, setInsightsOn] = useState(initialTab === 'insights');
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  useEffect(() => { get(`/api/v1/facilities/${FACILITIES[0].id}/insights/model_runs`).then(() => setInsightsOn(true)).catch(() => setInsightsOn(false)); }, []);

  const reload = useCallback(async () => {
    setErr('');
    try { setFac(await get<FacilityDetail>(`/api/v1/facilities/${fid}`)); } catch (e) { setErr(errText(e)); }
  }, [fid]);
  useEffect(() => { setFac(null); void reload(); }, [reload]);

  const ctx: Ctx = { fid, month, fac, reload, err };
  const info = FACILITIES.find((f) => f.id === fid)!;
  const tabs = insightsOn ? [TABS[0], INSIGHTS_TAB, TABS[1]] : TABS;
  return (
    <div class="page scroll">
      <h2 class="h2" style="margin-bottom:4px">AIのしくみ</h2>
      <p class="muted" style="margin-bottom:10px">欠員の打診の順番に使っている「応諾の見込み」を、どう学習しているかを見せる画面です。勤務表の画面とは別の、学習用の架空の施設のデータで動いています。</p>
      <div class="sv-banner">デモ用の架空データです。ルールの数値はすべて「デモ用の仮値」で、法令・施設基準の数値ではありません。公開デモのため、操作内容は他の閲覧者にも見えます。</div>
      <div class="subtabs" style="margin-bottom:12px"><div class="seg" role="tablist">{tabs.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}><Icon n={t.icon} sm /> {t.label}</button>)}</div></div>
      {tab !== 'learn' && <div class="sv-head">
        <div class="seg" role="tablist" aria-label="学習用の施設">{FACILITIES.map((f) => <button key={f.id} role="tab" aria-selected={fid === f.id} onClick={() => setFid(f.id)}>{f.name}</button>)}</div>
        <div class="row" style="gap:8px"><span class="sv-note">{info.kind}・{info.note}</span>
          {tab === 'learned' && <div class="seg" aria-label="月">{MONTHS.map((m) => <button key={m} aria-pressed={month === m} onClick={() => setMonth(m)}>{Number(m.slice(5))}月</button>)}</div>}</div>
      </div>}
      {err && <div class="sv-err" role="alert">{err} <button class="btn sm" onClick={() => void reload()}>再読み込み</button></div>}
      {tab === 'learn' && <LearnView ctx={ctx} />}
      {tab === 'insights' && insightsOn && <InsightsView ctx={ctx} />}
      {tab === 'learned' && <LearnedRules ctx={ctx} />}
    </div>
  );
}
