import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import type { Ctx } from './AiHub';
import { WD, errText, get, post } from './api';
import type { Cand, ModelInfo, OfferRes, VacancyRes } from './api';

const START: Record<string, [number, number]> = { 早番: [7, 0], 日勤: [9, 0], 遅番: [12, 0], 夜勤: [16, 30] };
const LEADS = [{ h: 2, label: '直前（2時間前）' }, { h: 24, label: '前日（24時間前）' }, { h: 72, label: '3日前（72時間前）' }];
// 欠員を知った時刻（UTC）。勤務の開始（JST）から、指定の時間だけ前にする
const discovered = (date: string, shift: string, hoursBefore: number) => {
  const [y, m, d] = date.split('-').map(Number); const [h, mi] = START[shift];
  return new Date(Date.UTC(y, m - 1, d, h - 9, mi) - hoursBefore * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
};

export function VacancyView({ ctx }: { ctx: Ctx }) {
  const { fid, month, fac, roster, reload } = ctx;
  const [day, setDay] = useState(12);
  const [shift, setShift] = useState('日勤');
  const [absent, setAbsent] = useState('');
  const [lead, setLead] = useState(LEADS[0].h);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<VacancyRes | null>(null);
  const [offers, setOffers] = useState<Record<string, OfferRes>>({});
  const [filled, setFilled] = useState<string | null>(null);
  const [replan, setReplan] = useState<{ changed_cells: number; changes: { name: string; day: number; from: string; to: string }[]; status: string } | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);

  useEffect(() => { setRes(null); setOffers({}); setFilled(null); setReplan(null); setErr(''); get<ModelInfo>(`/api/v1/facilities/${fid}/models/acceptance`).then(setModel).catch(() => setModel(null)); }, [fid, month]);

  const working = useMemo(() => (fac?.staff ?? []).filter((s) => roster?.current[s.staff_id]?.[day - 1] === shift), [fac, roster, day, shift]);
  useEffect(() => { if (!working.some((s) => s.staff_id === absent)) setAbsent(working[0]?.staff_id ?? ''); }, [working]);
  const date = `${month}-${String(day).padStart(2, '0')}`;
  const wdn = roster ? (roster.first_weekday + day - 1) % 7 : 0;

  const register = async () => {
    setBusy(true); setErr(''); setRes(null); setOffers({}); setFilled(null); setReplan(null);
    try { setRes(await post<VacancyRes>(`/api/v1/facilities/${fid}/vacancies`, { date, shift, absent_staff_id: absent, reason: '体調不良', discovered_at: discovered(date, shift, lead) })); await reload(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const offer = async (c: Cand) => {
    if (!res) return; setErr('');
    try { const o = await post<OfferRes>(`/api/v1/facilities/${fid}/vacancies/${res.vacancy.vacancy_id}/offers`, { staff_id: c.staff_id }); setOffers((m) => ({ ...m, [c.staff_id]: o })); } catch (e) { setErr(errText(e)); }
  };
  const respond = async (c: Cand, status: 'accepted' | 'declined') => {
    if (!res) return; const o = offers[c.staff_id]; if (!o) return; setErr('');
    try {
      await post(`/api/v1/facilities/${fid}/vacancies/${res.vacancy.vacancy_id}/offers/${o.offer_id}/respond`, { status });
      setOffers((m) => ({ ...m, [c.staff_id]: { ...o, status } }));
      if (status === 'accepted') { setFilled(c.name); await reload(); }
    } catch (e) { setErr(errText(e)); }
  };
  const planPreview = async (apply: boolean) => {
    if (!res) return; setErr('');
    try { const r = await post<{ changed_cells: number; changes: { name: string; day: number; from: string; to: string }[]; status: string }>(`/api/v1/facilities/${fid}/vacancies/${res.vacancy.vacancy_id}/replan`, { apply, time_limit: 10 }); setReplan(r); if (apply) { setFilled('組み直し'); await reload(); } }
    catch (e) { setErr(errText(e)); }
  };

  return (
    <div class="stack">
      <section class="card">
        <b style="font-weight:500">欠員を登録して、補充の候補を見る</b>
        <p class="sv-note">ルールを破らない人だけを候補にし、この施設の過去の打診から学習した「応諾の見込み」の高い順に並べます。同じ人でも、依頼までの余裕が短いほど見込みは下がります。</p>
        <div class="sv-two" style="margin-top:8px">
          <div class="field"><label>日付</label><div class="row"><input class="input" type="number" min={1} max={roster?.days ?? 30} value={day} onInput={(e) => setDay(Math.max(1, Math.min(roster?.days ?? 30, Number((e.target as HTMLInputElement).value) || 1)))} style="max-width:90px" /><span>日（{WD[wdn]}）</span></div></div>
          <div class="field"><label>勤務</label><div class="seg">{['早番', '日勤', '遅番', '夜勤'].map((s) => <button key={s} aria-pressed={shift === s} onClick={() => setShift(s)}>{s}</button>)}</div></div>
          <div class="field"><label>欠勤する人（その日その勤務に入っている人）</label>
            <select class="input" value={absent} onChange={(e) => setAbsent((e.target as HTMLSelectElement).value)}>{working.map((s) => <option key={s.staff_id} value={s.staff_id}>{s.name}（{s.role}）</option>)}{!working.length && <option value="">該当者なし</option>}</select></div>
          <div class="field"><label>欠員を知ったのは</label><div class="seg">{LEADS.map((l) => <button key={l.h} aria-pressed={lead === l.h} onClick={() => setLead(l.h)}>{l.label}</button>)}</div></div>
        </div>
        <div class="row" style="margin-top:10px;gap:12px;flex-wrap:wrap">
          <button class="btn pri" onClick={() => void register()} disabled={busy || !absent}>{busy ? <><span class="sv-spin" /> 登録中…</> : <><Icon n="person_search" sm /> 欠員を登録して候補を見る</>}</button>
          {model && <span class={`chip ${model.using_model ? 'ok' : 'warn'}`}>{model.using_model && model.champion ? `学習済みモデルを使用（${model.champion.kind === 'pooled_logistic' ? 'プール学習' : model.champion.kind === 'xgboost' ? 'XGBoost' : 'ロジスティック'}・AUC ${model.champion.auc?.toFixed(2)}）` : 'この施設は学習済みモデルなし（従来の順位付け）'}</span>}
        </div>
        {model && !model.using_model && model.note && <p class="sv-note" style="margin-top:6px">{model.note}</p>}
        {err && <div class="sv-err" role="alert">{err}</div>}
      </section>

      {res && <section class="card">
        <div class="row spread wrap"><b style="font-weight:500">{res.vacancy.vacancy_id}　{date}（{WD[wdn]}）{res.vacancy.shift}</b><span class={`chip ${filled ? 'ok' : 'warn'}`}>{filled ? `充足（${filled}）` : '補充を探しています'}</span></div>
        {filled && <div class="sv-ok">補充が決まり、勤務表に反映されました。「シフト」タブで確認できます。</div>}
        <div class="stack" style="margin-top:10px">
          {res.candidates.map((c, i) => { const o = offers[c.staff_id]; const p = c.accept_probability; return (
            <div key={c.staff_id} class="sv-cand">
              <div><div class="row"><b style="font-weight:500">{i + 1}. {c.name}</b>{p !== null && <span class="chip pri">応諾の見込み {Math.round(p * 100)}%</span>}</div>
                {p !== null && <div class="sv-prob" aria-hidden="true"><i style={`width:${Math.round(p * 100)}%`} /></div>}
                <ul>{c.reasons.map((r, j) => <li key={j}>{r}</li>)}</ul></div>
              <div class="stack" style="gap:6px;align-items:flex-end">
                {!o && !filled && <button class="btn sm" onClick={() => void offer(c)}>打診する</button>}
                {o && o.status === 'pending' && !filled && <><span class="chip warn">打診中</span><div class="row"><button class="btn sm pri" onClick={() => void respond(c, 'accepted')}>受諾</button><button class="btn sm" onClick={() => void respond(c, 'declined')}>辞退</button></div></>}
                {o && o.status === 'declined' && <span class="chip">辞退</span>}
                {o && o.status === 'accepted' && <span class="chip ok">受諾</span>}</div>
            </div>); })}
          {!res.candidates.length && <p class="muted">ルールを破らずに入れる人がいませんでした。下の「組み直し案」を試してください。</p>}
        </div>
        {!!res.excluded.length && <details style="margin-top:10px"><summary class="small">候補にしなかった人（{res.excluded.length}名・理由つき）</summary><ul class="small" style="margin:6px 0 0 16px">{res.excluded.map((x) => <li key={x.staff_id}>{x.name}: {x.reason}</li>)}</ul></details>}
        {!filled && <div style="margin-top:12px"><button class="btn sm" onClick={() => void planPreview(false)}><Icon n="alt_route" sm /> 最小変更の組み直し案を見る</button></div>}
        {replan && <div class="sv-ok" style="margin-top:8px">{replan.status === 'OPTIMAL' || replan.status === 'FEASIBLE' ? <>変更は{replan.changed_cells}セルだけです。{replan.changes.slice(0, 6).map((c) => `${c.name} ${c.day}日 ${c.from || '休'}→${c.to || '休'}`).join('、')}{replan.changes.length > 6 ? ' ほか' : ''}　<button class="btn sm" onClick={() => void planPreview(true)}>この案を適用</button></> : '組み直し案を作れませんでした'}</div>}
      </section>}
    </div>
  );
}
