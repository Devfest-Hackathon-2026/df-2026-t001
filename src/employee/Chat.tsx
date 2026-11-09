import { useEffect, useRef, useState } from 'preact/hooks';
import type { State } from '../core/store';
import { askShiftMaker, cancelProposal, confirmProposal, sendMessage, undoProposal } from '../core/store';
import { MY_ID, SHIFTS, SHIFT_ORDER, STAFF, staffById, unitName } from '../core/facility';
import { Icon, Modal } from '../shared/ui';
import type { AiItem, ChatMessage, ShiftRequest } from '../core/types';
import { Ctx, senderName } from './common';
import { ACTIONS, ActionGrid, AiSheet } from './AiFlow';
import { MonthRequest } from './Request';
import { CoverTracker, OfferCard, findVacancy } from './Offer';

interface Th { id: string; title: string; sub: string; icon: string; kind: string; group: string; readonly?: boolean }
const AI = `ai:${MY_ID}`;
const SEEN = 'emp-chat-seen';
const loadSeen = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(SEEN) ?? '{}'); } catch { return {}; } };
type Att = NonNullable<ChatMessage['attachments']>;

function threadsOf(s: State): Th[] {
  const mine = s.assignments.find((a) => a.staffId === MY_ID && a.date === s.today && a.status !== 'absent');
  const unit = mine?.unitId ?? staffById(MY_ID).homeUnit;
  const cnt = (sh: string) => s.assignments.filter((a) => a.date === s.today && a.shift === sh && a.status !== 'absent').length;
  return [
    { id: AI, title: 'シフト作成君（AI）', sub: 'あなた専用。内容を確認してから反映します', icon: 'auto_awesome', kind: 'AI', group: 'pin' },
    { id: 'leader', title: 'リーダー（小林）', sub: '本人とリーダーだけの個別メッセージ', icon: 'person', kind: '個別', group: '個別' },
    ...SHIFT_ORDER.map((c) => ({ id: `shift:${c}`, title: `${c}グループ`, sub: `${c}の勤務メンバー ${cnt(c)}名${mine?.shift === c ? '（自分の勤務帯）' : ''}`, icon: 'groups', kind: '勤務グループ', group: '勤務グループ' })),
    { id: `unit:${unit}`, title: `${unitName(unit)}ユニット`, sub: `ユニットのスタッフ ${STAFF.filter((x) => x.homeUnit === unit).length}名`, icon: 'home_work', kind: 'ユニット', group: 'ユニット' },
    { id: 'all', title: '施設全体のお知らせ', sub: '全職員向け・閲覧のみ', icon: 'campaign', kind: '施設全体', group: '施設全体', readonly: true },
  ];
}
const hm = (at: string) => at.slice(11, 16);

async function compress(file: File): Promise<Att[number]> {
  const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
  return { name: file.name || '写真.jpg', type: 'image/jpeg', url: cv.toDataURL('image/jpeg', 0.7) };
}

const Step = ({ label, state }: { label: string; state: 'done' | 'now' | 'todo' | 'bad' }) => <span class={`trk ${state}`}><i />{label}</span>;
function Tracker({ it, req, undone, s }: { it: AiItem; req?: ShiftRequest; undone: boolean; s: State }) {
  if (undone) return <span class="chip">取り消しました</span>;
  if (it.type === 'avail') return <div class="trks"><Step label="確認" state="done" /><Step label="登録しました。欠員が出たら優先して連絡します" state="done" /></div>;
  if (it.type === 'dayoff') return <div class="trks"><Step label="確認" state="done" /><Step label="希望休に追加しました（締切まで変更できます）" state="done" /></div>;
  if (it.type === 'prefs') return <div class="trks"><Step label="確認" state="done" /><Step label="希望として保存済み" state="done" /></div>;
  if (!req) return null;
  if (req.status === 'rejected') return <div class="trks"><Step label="申請" state="done" /><Step label="見送り（リーダーに確認を）" state="bad" /></div>;
  if (req.status === 'pending') return <div class="trks"><Step label="申請" state="done" /><Step label="リーダー承認待ち" state="now" /><Step label="代わりを探す" state="todo" /></div>;
  return <><div class="trks"><Step label="申請" state="done" /><Step label={req.status === 'auto' ? '自動反映' : '承認'} state="done" /><Step label="反映済み" state="done" /></div><CoverTracker s={s} req={req} /></>;
}

