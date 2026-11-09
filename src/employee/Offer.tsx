import type { State } from '../core/store';
import { respondOffer } from '../core/store';
import { MY_ID, SHIFTS, staffById, unitName } from '../core/facility';
import { fmtMD } from '../core/dates';
import type { ShiftRequest, Vacancy } from '../core/types';
import { Icon } from '../shared/ui';

const myAvailFor = (s: State, v: Vacancy) => (s.availability[MY_ID] ?? []).some((x) => x.date === v.date && (x.shifts.length === 0 || x.shifts.includes(v.shift)));
type OS = 'pending' | 'accepted' | 'declined' | 'expired' | 'taken' | 'none';
export function offerState(v: Vacancy): OS {
  const o = v.offers.find((x) => x.staffId === MY_ID);
  if (v.state === 'filled') return v.filledBy === MY_ID ? 'accepted' : o?.status === 'declined' ? 'declined' : 'taken';
  if (!o) return 'none';
  return o.status;
}
const until = (s: State, v: Vacancy) => {
  const w = v.auto?.waitUntil; if (!w) return '';
  return w.slice(0, 10) === s.now.slice(0, 10) ? `返信は ${w.slice(11, 16)} まで` : `返信は ${+w.slice(5, 7)}/${+w.slice(8, 10)} ${w.slice(11, 16)} まで`;
};

/** 代わりの出勤の打診カード（会話内・お知らせから共通） */
export function OfferCard({ s, vid, toast, after, compact }: { s: State; vid: string; toast: (m: string) => void; after?: () => void; compact?: boolean }) {
  const v = s.vacancies.find((x) => x.id === vid);
  if (!v) return <div class="offer"><p class="muted">この打診は見つかりません。</p></div>;
  const st = offerState(v);
  const answer = (ok: boolean) => { respondOffer(v.id, MY_ID, ok); toast(ok ? 'シフトに入れると回答しました' : '今回は見送りと回答しました'); after?.(); };
  return (
    <div class="offer">
      <div class="row spread"><span class="small">代わりの出勤の打診</span>{st === 'pending' && until(s, v) && <span class="chip warn">{until(s, v)}</span>}</div>
      <div class="big" style="margin-top:4px">{fmtMD(v.date)} {v.shift}</div>
      <p class="muted">{SHIFTS[v.shift].label}・{unitName(v.unitId)}{v.kind === 'gap' ? '・応援' : ''}</p>
      {st === 'pending' && (myAvailFor(s, v)) && <p class="small" style="margin-top:8px"><Icon n="event_available" sm /> 「入れる日」として登録してくださっていたため、先に連絡しました。</p>}
      {st === 'pending' && (
        <>
          {compact ? <div style="height:12px" /> : <p style="margin:8px 0 12px">人手が足りず代わりの方を探しています。断っても評価に影響しません。</p>}
          <div class="stack" style="gap:8px">
            <button class="btn pri block" onClick={() => answer(true)}>入れる</button>
            <button class="btn block" onClick={() => answer(false)}>今回は見送る</button>
          </div>
        </>
      )}
      {st === 'accepted' && <div class="row" style="margin-top:8px;flex-wrap:wrap"><span class="chip ok">入ることになりました</span><span class="small">シフトに追加されました</span></div>}
      {st === 'declined' && <div class="row" style="margin-top:8px"><span class="chip">見送りました</span><span class="small">評価には影響しません</span></div>}
      {st === 'expired' && <div class="row" style="margin-top:8px"><span class="chip">返信期限を過ぎました</span><span class="small">次の方へ依頼しました</span></div>}
      {st === 'taken' && <div class="row" style="margin-top:8px"><span class="chip">すでに決まりました</span><span class="small">ご協力ありがとうございます</span></div>}
      {st === 'none' && <span class="chip" style="margin-top:8px">この打診は終了しています</span>}
    </div>
  );
}

/** 休み・遅刻・早退を出した本人向け：代わりの確認の進み具合 */
export const findVacancy = (s: State, r: ShiftRequest) => {
  const name = staffById(r.staffId).name;
  return s.vacancies.find((v) => v.date === r.date && v.reason.includes(name));
};
const Dot = ({ label, state }: { label: string; state: 'done' | 'now' | 'todo' }) => <span class={`trk ${state}`}><i />{label}</span>;
export function CoverTracker({ s, req }: { s: State; req: ShiftRequest }) {
  if (req.status !== 'approved' && req.status !== 'auto') return null;
  if (req.kind === 'シフト変更') return null;
  const v = findVacancy(s, req);
  if (!v) return null;
  const a = v.auto;
  let steps: [string, 'done' | 'now' | 'todo'][];
  if (v.state === 'filled') steps = [['リーダー確認', 'done'], ['代わりを探す', 'done'], [`決まりました（${v.filledBy ? staffById(v.filledBy).name : ''}さん）`, 'done']];
  else if (!a || a.mode === 'manual') steps = [['リーダーが代わりを手配します', 'now']];
  else if (a.mode === 'ask') steps = [['リーダーの確認待ち', 'now'], ['代わりを探す', 'todo'], ['決まる', 'todo']];
  else if (a.mode === 'running' || a.mode === 'paused') steps = [['リーダー確認', 'done'], [a.mode === 'paused' ? '一時停止中' : `代わりを探しています（${v.offers.length}人に連絡）`, 'now'], ['決まる', 'todo']];
  else if (a.mode === 'waiting_post') steps = [['リーダー確認', 'done'], ['社内では決まらず、求人を準備中', 'now'], ['決まる', 'todo']];
  else steps = [['リーダー確認', 'done'], ['求人で募集中', 'now'], ['決まる', 'todo']];
  return <div class="cover"><span class="small"><Icon n="group_add" sm /> 代わりの確認</span><div class="trks">{steps.map(([l, st]) => <Dot key={l} label={l} state={st} />)}</div></div>;
}
