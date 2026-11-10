import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { RESIDENTS, STAFF, unitName } from '../core/facility';
import { residentDetail_, staffDetail_ } from '../core/detail';
import type { State } from '../core/store';
import { Modal, SkillChips } from '../shared/ui';

const Tabs = <T extends string>({ tabs, v, set }: { tabs: readonly T[]; v: T; set: (t: T) => void }) => (
  <div style="overflow-x:auto;margin-bottom:12px"><div class="seg" role="tablist">{tabs.map((t) => <button key={t} role="tab" aria-selected={v === t} onClick={() => set(t)}>{t}</button>)}</div></div>
);
const Sec = ({ t, children }: { t: string; children: ComponentChildren }) => <><div class="sec-title">{t}</div>{children}</>;
const Chips = ({ xs, cls = '' }: { xs: string[]; cls?: string }) => xs.length ? <div class="row" style="flex-wrap:wrap;gap:4px">{xs.map((x) => <span key={x} class={`chip ${cls}`}>{x}</span>)}</div> : <p class="muted">なし</p>;
const Note = ({ children }: { children: ComponentChildren }) => <p class="small" style="margin-top:16px">{children}</p>;
const fakeNote = 'すべて架空の合成データです。リーダー画面でのみ閲覧できます。';

// ------------------------------------------------------------------ 職員

const STAFF_TABS = ['希望', '勤務実績', '打診・欠勤', '経歴・研修', '人事'] as const;
export type StaffTab = typeof STAFF_TABS[number];