function Proposal({ m, s }: { m: ChatMessage; s: State }) {
  const p = m.proposal!;
  const known = p.items.filter((i) => i.type !== 'unknown');
  const done = p.state === 'applied' || p.state === 'review';
  // リーダーの承認後・打診開始後は、本人からは取り消せない（リーダーに連絡）
  const availOnly = known.length > 0 && known.every((i) => i.type === 'avail' || i.type === 'dayoff');
  const canUndo = !availOnly && p.items.every((it) => { const r = it.requestId ? s.requests.find((x) => x.id === it.requestId) : undefined; if (!r) return true; if (r.status === 'pending') return true; if (r.status === 'rejected') return true; const v = findVacancy(s, r); return r.status === 'auto' && !v?.offers.length && !v?.auto; });
  return (
    <div class="prop">
      <div class="row" style="gap:6px"><Icon n="auto_awesome" sm /><b style="font-size:14px">読み取り結果</b></div>
      {p.items.map((it, i) => {
        const req = it.requestId ? s.requests.find((r) => r.id === it.requestId) : undefined;
        return (
          <div key={i} class="prop-i">
            <div><b>{it.normalized}</b></div>
            {it.type === 'request' && it.before && (
              <div class="ba"><div><span class="small">反映前</span><div>{it.before}</div></div><Icon n="arrow_forward" sm /><div><span class="small">反映後</span><div><b>{it.after}</b></div></div></div>
            )}
            <div class="small" style="margin:4px 0">{it.impact}</div>
            {p.state === 'draft' && it.type === 'request' && <span class={`chip ${it.needsApproval ? 'warn' : 'ok'}`}>{it.needsApproval ? 'リーダー承認待ち' : '自動反映'}</span>}
            {p.state === 'draft' && it.type === 'prefs' && <span class="chip pri">希望として保存</span>}
            {p.state === 'draft' && (it.type === 'avail' || it.type === 'dayoff') && <span class="chip ok">リーダーの承認は不要</span>}
            {(done || p.state === 'undone') && it.type !== 'unknown' && <Tracker it={it} req={req} undone={p.state === 'undone'} s={s} />}
          </div>
        );
      })}
      {p.state === 'draft' && known.length > 0 && <div class="row" style="margin-top:8px"><button class="btn pri sm" onClick={() => confirmProposal(m.id, MY_ID)}>この内容で反映</button><button class="btn sm" onClick={() => cancelProposal(m.id)}>やめる</button></div>}
      {done && <div class="row spread" style="margin-top:8px"><span class="small">{p.state === 'review' ? 'リーダーに送りました' : availOnly ? '希望として登録しました' : 'シフトに反映しました'}</span>{canUndo ? <button class="btn sm danger" onClick={() => undoProposal(m.id, MY_ID)}>取り消す</button> : availOnly ? <span class="small">変更はシフトタブの「{+s.collection.month.slice(5)}月の希望」から</span> : <span class="small">変更はリーダーに連絡してください</span>}</div>}
      {p.state === 'cancelled' && <span class="chip">やめました（変更なし）</span>}
    </div>
  );
}

