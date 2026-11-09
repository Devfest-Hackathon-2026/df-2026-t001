import { useEffect, useRef, useState } from 'preact/hooks';
import { LEADER_ID, SHIFT_ORDER, UNITS, staffById } from '../core/facility';
import { askLeaderAI, cancelLeaderAction, runLeaderAction, sendMessage } from '../core/store';
import { LEADER_SUGGESTIONS } from '../core/leaderai';
import './plan.css';
import type { State } from '../core/store';
import type { ChatMessage } from '../core/types';
import { Icon, Modal, useToast } from '../shared/ui';
import { Back, hm, useWide } from './util';

interface Th { id: string; name: string; desc: string; section: string }
export const THREADS: Th[] = [
  { id: 'leader', name: '職員からの相談・個別', desc: '宛先：職員個人（個別）', section: '職員から' },
  { id: 'all', name: '施設全体のお知らせ', desc: '宛先：全職員（職員は返信できません）', section: '施設全体' },
  ...SHIFT_ORDER.map((x) => ({ id: `shift:${x}`, name: `${x}グループ`, desc: `宛先：${x}の勤務グループ全員`, section: '勤務グループ' })),
  ...UNITS.map((u) => ({ id: `unit:${u.id}`, name: `${u.floor}階 ${u.name}`, desc: `宛先：${u.name}の担当職員`, section: 'ユニット' })),
];
export const AI_THREAD: Th = { id: 'ai:leader', name: 'シフト作成君（AI）', desc: '聞く・頼む・シフトを作る、が普通の言葉でできます', section: 'シフト作成君' };
const SEEN = 'kana-leader-seen';
const loadSeen = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(SEEN) ?? '{}'); } catch { return {}; } };
const fromOthers = (s: State, id: string) => s.messages.filter((m) => m.thread === id && m.from !== LEADER_ID && m.from !== 'leader');
export function unreadCount(s: State) { const seen = loadSeen(); return THREADS.filter((t) => fromOthers(s, t.id).length > (seen[t.id] ?? 0)).length; }

const compress = (file: File) => new Promise<string>((res, rej) => {
  const fr = new FileReader(); fr.onerror = () => rej(); fr.onload = () => { const img = new Image(); img.onerror = () => rej(); img.onload = () => { const k = Math.min(1, 1024 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.7)); }; img.src = String(fr.result); }; fr.readAsDataURL(file);
});

export function Chat({ s, thread, setThread, onOpen }: { s: State; thread?: string; setThread: (t: string | undefined) => void; onOpen?: (target: string) => void }) {
  const wide = useWide(900);
  const cur = thread === AI_THREAD.id ? AI_THREAD : THREADS.find((t) => t.id === thread) ?? (wide ? AI_THREAD : undefined);
  const [seen, setSeen] = useState(loadSeen);
  useEffect(() => { if (!cur) return; const n = fromOthers(s, cur.id).length; if ((seen[cur.id] ?? 0) !== n) { const ns = { ...seen, [cur.id]: n }; setSeen(ns); try { localStorage.setItem(SEEN, JSON.stringify(ns)); } catch { /* ignore */ } } }, [cur?.id, s.messages.length]);
  const list = (
    <div class="clist scroll">
      <div><div class="sec-title" style="margin:12px 16px 4px">シフト作成君</div>
        {(() => { const ms = s.messages.filter((m) => m.thread === AI_THREAD.id); const last = ms[ms.length - 1];
          return <button class={`crow${cur?.id === AI_THREAD.id ? ' sel' : ''}`} onClick={() => setThread(AI_THREAD.id)}><span class="av" style="background:var(--pri-bg);color:var(--pri-tx)"><Icon n="smart_toy" /></span>
            <span class="cr-m"><span class="row spread"><b>{AI_THREAD.name}</b><span class="small">{last ? hm(last.at) : ''}</span></span><span class="row spread"><span class="small ell">{last ? `${last.from === 'ai' ? 'AI' : '自分'}：${last.text.split('\n')[0]}` : '状況を聞く・操作を頼む・シフトを作る'}</span></span></span></button>; })()}</div>
      {['職員から', '施設全体', '勤務グループ', 'ユニット'].map((sec) => <div key={sec}><div class="sec-title" style="margin:12px 16px 4px">{sec}</div>
        {THREADS.filter((t) => t.section === sec).map((t) => { const ms = s.messages.filter((m) => m.thread === t.id); const last = ms[ms.length - 1]; const un = fromOthers(s, t.id).length > (seen[t.id] ?? 0);
          return <button key={t.id} class={`crow${cur?.id === t.id ? ' sel' : ''}`} onClick={() => setThread(t.id)}>
            <span class="av"><Icon n={t.section === '施設全体' ? 'campaign' : t.section === '職員から' ? 'person' : 'groups'} /></span>
            <span class="cr-m"><span class="row spread"><b>{t.name}</b><span class="small">{last ? hm(last.at) : ''}</span></span>
              <span class="row spread"><span class="small ell">{last ? `${last.from === LEADER_ID ? '自分' : (staffById(last.from)?.name.split(' ')[0] ?? last.from)}：${last.text || '写真'}` : 'メッセージはまだありません'}</span>{un && <span class="dot" aria-label="未読" />}</span></span></button>; })}</div>)}
    </div>
  );
  const conv = (back?: () => void) => (cur?.id === AI_THREAD.id ? <AiConv s={s} onBack={back} onOpen={onOpen} /> : cur ? <Conv s={s} t={cur} onBack={back} /> : null);
  if (!wide) return cur ? conv(() => setThread(undefined)) : <div class="page scroll" style="padding:0">{list}</div>;
  return <div class="chat">{<div class="clist-w">{list}</div>}{conv()}</div>;
}

