import { useEffect, useState } from 'preact/hooks';
import type { Ctx } from './AiHub';
import { FACILITIES, errText, get } from './api';
import type { ModelInfo } from './api';

const jst = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const KIND: Record<string, string> = { logistic: 'ロジスティック回帰', xgboost: 'XGBoost', pooled_logistic: 'プール学習（他施設の打診も使用）', baseline: '基準（基本確率）' };

export function LearnView({ ctx }: { ctx: Ctx }) {
  const [infos, setInfos] = useState<Record<string, ModelInfo>>({});
  const [err, setErr] = useState('');
  useEffect(() => { Promise.all(FACILITIES.map((f) => get<ModelInfo>(`/api/v1/facilities/${f.id}/models/acceptance`).then((m) => [f.id, m] as const))).then((x) => setInfos(Object.fromEntries(x))).catch((e) => setErr(errText(e))); }, []);
  return (
    <div class="stack">
      <section class="card">
        <b style="font-weight:500">施設ごとに学習が進む仕組み</b>
        <ol class="small" style="margin:8px 0 0 18px;line-height:1.8">
          <li>欠員の打診の結果（応諾・辞退）と、打診の時点の状況（依頼までの余裕・連勤・今月の勤務時間など）を記録します。</li>
          <li>毎週、Vertex AI Pipelines が施設ごとに3種類のモデルを交差検証で比べ、基準に勝てたものだけを採用します。</li>
          <li>採用したモデルが、次の欠員の候補を「応諾の見込み」の高い順に並べます。基準に勝てない施設は、従来の順位付けのままです。</li>
          <li>リーダーの手修正のくり返しは、ルール候補として提案します（採用・却下はリーダーが決めます）。</li>
        </ol>
        <p class="sv-note" style="margin-top:8px">学習に使っているのは架空の履歴（合成データ）です。精度は「埋め込んだ傾向を再現できたか」を示すもので、実運用での精度ではありません。</p>
      </section>
      {err && <div class="sv-err">{err}</div>}
      <div class="sv-two">{FACILITIES.map((f) => { const m = infos[f.id]; const c = m?.champion; return (
        <section key={f.id} class="card">
          <div class="row spread"><b style="font-weight:500">{f.name}</b>{m && <span class={`chip ${m.using_model ? 'ok' : 'warn'}`}>{m.using_model ? '学習済みモデルを使用中' : '昇格できず（従来の順位付け）'}</span>}</div>
          {!m && <p class="muted">読み込み中…</p>}
          {c && <><div class="sv-kpis"><div class="sv-kpi"><b>{c.auc?.toFixed(2)}</b><span>AUC（0.5=当てずっぽう）</span></div><div class="sv-kpi"><b>{c.logloss_gain !== null ? `+${(c.logloss_gain * 100).toFixed(1)}%` : '-'}</b><span>基準より対数損失がよい</span></div><div class="sv-kpi"><b>{c.rows}件</b><span>学習した打診</span></div></div>
            <p class="small">採用: {KIND[c.kind] ?? c.kind}</p>
            <table class="sv-table"><thead><tr><th>比べた候補</th><th>AUC</th></tr></thead><tbody>{Object.entries(c.compared).map(([k, v]) => <tr key={k}><td>{KIND[k] ?? k}{k === c.kind ? ' ✓' : ''}</td><td>{v.auc.toFixed(3)}</td></tr>)}</tbody></table></>}
          {m && !c && <p class="small" style="margin-top:6px">{m.note}</p>}
          {m && m.history.length > 0 && <><p class="small" style="margin-top:10px">学習の履歴</p><table class="sv-table"><thead><tr><th>実行</th><th>件数</th><th>AUC</th><th>昇格</th></tr></thead>
            <tbody>{m.history.slice(-4).map((h) => <tr key={h.version}><td title={h.version}>{jst(h.trained_at)}</td><td>{h.rows}{h.live_rows ? `（実運用${h.live_rows}）` : ''}</td><td>{h.auc?.toFixed(2) ?? '-'}</td><td>{h.promoted ? '○' : '見送り'}</td></tr>)}</tbody></table></>}
          {m && m.history.some((h) => !h.promoted) && m.history[m.history.length - 1].gate_reasons?.length ? <p class="small" style="margin-top:6px">見送りの理由: {m.history[m.history.length - 1].gate_reasons?.join('、')}</p> : null}
        </section>); })}</div>
    </div>
  );
}