export function Chat({ s, c }: { s: State; c: Ctx }) {
  const ths = threadsOf(s);
  const [cur, setCur] = useState<string | null>(() => { try { const t = localStorage.getItem('emp-open-thread'); if (t) { localStorage.removeItem('emp-open-thread'); return t; } } catch { /* ignore */ } return null; });
  useEffect(() => { const f = (e: Event) => { setCur((e as CustomEvent<string>).detail); try { localStorage.removeItem('emp-open-thread'); } catch { /* ignore */ } }; window.addEventListener('emp-open-thread', f); return () => window.removeEventListener('emp-open-thread', f); }, []);
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Att>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | (typeof ACTIONS)[number]['k']>(null);
  const [menu, setMenu] = useState(false);
  const [seen, setSeen] = useState(loadSeen);
  const end = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const msgs = cur ? s.messages.filter((m) => m.thread === cur) : [];
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); if (cur) { const n = msgs.length; if (seen[cur] !== n) { const nx = { ...seen, [cur]: n }; setSeen(nx); try { localStorage.setItem(SEEN, JSON.stringify(nx)); } catch { /* ignore */ } } } }, [cur, msgs.length]);
  const th = ths.find((t) => t.id === cur);
  const isAi = cur === AI;
  const send = () => { if ((!text.trim() && !atts.length) || !cur || th?.readonly) return; if (isAi) askShiftMaker(MY_ID, text); else sendMessage(cur, MY_ID, text, atts.length ? atts : undefined); setText(''); setAtts([]); };
  const onFiles = async (e: Event) => { const el = e.target as HTMLInputElement; const fs = Array.from(el.files ?? []).slice(0, 4); const out: Att = []; for (const f of fs) { try { out.push(await compress(f)); } catch { c.toast('画像を読み込めませんでした'); } } setAtts((a) => [...a, ...out].slice(0, 4)); el.value = ''; };

  if (!th) {
    const groups = ['pin', '個別', '勤務グループ', 'ユニット', '施設全体'];
    return (
      <div class="chat"><div class="pg scroll" style="flex:1">
        <h1 class="ptitle">チャット</h1>
        {groups.map((g) => (
          <section key={g}>
            {g !== 'pin' && <div class="sec-title" style="margin-top:4px">{g}</div>}
            <div class="card" style="padding:0 16px">
              {ths.filter((t) => t.group === g).map((t) => { const l = s.messages.filter((m) => m.thread === t.id); const last = l[l.length - 1]; const un = l.length > (seen[t.id] ?? 0) && last && last.from !== MY_ID; return (
                <button key={t.id} class="line throw" onClick={() => setCur(t.id)}>
                  <span class={`av${t.kind === 'AI' ? ' ai' : ''}`}><Icon n={t.icon} /></span>
                  <span style="flex:1;text-align:left;min-width:0"><b class="ell">{t.title}</b><span class="small ell">{last ? `${last.attachments?.length && !last.text ? '写真' : last.text}` : t.sub}</span></span>
                  <span class="col-end">{last && <span class="small">{hm(last.at)}</span>}{un && <span class="dot" aria-label="未読" />}</span>
                </button>); })}
            </div>
          </section>
        ))}
      </div></div>
    );
  }
  return (
    <div class="chat">
      <div class="chat-h">
        <button class="iconbtn" aria-label="宛先一覧へ" onClick={() => setCur(null)}><Icon n="arrow_back" /></button>
        <span class={`av sm${isAi ? ' ai' : ''}`}><Icon n={th.icon} sm /></span>
        <div style="flex:1;min-width:0"><b class="ell">{th.title}</b><span class="small ell">宛先：{th.sub}</span></div>
      </div>
      <div class="msgs scroll">
        {isAi && (
          <div class="card" style="padding:12px">
            <div class="row spread" style="margin-bottom:8px"><b>何を伝えますか？</b><span class="small">タップして選ぶだけ</span></div>
            <ActionGrid onPick={(k) => setSheet(k)} />
            <p class="small" style="margin-top:8px">下の入力欄から文章でも送れます。Gemini 連携は未接続（モック・ルールベースで解釈）です。</p>
            <details class="how"><summary>しくみ</summary>
              <p>欠員が出たらシフト作成君が代わりの方に順番に連絡します。リーダーの確認があり、求人の掲載は必ずリーダーが承認します。</p>
              <p>連絡が来ても、断って大丈夫です。評価には影響しません。</p>
            </details>
          </div>
        )}
        {th.readonly && <p class="small" style="text-align:center">全職員向けの連絡です。返信は「リーダー」へ送ってください。</p>}
        {msgs.length === 0 && !isAi && <div class="empty"><Icon n="chat" /><p>まだメッセージはありません。</p></div>}
        {msgs.map((m) => { const me = m.from === MY_ID; return (
          <div key={m.id} class={`bub-w${me ? ' me' : ''}`}>
            {!me && <div class="small" style="margin:0 8px 2px">{senderName(m.from)}</div>}
            {(m.text || m.attachments?.length) && (
              <div class={`bub${me ? ' me' : ''}`}>
                {m.attachments?.map((a, i) => <img key={i} class="att" src={a.url} alt={a.name} onClick={() => setZoom(a.url)} />)}
                {m.text}
              </div>
            )}
            {m.proposal && <Proposal m={m} s={s} />}
            {m.offer && <OfferCard s={s} vid={m.offer.vacancyId} toast={c.toast} compact />}
            <div class="small" style="margin:2px 8px">{hm(m.at)}</div>
          </div>); })}
        <div ref={end} />
      </div>
      {th.readonly ? <div class="composer"><p class="muted" style="padding:8px">施設全体のお知らせは閲覧のみです。</p></div> : (
        <>
          {atts.length > 0 && <div class="thumbs">{atts.map((a, i) => <span key={i} class="thumb"><img src={a.url} alt={a.name} /><button aria-label="写真を外す" onClick={() => setAtts(atts.filter((_, j) => j !== i))}><Icon n="close" sm /></button></span>)}</div>}
          <div class="composer">
            {isAi
              ? <button class="iconbtn tonalic" aria-label="かんたん入力" onClick={() => setMenu(true)}><Icon n="apps" /></button>
              : <><button class="iconbtn tonalic" aria-label="写真を添付" onClick={() => file.current?.click()}><Icon n="photo_camera" /></button><input ref={file} type="file" accept="image/*" capture="environment" multiple hidden onChange={onFiles} /></>}
            <textarea class="input" rows={1} placeholder={`${th.title}へ送信`} aria-label={`${th.title}へ送信`} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !(e as KeyboardEvent).isComposing) { e.preventDefault(); send(); } }} />
            <button class="btn pri" style="min-width:48px;padding:0 16px" disabled={!text.trim() && !atts.length} onClick={send} aria-label="送信"><Icon n="send" /></button>
          </div>
        </>
      )}
      {menu && <Modal title="何を伝えますか？" onClose={() => setMenu(false)}><ActionGrid onPick={(k) => { setMenu(false); setSheet(k); }} /></Modal>}
      {sheet === '来月の希望' && <MonthRequest s={s} c={c} onClose={() => setSheet(null)} />}
      {sheet && sheet !== '来月の希望' && <AiSheet s={s} kind={sheet} onClose={() => setSheet(null)} onSent={() => { setSheet(null); c.toast('シフト作成君に送りました'); }} />}
      {zoom && <Modal title="写真" onClose={() => setZoom(null)}><img src={zoom} alt="拡大写真" style="width:100%;border-radius:12px" /></Modal>}
      {void SHIFTS}
    </div>
  );
}
