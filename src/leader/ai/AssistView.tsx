import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import type { Ctx } from './AiHub';
import { errText, get, post } from './api';
import type { ChatRes, Learned, Proposal, RuleCand, TranslateRes } from './api';

// 返答の簡易整形: **太字** と、行頭の「* 」「- 」の箇条書き（HTML は使わず、文字列だけを扱う）
const fmt = (t: string) => t.split('\n').map((line, i) => <div key={i}>{line.replace(/^\s*[*-]\s+/, '・').split(/(\*\*[^*]+\*\*)/).map((p, j) => (p.startsWith('**') && p.endsWith('**') ? <b key={j} style="font-weight:500">{p.slice(2, -2)}</b> : p))}</div>);
interface Msg { role: 'user' | 'assistant'; content: string; proposals?: Proposal[] }
const SUGGEST = ['夜勤の回数が多い人は誰ですか？', '今の勤務表でルール違反はありますか？', '勤務区分ごとの応諾率を教えてください', '手修正のくり返しから見つかった、ルールにしたほうがよさそうなことはありますか？'];
const SCOPE: Record<string, string> = { day: 'この日だけ', person_weekday: 'この人のこの曜日', person_always: 'この人の毎日', everyone_weekday: '全員のこの曜日', person: 'この人', everyone: '全員' };

export function AssistView({ ctx }: { ctx: Ctx }) {
  return <div class="sv-two"><Chat ctx={ctx} /><div class="stack"><Translate ctx={ctx} /><LearnedRules ctx={ctx} /></div></div>;
}

function Chat({ ctx }: { ctx: Ctx }) {
  const { fid, month, reload } = ctx;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<Record<string, string>>({});
  useEffect(() => { setMsgs([]); setDone({}); setErr(''); }, [fid, month]);

  const send = async (t: string) => {
    const q = t.trim(); if (!q || busy) return;
    setText(''); setErr(''); setBusy(true);
    const history = msgs.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: q }]);
    try { const r = await post<ChatRes>(`/api/v1/facilities/${fid}/chat`, { text: q, month, history }); setMsgs((m) => [...m, { role: 'assistant', content: r.reply, proposals: r.proposals }]); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const run = async (key: string, p: Proposal) => {
    if (!confirm(`この提案を実行します。\n\n${p.summary}\n\nよろしいですか？`)) return;
    try { await post(p.action.path, p.action.body); setDone((d) => ({ ...d, [key]: '実行しました' })); await reload(); } catch (e) { setDone((d) => ({ ...d, [key]: `実行できませんでした: ${errText(e)}` })); }
  };
  return (
    <section class="card">
      <b style="font-weight:500"><Icon n="smart_toy" sm /> 施設のデータを調べて答えるチャット</b>
      <p class="sv-note">勤務表・ルール違反・日次・欠員・応諾率などを調べて答えます。変更は提案までで、実行するかはあなたが決めます。</p>
      <div class="sv-sugg">{SUGGEST.map((s) => <button key={s} class="chip pri" style="height:auto;padding:4px 10px;white-space:normal;text-align:left" onClick={() => void send(s)} disabled={busy}>{s}</button>)}</div>
      <div class="sv-chat" aria-live="polite">
        {msgs.map((m, i) => <div key={i} class={`sv-msg ${m.role === 'user' ? 'me' : 'ai'}`}>{fmt(m.content)}
          {m.proposals?.map((p, j) => { const k = `${i}-${j}`; return <div key={j} class="sv-prop"><b style="font-weight:500">提案: {p.summary}</b>
            {p.preview.new_rule_breaks && (p.preview.new_rule_breaks.length ? <p class="small" style="margin-top:4px">実行すると新たに破れるルール: {p.preview.new_rule_breaks.map((b) => `「${b.label}」（${b.strength}）`).join('、')}</p> : <p class="small" style="margin-top:4px">新たに破れるルールはありません。</p>)}
            {p.preview.is_candidate === false && <p class="small">候補ではありません{p.preview.excluded_reason ? `（${p.preview.excluded_reason}）` : ''}</p>}
            <div class="row" style="margin-top:6px">{done[k] ? <span class="chip ok">{done[k]}</span> : <button class="btn sm pri" onClick={() => void run(k, p)}>この提案を実行</button>}{p.preview.hard_break && !done[k] && <span class="chip bad">必須のルールを破ります</span>}</div></div>; })}</div>)}
        {busy && <div class="sv-msg ai"><span class="sv-spin" /> 調べています…</div>}
        {!msgs.length && !busy && <p class="muted">下の候補を押すか、質問を入力してください。</p>}
      </div>
      {err && <div class="sv-err" role="alert">{err}</div>}
      <form class="row" style="margin-top:8px" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input class="input" value={text} placeholder="例: 11月12日の夜勤は誰が入っていますか？" maxLength={500} onInput={(e) => setText((e.target as HTMLInputElement).value)} aria-label="質問" />
        <button class="btn pri" type="submit" disabled={busy || !text.trim()}>送る</button></form>
      <p class="sv-note" style="margin-top:6px">個人情報は、AI に渡す前に伏せ字にします。利用は1日に1人20回までです。</p>
    </section>
  );
}