export function StaffDetailModal({ id, s, tab: t0 = '希望', onClose }: { id: string; s: State; tab?: StaffTab; onClose: () => void }) {
  const [tab, setTab] = useState<StaffTab>(t0);
  const x = STAFF.find((a) => a.id === id); const d = staffDetail_(id); const p = s.prefs[id];
  if (!x || !d) return null;
  const sum = d.offers.reduce((a, o) => ({ ...a, [o.answer]: a[o.answer] + 1 }), { 入った: 0, 断った: 0, 返信なし: 0 } as Record<string, number>);
  const tot = d.months.reduce((a, m) => ({ days: a.days + m.days, nights: a.nights + m.nights, ot: a.ot + m.overtimeH, hw: a.hw + m.holidayWork, pl: a.pl + m.paidLeave }), { days: 0, nights: 0, ot: 0, hw: 0, pl: 0 });
  return (
    <Modal wide title={`${x.name}さん`} onClose={onClose}>
      <p class="muted" style="margin-bottom:12px">{x.kana}　{x.role}／{x.employment}／{unitName(x.homeUnit)}／{x.age}歳・勤続{x.years}年　<span class="chip">{d.empNo}</span></p>
      <Tabs tabs={STAFF_TABS} v={tab} set={setTab} />
      {tab === '希望' && <>
        <Sec t="シフトの希望">
          <dl class="kv">
            <dt>希望の勤務帯</dt><dd>{d.wish.shifts}</dd>
            <dt>勤務可能</dt><dd>{x.shifts.join('・')}</dd>
            <dt>避けたい曜日</dt><dd>{d.wish.avoidWeekdays}</dd>
            <dt>休みの取り方</dt><dd>{d.wish.dayOff}</dd>
            <dt>夜勤の回数</dt><dd>{d.wish.nights}</dd>
            <dt>連勤の上限</dt><dd>{d.wish.maxConsecutive}</dd>
            <dt>希望ユニット</dt><dd>{d.wish.units}</dd>
            <dt>組み合わせ</dt><dd>{d.wish.partner}</dd>
            <dt>退勤の上限</dt><dd>{x.leaveBy ? `${x.leaveBy}（${x.leaveReason ?? '理由未記入'}）` : '制約なし'}</dd>
            <dt>休憩の希望</dt><dd>{p.breakPref ?? x.breakPref ?? '特になし'}</dd>
            <dt>通勤</dt><dd>{d.wish.commute}</dd>
          </dl>
        </Sec>
        <Sec t="配慮してほしいこと">{d.wish.considerations.length ? <ul style="margin-left:20px">{d.wish.considerations.map((c) => <li key={c}>{c}</li>)}</ul> : <p class="muted">特になし</p>}{d.wish.note && <p style="margin-top:8px">本人メモ：{d.wish.note}</p>}</Sec>
        <Sec t="提出済みの勤務帯希望（月の希望の提出から反映）"><Chips xs={p.shiftHope} cls="pri" /></Sec>
        <Sec t="希望の変更履歴">{p.history.length ? <ul class="issues">{p.history.map((h, i) => <li key={i}><span class="small">{h.at}</span><br />{h.text}</li>)}</ul> : <p class="muted">履歴はまだありません。</p>}</Sec>
        <Note>希望と必須の制約は区別します。勤務表づくりに自動で使うのは、提出された希望休と勤務帯希望です。その他の詳細は、調整のときに確認するための記録です。{fakeNote}</Note>
      </>}
      {tab === '勤務実績' && <>
        <Sec t="直近6か月（2026年5〜10月）">
          <div style="overflow-x:auto"><table class="tbl small-tbl"><thead><tr><th>月</th><th>出勤日数</th><th>夜勤</th><th>時間外</th><th>休日出勤</th><th>有給取得</th></tr></thead><tbody>
            {d.months.map((m) => <tr key={m.month}><td>{m.month}</td><td>{m.days}日</td><td>{m.nights}回</td><td>{m.overtimeH}時間</td><td>{m.holidayWork}日</td><td>{m.paidLeave}日</td></tr>)}
            <tr><td><b>合計</b></td><td><b>{tot.days}日</b></td><td><b>{tot.nights}回</b></td><td><b>{tot.ot}時間</b></td><td><b>{tot.hw}日</b></td><td><b>{tot.pl}日</b></td></tr>
          </tbody></table></div>
        </Sec>
        <Note>実績の記録です。評価や順位には使いません。{fakeNote}</Note>
      </>}
      {tab === '打診・欠勤' && <>
        <Sec t={`欠員の打診（2026年6月〜）：${d.offers.length}件`}>
          <div class="row" style="flex-wrap:wrap;gap:6px"><span class="chip ok">入った {sum['入った']}件</span><span class="chip">断った {sum['断った']}件</span><span class="chip">返信なし {sum['返信なし']}件</span></div>
          {d.offers.length ? <div style="overflow-x:auto;margin-top:8px"><table class="tbl small-tbl"><thead><tr><th>日付</th><th>勤務</th><th>ユニット</th><th>欠員の理由</th><th>返事</th><th>メモ</th></tr></thead><tbody>
            {d.offers.map((o, i) => <tr key={i}><td>{o.date}</td><td>{o.shift}</td><td>{unitName(o.unitId)}</td><td>{o.cause}</td><td>{o.answer}</td><td>{o.note}</td></tr>)}</tbody></table></div> : <p class="muted" style="margin-top:8px">打診の記録はありません。</p>}
        </Sec>
        <Sec t="当日の欠勤・遅刻・早退">
          {d.absences.length ? <div style="overflow-x:auto"><table class="tbl small-tbl"><thead><tr><th>日付</th><th>種別</th><th>理由</th></tr></thead><tbody>{d.absences.map((a, i) => <tr key={i}><td>{a.date}</td><td>{a.kind}</td><td>{a.reason}</td></tr>)}</tbody></table></div> : <p class="muted">記録はありません。</p>}
        </Sec>
        <Note>事実の記録のみを表示します。断った回数などから点数や順位は付けません。{fakeNote}</Note>
      </>}
      {tab === '経歴・研修' && <>
        <Sec t="資格とスキル"><dl class="kv"><dt>資格</dt><dd>{x.license}</dd></dl><div style="margin-top:8px"><SkillChips ids={x.skills} /></div></Sec>
        <Sec t="経歴・面談"><ul class="issues">{d.career.map((c, i) => <li key={i}><span class="small">{c.at}</span><br />{c.text}</li>)}</ul></Sec>
        <Sec t="研修の受講"><div style="overflow-x:auto"><table class="tbl small-tbl"><tbody>{d.training.map((t, i) => <tr key={i}><td style="white-space:nowrap">{t.date}</td><td>{t.title}</td></tr>)}</tbody></table></div></Sec>
        <Note>{fakeNote}</Note>
      </>}
      {tab === '人事' && <>
        <Sec t="契約・給与区分">
          <dl class="kv">
            <dt>入職日</dt><dd>{d.hr.hiredOn}</dd>
            <dt>雇用区分</dt><dd>{d.hr.contract}{d.hr.contractEnd ? `（契約期間：〜${d.hr.contractEnd}）` : ''}</dd>
            <dt>給与区分</dt><dd>{d.hr.pay}</dd>
            <dt>等級</dt><dd>{d.hr.grade}</dd>
            <dt>手当</dt><dd>{d.hr.allowances.length ? d.hr.allowances.join('・') : 'なし'}</dd>
            <dt>所定労働時間</dt><dd>週{d.hr.weeklyHours}時間</dd>
            <dt>年次有給休暇</dt><dd>付与{d.hr.paidLeave.total}日・取得{d.hr.paidLeave.used}日・残り{d.hr.paidLeave.total - d.hr.paidLeave.used}日</dd>
            <dt>社会保険</dt><dd>{d.hr.insurance}</dd>
          </dl>
        </Sec>
        <Sec t="資格・連絡先"><dl class="kv"><dt>資格登録</dt><dd>{d.hr.license}</dd><dt>資格の取得</dt><dd>{d.hr.licensedOn}</dd><dt>連絡先</dt><dd>{x.phone}（架空）</dd><dt>緊急連絡先</dt><dd>{d.hr.emergency}</dd></dl></Sec>
        <Note>金額は表示しません。{fakeNote}</Note>
      </>}
    </Modal>
  );
}