function Conv({ s, t, onBack }: { s: State; t: Th; onBack?: () => void }) {
  const [text, setText] = useState('');
  const [pics, setPics] = useState<{ name: string; type: string; url: string }[]>([]);
  const [big, setBig] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const end = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const msgs = s.messages.filter((m) => m.thread === t.id);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, t.id]);
  const send = () => { sendMessage(t.id, LEADER_ID, text, pics.length ? pics : undefined); setText(''); setPics([]); };
  const pick = async (e: Event) => { const fs = Array.from((e.target as HTMLInputElement).files ?? []).slice(0, 3 - pics.length); const out: typeof pics = []; for (const f of fs) { try { out.push({ name: f.name, type: 'image/jpeg', url: await compress(f) }); } catch { setToast('画像を読み込めませんでした'); } } setPics((p) => [...p, ...out]); (e.target as HTMLInputElement).value = ''; };
  const mine = (m: ChatMessage) => m.from === LEADER_ID || m.from === 'leader';
  return (
    <div class="cmain">
      <div class="chead">{onBack && <Back onClick={onBack} label="" />}<div><b style="font-weight:500">{t.name}</b><div class="small">{t.desc}</div></div></div>
      <div class="cbody scroll">
        {msgs.length === 0 && <div class="empty">まだメッセージはありません。</div>}
        {msgs.map((m) => <div key={m.id} class={`bub${mine(m) ? ' me' : ''}`}><div class="small">{mine(m) ? '小林（リーダー）' : (staffById(m.from)?.name ?? m.from)}　{hm(m.at)}</div>{m.text && <div>{m.text}</div>}
          {m.attachments?.map((a, i) => <button key={i} class="att" onClick={() => setBig(a.url)} aria-label="写真を拡大"><img src={a.url} alt={a.name} /></button>)}</div>)}
        <div ref={end} />
      </div>
      {pics.length > 0 && <div class="pics">{pics.map((p, i) => <span key={i} class="pic"><img src={p.url} alt="添付の写真" /><button class="x" aria-label="添付を外す" onClick={() => setPics(pics.filter((_, j) => j !== i))}><Icon n="close" sm /></button></span>)}</div>}
      <div class="cin"><input ref={file} type="file" accept="image/*" multiple hidden onChange={pick} />
        <button class="iconbtn" aria-label="写真を添付" disabled={pics.length >= 3} onClick={() => file.current?.click()}><Icon n="photo_camera" /></button>
        <input class="input" placeholder={`${t.name}へ送信`} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && (text.trim() || pics.length) && send()} aria-label="メッセージ" />
        <button class="btn pri" disabled={!text.trim() && !pics.length} onClick={send} aria-label="送信"><Icon n="send" sm /></button></div>
      {big && <Modal title="写真" onClose={() => setBig(null)}><img src={big} alt="添付の写真" style="width:100%;border-radius:12px" /></Modal>}
      {toast}
    </div>
  );
}

/** リーダーとシフト作成君の会話：聞く・頼む・シフトを作る。実行の前に必ず確認カードを出す */
function AiConv({ s, onBack, onOpen }: { s: State; onBack?: () => void; onOpen?: (target: string) => void }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const msgs = s.messages.filter((m) => m.thread === AI_THREAD.id);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);
  const send = (t: string) => { askLeaderAI(t); setText(''); };
  return (
    <div class="cmain">
      <div class="chead">{onBack && <Back onClick={onBack} label="" />}<div><b style="font-weight:500">{AI_THREAD.name}</b><div class="small">宛先：シフト作成君（Gemini は未接続・モック）</div></div></div>
      <div class="cbody scroll">
        {msgs.length === 0 && <div class="empty" style="text-align:center"><Icon n="smart_toy" /><p style="margin-top:8px">聞く・頼む・シフトを作る、が普通の言葉でできます。実行の前に必ず確認します。</p>
          <div class="aisug">{LEADER_SUGGESTIONS.map((q) => <button key={q} onClick={() => send(q)}>{q}</button>)}</div></div>}
        {msgs.map((m) => m.from === 'ai' ? (
          <div key={m.id} style="display:flex;flex-direction:column;align-items:flex-start"><div class="bub aibub"><div class="small">シフト作成君　{hm(m.at)}</div><div>{m.text}</div>
            {m.links && m.links.length > 0 && <div class="ailinks">{m.links.map((l) => <button key={l.target + l.label} class="btn sm" onClick={() => onOpen?.(l.target)}>{l.label}<Icon n="chevron_right" sm /></button>)}</div>}</div>
            {m.action && <div class="aiact"><div class="lbl">{m.action.label}</div><div class="det">{m.action.detail}</div>
              {m.action.state === 'proposed' ? <div class="row wrap" style="margin-top:8px"><button class="btn pri sm" onClick={() => runLeaderAction(m.id)}>実行する</button><button class="btn sm" onClick={() => cancelLeaderAction(m.id)}>やめる</button></div>
                : <div style="margin-top:8px"><span class={`chip ${m.action.state === 'done' ? 'ok' : ''}`}>{m.action.state === 'done' ? '実行しました' : 'やめました'}</span></div>}</div>}
          </div>) : <div key={m.id} class="bub me"><div class="small">小林（リーダー）　{hm(m.at)}</div><div>{m.text}</div></div>)}
        <div ref={end} />
      </div>
      <div class="cin">
        <input class="input" placeholder="シフト作成君に聞く・頼む（例：12月のシフトを作って）" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && text.trim() && send(text)} aria-label="シフト作成君へのメッセージ" />
        <button class="btn pri" disabled={!text.trim()} onClick={() => send(text)} aria-label="送信"><Icon n="send" sm /></button></div>
    </div>
  );
}
