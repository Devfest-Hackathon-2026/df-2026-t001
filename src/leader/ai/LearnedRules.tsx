// 手修正のくり返しから見つけたルール候補（care-solver-api の GET /facilities/{fid}/learned-rules）。
// 候補はサーバー側の学習用の架空施設（職員 SKR-… など）の手直し記録から作る。アプリの勤務表の職員とは別人なので、
// シフト作成の「守るルール」には出さず、「AIのしくみ」の画面だけで見せる。
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import type { Ctx } from './AiHub';
import { errText, get, post } from './api';
import type { Learned } from './api';

export function LearnedRules({ ctx }: { ctx: Ctx }) {
  const { fid, month, reload } = ctx;
  const [items, setItems] = useState<Learned[] | null>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<Record<string, string>>({});
  const load = () => get<{ candidates: Learned[] }>(`/api/v1/facilities/${fid}/learned-rules?month=${month}`).then((r) => setItems(r.candidates)).catch((e) => setErr(errText(e)));
  useEffect(() => { setItems(null); setDone({}); setErr(''); void load(); }, [fid, month]);
  const adopt = async (l: Learned, i: number) => {
    try { await post(`/api/v1/facilities/${fid}/rules`, l.choices[i].rule); setDone((d) => ({ ...d, [l.key]: `採用しました（${l.choices[i].label}）` })); await reload(); } catch (e) { setErr(errText(e)); }
  };
  const dismiss = async (l: Learned) => {
    try { await post(`/api/v1/facilities/${fid}/learned-rules/dismiss`, { key: l.key, reason: '作らない' }); setDone((d) => ({ ...d, [l.key]: '作らないことにしました（もう聞きません）' })); } catch (e) { setErr(errText(e)); }
  };
  return (
    <section class="card">
      <b style="font-weight:500"><Icon n="lightbulb" sm /> 手修正のくり返しから見つけたルール候補</b>
      <p class="sv-note">あなたが毎月同じ手直しをしている点を、偶然とは考えにくい回数で見つけたものです。ルールにするかは、あなたが決めます。一度答えた候補は、もう出ません。</p>
      <p class="sv-note">ここに出るのは、上で選んだ学習用の施設（架空）の手直しの記録から見つけた候補です。勤務表の職員とは別の人なので、採用しても「シフト」タブの作成には効きません。</p>
      {err && <div class="sv-err" role="alert">{err}</div>}
      {items === null && !err && <p class="muted"><span class="sv-spin" /> 読み込み中…</p>}
      {items && !items.length && <p class="muted">今は候補がありません。</p>}
      <div class="stack" style="margin-top:8px">{items?.map((l) => <div key={l.key} class="sv-cand"><div><b style="font-weight:500">{l.question}</b><p class="small">根拠: {l.evidence}{l.impact ? `／今の表で${l.impact.broken_now}件が該当` : ''}</p></div>
        {done[l.key] ? <span class="chip ok">{done[l.key]}</span> : <div class="stack" style="gap:6px;align-items:flex-end">{l.choices.map((c, i) => <button key={i} class="btn sm" onClick={() => void adopt(l, i)}>{c.label}</button>)}<button class="btn sm" onClick={() => void dismiss(l)}>作らない</button></div>}</div>)}</div>
    </section>
  );
}