// ------------------------------------------------------------------ 入居者

const RES_TABS = ['基本・認定', '生活', '健康・服薬', '家族・連絡', '好み・経過'] as const;
export type ResTab = typeof RES_TABS[number];

export function ResidentDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [tab, setTab] = useState<ResTab>('基本・認定');
  const r = RESIDENTS.find((a) => a.id === id); const d = residentDetail_(id);
  if (!r || !d) return null;
  const adl = [['食事', r.adl.meal], ['排泄', r.adl.excretion], ['入浴', r.adl.bath], ['移乗', r.adl.transfer]] as const;
  const lv = (l: string) => (l === '全介助' ? 'bad' : l === '一部介助' ? 'warn' : l === '見守り' ? 'pri' : '');
  return (
    <Modal wide title={`${r.name}さん（${r.room}号室）`} onClose={onClose}>
      <p class="muted" style="margin-bottom:12px">{r.age}歳・{r.sex}／{unitName(r.unitId)}／要介護{r.careLevel}／入居{d.stay}　<span class="chip">{r.id}</span></p>
      <Tabs tabs={RES_TABS} v={tab} set={setTab} />
      {tab === '基本・認定' && <>
        <Sec t="基本"><dl class="kv"><dt>生年月日</dt><dd>{d.birth}</dd><dt>入居</dt><dd>{d.admittedOn}（{d.stay}）</dd><dt>居室</dt><dd>{r.room}号室（{unitName(r.unitId)}）</dd><dt>呼び方</dt><dd>{d.prefs.callName}</dd></dl></Sec>
        <Sec t="介護認定"><dl class="kv"><dt>要介護度</dt><dd>要介護{r.careLevel}</dd><dt>有効期間</dt><dd>{d.cert.period}</dd><dt>次の更新</dt><dd>{d.cert.nextReview}</dd><dt>保険者</dt><dd>{d.cert.insurer}</dd><dt>被保険者</dt><dd>{d.certNo}</dd><dt>自己負担</dt><dd>{d.cert.copay}</dd><dt>ケアマネ</dt><dd>{d.cert.careManager}</dd></dl></Sec>
        <Sec t="自立度"><dl class="kv"><dt>障害高齢者</dt><dd>{d.independence.disability}</dd><dt>認知症高齢者</dt><dd>{d.independence.dementia}</dd><dt>意思疎通</dt><dd>{d.senses.communication}</dd></dl></Sec>
        <Sec t="介助区分"><div class="row" style="flex-wrap:wrap">{adl.map(([k, v]) => <span key={k} class={`chip ${lv(v)}`}>{k}：{v}</span>)}</div></Sec>
      </>}
      {tab === '生活' && <>
        <Sec t="食事"><dl class="kv"><dt>食事形態</dt><dd>{d.meal.form}</dd><dt>水分</dt><dd>{d.meal.thickener}</dd><dt>摂取量</dt><dd>{d.meal.amount}</dd><dt>食器</dt><dd>{d.meal.tool}</dd><dt>アレルギー</dt><dd>{d.meal.allergies.length ? d.meal.allergies.map((a) => <span key={a} class="chip bad">{a}</span>) : 'なし'}</dd><dt>好きなもの</dt><dd>{d.meal.likes.join('・')}</dd><dt>苦手なもの</dt><dd>{d.meal.dislikes.length ? d.meal.dislikes.join('・') : '特になし'}</dd></dl></Sec>
        <Sec t="排泄・移動・入浴"><dl class="kv"><dt>排泄（日中）</dt><dd>{d.elimination.day}</dd><dt>排泄（夜間）</dt><dd>{d.elimination.night}</dd><dt>移動</dt><dd>{d.mobility.device}</dd><dt>見守り機器</dt><dd>{d.mobility.sensor}</dd><dt>入浴</dt><dd>{d.bath.method}・{d.bath.days}の{d.bath.time}</dd></dl></Sec>
        <Sec t="睡眠・夜間"><dl class="kv"><dt>就寝・起床</dt><dd>{d.sleep.bed}／{d.sleep.wake}</dd><dt>夜の様子</dt><dd>{d.sleep.night}</dd><dt>夜間の見回り</dt><dd>{r.nightCheck}</dd></dl></Sec>
        <Sec t="ケアのポイント"><ul style="margin-left:20px">{d.points.map((p) => <li key={p}>{p}</li>)}</ul>{r.notes.length > 0 && <div style="margin-top:8px"><Chips xs={r.notes} cls="warn" /></div>}</Sec>
      </>}
      {tab === '健康・服薬' && <>
        <Sec t="医療的ケア">{<Chips xs={r.medical} cls="bad" />}{r.medical.length > 0 && <p class="small" style="margin-top:6px">対応できる職員（要件確認済み）の配置が必要です。</p>}</Sec>
        <Sec t="服薬"><dl class="kv"><dt>服薬の時間</dt><dd>{d.medication.schedule}</dd><dt>薬の数</dt><dd>1日{d.medication.kinds}種類（薬の名前・病名は表示しません）</dd><dt>管理</dt><dd>{d.medication.method}</dd><dt>飲み方</dt><dd>{d.medication.form}</dd></dl></Sec>
        <Sec t="リスク"><dl class="kv"><dt>転倒</dt><dd>{d.risks.fall}</dd><dt>誤嚥</dt><dd>{d.risks.aspiration}</dd><dt>徘徊</dt><dd>{d.risks.wander}</dd><dt>褥瘡</dt><dd>{d.risks.skin}</dd></dl></Sec>
        <Sec t="感覚・口腔"><dl class="kv"><dt>視覚</dt><dd>{d.senses.vision}</dd><dt>聴覚</dt><dd>{d.senses.hearing}</dd><dt>歯</dt><dd>{d.senses.denture}</dd></dl></Sec>
        <Sec t="看取りの意向"><p>{d.endOfLife}</p></Sec>
      </>}
      {tab === '家族・連絡' && <>
        <Sec t="連絡先（優先順）">
          <div class="stack">{d.family.map((f) => <div key={f.name} class="card" style="padding:12px"><div class="row spread"><b>{f.name}</b><span class="row" style="gap:4px"><span class="chip">{f.relation}</span>{f.keyPerson && <span class="chip pri">キーパーソン</span>}</span></div><dl class="kv" style="margin-top:8px"><dt>電話</dt><dd>{f.phone}</dd><dt>連絡の目安</dt><dd>{f.contact}</dd><dt>面会</dt><dd>{f.visits}</dd></dl></div>)}</div>
        </Sec>
        <Note>連絡先はすべて架空です（実在しない番号）。</Note>
      </>}
      {tab === '好み・経過' && <>
        <Sec t="好み・暮らし"><dl class="kv"><dt>以前の仕事</dt><dd>{d.prefs.former}</dd><dt>趣味</dt><dd>{d.prefs.hobbies.join('・')}</dd><dt>日課</dt><dd>{d.prefs.routine.join('／')}</dd></dl></Sec>
        <Sec t="主な経過"><ul class="issues">{d.history.map((h, i) => <li key={i}><span class="small">{h.at}</span><br />{h.text}</li>)}</ul></Sec>
        <Note>日々の記録・申し送りは扱いません。</Note>
      </>}
      <Note>{fakeNote}</Note>
    </Modal>
  );
}