function Translate({ ctx }: { ctx: Ctx }) {
  const { fid, month, fac, reload } = ctx;
  const [text, setText] = useState('');
  const [staff, setStaff] = useState('');
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<TranslateRes | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  useEffect(() => { setRes(null); setSaved([]); setErr(''); }, [fid, month]);
  const go = async () => {
    setBusy(true); setErr(''); setRes(null); setSaved([]);
    try { setRes(await post<TranslateRes>(`/api/v1/facilities/${fid}/rules/translate`, { text, month, ...(staff ? { staff_id: staff } : {}), ...(day ? { day: Number(day) } : {}) })); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const save = async (c: RuleCand) => {
    try { await post(`/api/v1/facilities/${fid}/rules`, c.rule); setSaved((s) => [...s, c.scope]); await reload(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <section class="card">
      <b style="font-weight:500"><Icon n="edit_note" sm /> 言葉からルールを作る</b>
      <p class="sv-note">言葉を、ルールの候補にします。範囲（この日だけ／この人のこの曜日／全員 など）は、あなたが選びます。AIは保存しません。</p>
      <div class="stack" style="gap:8px;margin-top:8px">
        <textarea class="input" rows={2} value={text} maxLength={300} placeholder="例: 木曜の夜勤は無理です" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} aria-label="ルールにしたい言葉" />
        <div class="row" style="flex-wrap:wrap"><select class="input" style="max-width:220px" value={staff} onChange={(e) => setStaff((e.target as HTMLSelectElement).value)} aria-label="対象の人"><option value="">対象の人（言葉の中で指定）</option>{(fac?.staff ?? []).map((s) => <option key={s.staff_id} value={s.staff_id}>{s.name}</option>)}</select>
          <input class="input" style="max-width:110px" type="number" min={1} max={31} placeholder="日（任意）" value={day} onInput={(e) => setDay((e.target as HTMLInputElement).value)} aria-label="日" />
          <button class="btn pri" onClick={() => void go()} disabled={busy || !text.trim()}>{busy ? <><span class="sv-spin" /> 翻訳中…</> : 'ルール候補にする'}</button></div>
      </div>
      {err && <div class="sv-err" role="alert">{err}</div>}
      {res && <div class="stack" style="margin-top:10px">{res.candidates.map((c) => <div key={c.scope} class="sv-cand"><div><span class="chip pri">{SCOPE[c.scope] ?? c.scope}</span> <b style="font-weight:500">{c.label}</b>
        <p class="small">強さ: {c.strength}{c.impact ? `／今の勤務表で${c.impact.broken_now}件が該当` : ''}</p></div>
        {saved.includes(c.scope) ? <span class="chip ok">保存しました</span> : <button class="btn sm" onClick={() => void save(c)}>この範囲で保存</button>}</div>)}
        {saved.length > 0 && <p class="sv-note">保存したルールは、次の「シフトを作る」から守られます。</p>}</div>}
    </section>
  );
}

function LearnedRules({ ctx }: { ctx: Ctx }) {
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
      {err && <div class="sv-err" role="alert">{err}</div>}
      {items === null && !err && <p class="muted"><span class="sv-spin" /> 読み込み中…</p>}
      {items && !items.length && <p class="muted">今は候補がありません。</p>}
      <div class="stack" style="margin-top:8px">{items?.map((l) => <div key={l.key} class="sv-cand"><div><b style="font-weight:500">{l.question}</b><p class="small">根拠: {l.evidence}{l.impact ? `／今の表で${l.impact.broken_now}件が該当` : ''}</p></div>
        {done[l.key] ? <span class="chip ok">{done[l.key]}</span> : <div class="stack" style="gap:6px;align-items:flex-end">{l.choices.map((c, i) => <button key={i} class="btn sm" onClick={() => void adopt(l, i)}>{c.label}</button>)}<button class="btn sm" onClick={() => void dismiss(l)}>作らない</button></div>}</div>)}</div>
    </section>
  );
}
