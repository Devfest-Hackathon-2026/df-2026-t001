// 職員・入居者の詳細情報（すべて架空の合成データ。実在の人物・番号・連絡先とは無関係）。
// 乱数シードは固定なので、読み込むたびに同じ内容になる。リーダー画面の「職員・入居者」だけが参照する。
import type { ShiftCode, SkillId } from './types';
import { RESIDENTS, STAFF, UNITS } from './facility';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function mk(seed: number) {
  const r = mulberry32(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const chance = (p: number) => r() < p;
  const some = <T,>(xs: readonly T[], n: number): T[] => { const a = xs.slice(); const out: T[] = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(r() * a.length), 1)[0]); return out; };
  return { int, pick, chance, some };
}

// ------------------------------------------------------------------ 職員

export interface StaffDetail {
  empNo: string;
  wish: {
    shifts: string; avoidWeekdays: string; nights: string; maxConsecutive: string; units: string; partner: string;
    commute: string; considerations: string[]; note: string; dayOff: string;
  };
  months: { month: string; days: number; nights: number; overtimeH: number; holidayWork: number; paidLeave: number }[];
  offers: { date: string; shift: ShiftCode; unitId: string; cause: string; answer: '入った' | '断った' | '返信なし'; note: string }[];
  absences: { date: string; kind: '当日欠勤' | '遅刻' | '早退'; reason: string }[];
  training: { date: string; title: string }[];
  career: { at: string; text: string }[];
  hr: {
    hiredOn: string; contract: string; contractEnd?: string; pay: string; grade: string; allowances: string[];
    weeklyHours: number; paidLeave: { total: number; used: number }; insurance: string; license: string; licensedOn: string; emergency: string;
  };
}

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
const TRAIN: Partial<Record<SkillId, string>> = {
  medical: '喀痰吸引等研修（第3号）', dementia: '認知症介護実践者研修', terminal: '看取りケア研修', preceptor: 'プリセプター研修',
  ict: '記録システム（ICT）活用研修', swallow: '摂食・嚥下と食事介助研修', bath: '入浴介助・機械浴の安全操作講習', driver: '送迎・安全運転講習', follow: 'リーダー補助・フォロー研修',
};
const COMMUTE = ['自家用車', '電車', 'バス', '自転車', '徒歩'];
const DECLINE = ['他の予定があった', '連勤中だった', '夜勤明けで休養', '家族の都合', '体調を整えたかった', '遠方にいた'];
const CAUSE = ['当日の欠勤', '急な体調不良による欠員', '予定外の休み', '研修による欠員'];
const GOALS = {
  新人: ['夜勤の独り立ち', '入浴介助を一人で担当できるようになる', '認知症ケアの基礎を身につける'],
  介護職員: ['介護福祉士の受験に向けた学習', '認知症ケアの研修を受ける', '夜勤を月5回に慣らす'],
  介護福祉士: ['後輩の指導に挑戦する', '看取りケアの経験を積む', 'ユニット運営の補助を担う'],
  主任: ['シフトの平準化（夜勤の偏りを減らす）', '新人育成の仕組みづくり', '家族対応の窓口を整える'],
} as const;

function staffDetail(i: number): StaffDetail {
  const s = STAFF[i];
  const g = mk(1000 + i * 31);
  const num = Number(s.id.slice(4));
  const night = s.shifts.includes('夜勤');
  const part = s.employment === 'パート';
  const mother = /迎え|送迎/.test(s.leaveReason ?? '');
  // 希望
  const wishShifts = s.shifts.length > 1 ? g.some(s.shifts.filter((x) => x !== '夜勤'), Math.min(2, s.shifts.length)).join('・') : s.shifts.join('・');
  const avoid = part || mother ? g.some(WEEKDAYS.slice(0, 5), g.int(0, 1) + (mother ? 1 : 0)) : g.some(WEEKDAYS, g.int(0, 1));
  const preceptorOf = STAFF.find((x) => x.homeUnit === s.homeUnit && x.skills.includes('preceptor') && x.id !== s.id);
  const mate = STAFF.filter((x) => x.homeUnit === s.homeUnit && x.id !== s.id && x.shifts.length > 0 && x.role !== '新人');
  const cons: string[] = [];
  if (s.leaveReason) cons.push(`${s.leaveBy}までに退勤（${s.leaveReason}）`);
  if (night) cons.push(g.pick(['夜勤明けの翌日は休みにしたい', '夜勤は連続2回までにしたい', '夜勤の前日は日勤を避けたい']));
  if (g.chance(0.3)) cons.push(g.pick(['月1回の通院（第2水曜の午前）', '資格試験の前週は休み希望', '腰への負担があり、入浴介助は2名体制を希望', '年に数回、家族行事の連休を希望']));
  const months = [5, 6, 7, 8, 9, 10].map((m) => {
    const days = part ? g.int(11, 16) : g.int(19, 22);
    return { month: ymd(2026, m, 1).slice(0, 7), days, nights: night ? g.int(3, 6) : 0, overtimeH: part ? g.int(0, 4) : g.int(0, 14), holidayWork: g.int(0, 2), paidLeave: g.int(0, part ? 1 : 2) };
  });
  const offers: StaffDetail['offers'] = [];
  const oc = s.role === '新人' ? g.int(0, 2) : g.int(1, 6);
  for (let k = 0; k < oc; k++) {
    const m = g.int(6, 11); const d = m === 11 ? g.int(1, 16) : g.int(1, 28);
    const sh = g.pick(s.shifts);
    const roll = g.int(1, 100);
    const answer = roll <= 52 ? '入った' : roll <= 88 ? '断った' : '返信なし';
    offers.push({ date: ymd(2026, m, d), shift: sh, unitId: g.pick(UNITS).id, cause: g.pick(CAUSE), answer, note: answer === '入った' ? '欠員を補充' : answer === '断った' ? g.pick(DECLINE) : '期限までに返信なし' });
  }
  offers.sort((a, b) => b.date.localeCompare(a.date));
  const absences: StaffDetail['absences'] = [];
  for (let k = 0, n = g.int(0, 3); k < n; k++) {
    const m = g.int(5, 11); const d = m === 11 ? g.int(1, 16) : g.int(1, 28);
    const kind = g.pick(['当日欠勤', '遅刻', '早退'] as const);
    absences.push({ date: ymd(2026, m, d), kind, reason: kind === '遅刻' ? g.pick(['電車の遅延', '子どもの体調', '寝過ごし（本人申告）']) : g.pick(['体調不良', '家族の看病', '通院', '子どもの発熱']) });
  }
  absences.sort((a, b) => b.date.localeCompare(a.date));
  const training: StaffDetail['training'] = [];
  for (const k of s.skills) { const t = TRAIN[k]; if (t) training.push({ date: ymd(2026 - g.int(0, Math.min(5, s.years)), g.int(1, 12), g.int(1, 28)), title: t }); }
  training.push({ date: '2026-06-18', title: '身体拘束・虐待防止研修（年次）' }, { date: '2026-07-16', title: '感染症・食中毒予防研修（年次）' }, { date: '2026-09-10', title: '防災訓練・避難誘導（年次）' });
  training.sort((a, b) => b.date.localeCompare(a.date));
  // 経歴
  const hy = 2026 - s.years; const hm = g.pick([4, 4, 4, 10, 1, 7]);
  const first = g.pick(UNITS);
  const career: StaffDetail['career'] = [{ at: `${hy}-${pad(hm)}`, text: `入職。${first.name}ユニットに配属` }];
  const licY = s.role === '新人' ? hy : Math.max(hy, hy + g.int(0, Math.max(0, Math.min(4, s.years - 1))));
  const licText = s.role === '新人' ? '介護職員初任者研修 修了' : s.role === '介護職員' ? '実務者研修 修了' : '介護福祉士 登録';
  career.push({ at: `${licY}-${pad(g.int(1, 12))}`, text: licText });
  if (first.id !== s.homeUnit) career.push({ at: `${hy + Math.max(1, Math.floor(s.years / 2))}-04`, text: `${UNITS.find((u) => u.id === s.homeUnit)!.name}ユニットへ異動` });
  if (s.role === '主任') career.push({ at: `${2026 - g.int(3, 8)}-04`, text: '主任に昇格' });
  if (s.skills.includes('preceptor')) career.push({ at: `${2026 - g.int(1, 4)}-04`, text: '新人のプリセプターを担当' });
  career.push({ at: '2026-04', text: `年度面談：目標「${g.pick(GOALS[s.role])}」` }, { at: '2026-10', text: `中間面談：${g.pick(['目標に向けて順調', '夜勤の回数を調整したいと相談', '家庭との両立について相談（勤務帯の希望を更新）', '研修の受講希望を確認'])}` });
  career.sort((a, b) => b.at.localeCompare(a.at));
  // 人事
  const weekly = part ? (s.leaveBy ? 24 : g.pick([16, 20, 24, 30])) : 40;
  const total = part ? Math.min(10, 4 + Math.floor(s.years / 2)) : Math.min(20, 10 + s.years);
  const allowances = [night ? '夜勤手当' : '', s.role === '介護福祉士' ? '資格手当（介護福祉士）' : s.role === '介護職員' ? '資格手当（実務者研修）' : '', s.role === '主任' ? '役職手当' : '', s.skills.includes('medical') ? '医療的ケア手当' : '', s.skills.includes('driver') ? '送迎手当' : ''].filter(Boolean);
  return {
    empNo: s.id,
    wish: {
      shifts: wishShifts || '未登録', avoidWeekdays: avoid.length ? avoid.join('・') + '曜' : '特になし',
      nights: night ? `月${g.pick(['3〜4', '4〜5', '5〜6', '4〜6'])}回まで` : '夜勤なし',
      maxConsecutive: `${g.pick([4, 5, 5, 6])}連勤まで`, dayOff: g.pick(['土日のどちらかは休み希望', '平日休みを希望', '連休（2日続き）を月1回', '特になし']),
      units: g.chance(0.35) ? `${UNITS.find((u) => u.id === s.homeUnit)!.name}（所属）・${g.pick(UNITS).name}` : `${UNITS.find((u) => u.id === s.homeUnit)!.name}（所属）`,
      partner: s.role === '新人' && preceptorOf ? `指導担当：${preceptorOf.name}（同ユニット）` : mate.length && g.chance(0.4) ? `${g.pick(mate).name}とのペア勤務を希望` : '特になし',
      commute: `${g.pick(COMMUTE)}・片道${g.int(10, 55)}分`, considerations: cons, note: g.pick(['', '', '早番が続くと朝がつらい', '夕方の用事が多いので遅番は月2回まで', '新しい業務は声をかけてもらえると助かる', '繁忙日の応援は前日までの連絡を希望']),
    },
    months, offers, absences, training, career,
    hr: {
      hiredOn: `${hy}-${pad(hm)}-01`, contract: part ? 'パート（有期・半年更新）' : '正社員（無期）', contractEnd: part ? g.pick(['2026-12-31', '2027-03-31']) : undefined,
      pay: part ? '時給制' : '月給制', grade: s.role === '主任' ? '主任職' : s.role === '介護福祉士' ? '介護福祉士（中堅）' : s.role === '介護職員' ? '介護職員（一般）' : '見習い', allowances,
      weeklyHours: weekly, paidLeave: { total, used: Math.min(total - 1, g.int(2, Math.max(3, total - 3))) },
      insurance: weekly >= 20 ? '社会保険・雇用保険に加入' : '雇用保険のみ（週20時間未満）',
      license: `${s.license}（登録番号 KF-${String(num * 137 + 4000).padStart(6, '0')}・架空）`, licensedOn: `${licY}-${pad(g.int(1, 12))}`,
      emergency: `${g.pick(['配偶者', '母', '父', '姉', '兄', '友人'])}（090-0000-${String(5000 + num)}・架空）`,
    },
  };
}

const _staff = new Map<string, StaffDetail>();
export const staffDetail_ = (id: string): StaffDetail | undefined => {
  if (!_staff.has(id)) { const i = STAFF.findIndex((x) => x.id === id); if (i < 0) return undefined; _staff.set(id, staffDetail(i)); }
  return _staff.get(id);
};

// ------------------------------------------------------------------ 入居者

export interface ResidentDetail {
  birth: string; admittedOn: string; stay: string; certNo: string;
  cert: { period: string; copay: string; insurer: string; careManager: string; nextReview: string };
  independence: { disability: string; dementia: string };
  meal: { form: string; thickener: string; amount: string; tool: string; allergies: string[]; likes: string[]; dislikes: string[] };
  elimination: { day: string; night: string };
  mobility: { device: string; transfer: string; sensor: string };
  bath: { method: string; days: string; time: string };
  sleep: { bed: string; wake: string; night: string };
  medication: { schedule: string; kinds: number; method: string; form: string };
  senses: { vision: string; hearing: string; denture: string; communication: string };
  risks: { fall: string; aspiration: string; wander: string; skin: string };
  family: { name: string; relation: string; phone: string; keyPerson: boolean; contact: string; visits: string }[];
  prefs: { callName: string; former: string; hobbies: string[]; routine: string[] };
  endOfLife: string;
  points: string[];
  history: { at: string; text: string }[];
}

const DEMENTIA_LV = ['自立', 'Ⅰ', 'Ⅱa', 'Ⅱb', 'Ⅲa', 'Ⅲb', 'Ⅳ'];
const FORMER = ['農家', '小学校教員', '会社員（事務）', '商店の経営', '大工', '裁縫・仕立て', '市役所勤務', '主婦（家業の手伝い）'];
const HOBBY = ['編み物', '俳句', '演歌・民謡', '将棋', '園芸', '時代劇のテレビ', '折り紙', '散歩', '習字', '相撲観戦', 'カラオケ', '野球中継', 'ぬり絵'];
const FOOD = ['甘いもの', '味噌汁', '焼き魚', '果物', '煮物', '漬物', 'コーヒー', 'ヨーグルト'];
const DISLIKE = ['辛いもの', '生もの', '脂っこいもの', '酸っぱいもの', '牛乳', '納豆'];
const ROUTINE = ['朝は温かいお茶から始める', '朝刊を読む', '夕方に仏壇へ手を合わせる', '午後に30分ほど昼寝', '食後に歯みがきを自分でする', '夜はラジオを聞いて休む'];
const FAM_NAME = ['山田', '佐藤', '鈴木', '高田', '小川', '村上', '原田', '近藤', '坂本', '三浦'];
const FAM_F = ['美和', '裕子', '恵', '直美', '智子', '陽子'];
const FAM_M = ['健', '誠', '大輔', '浩', '拓也', '修'];
const CARE_MGR = ['青山 恵（居宅介護支援・架空）', '森田 浩（居宅介護支援・架空）', '堀内 由紀（居宅介護支援・架空）'];
const EVENTS = ['家族面談を実施', '誕生日会に参加', '口腔ケアの見直し', '看護師が体調を確認', '居室の模様替え（動線を確保）', '歩行訓練の頻度を見直し', 'ヒヤリハット（ベッド脇でふらつき・受傷なし）'];

function residentDetail(i: number): ResidentDetail {
  const r = RESIDENTS[i];
  const g = mk(7000 + i * 17);
  const has = (w: string) => r.notes.some((n) => n.includes(w));
  const tube = r.medical.some((m) => m.includes('経管'));
  const lv = r.careLevel;
  // 生年月日・入居日・認定
  const bm = g.int(1, 12), bd = g.int(1, 28);
  const by = 2026 - r.age - (bm * 100 + bd > 1118 ? 1 : 0);
  const adm = g.int(2019, 2026), am = adm === 2026 ? g.int(1, 8) : g.int(1, 12);
  const stayM = (2026 - adm) * 12 + (11 - am);
  const cm = g.int(1, 10); const cFrom = ymd(2026, cm, 1); const cTo = ymd(2027, cm, 28); // 認定の有効期間は12か月（直近に更新）
  // 認知症・障害高齢者の日常生活自立度
  const dBase = lv <= 2 ? g.int(0, 2) : lv === 3 ? g.int(2, 4) : g.int(3, 6);
  const dem = has('徘徊') ? 5 : has('不穏') ? Math.max(dBase, 4) : dBase;
  const disability = ({ 1: ['J2', 'A1'], 2: ['A1', 'A2'], 3: ['A2', 'B1'], 4: ['B1', 'B2'], 5: ['B2', 'C1', 'C2'] } as Record<number, string[]>)[lv];
  // 食事
  const form = tube ? '経管栄養（胃ろう）' : has('嚥下') ? g.pick(['ミキサー', '刻み']) : r.adl.meal === '全介助' ? 'ミキサー' : r.adl.meal === '一部介助' ? g.pick(['一口大', '刻み']) : '常食';
  const thick = tube ? '経口なし' : has('嚥下') ? g.pick(['中間のとろみ', '濃いとろみ']) : r.adl.meal === '全介助' ? '薄いとろみ' : 'なし';
  // 排泄・移動・入浴
  const elimDay = ({ 自立: 'トイレ（自立）', 見守り: 'トイレ（見守り）', 一部介助: 'トイレ誘導＋リハビリパンツ', 全介助: 'おむつ交換（パッド併用）' } as const)[r.adl.excretion];
  const elimNight = has('頻回') ? 'ポータブルトイレ使用・2時間ごとに声かけ' : r.adl.excretion === '全介助' ? 'パッド交換（巡回時）' : r.adl.excretion === '一部介助' ? '就寝前に誘導・夜間は希望時' : '自立（足元灯あり）';
  const device = has('片麻痺') ? '杖（右手）／車いす併用' : ({ 自立: '独歩', 見守り: '歩行器', 一部介助: '車いす（自走）', 全介助: '車いす（介助）' } as const)[r.adl.transfer];
  const bathMethod = ({ 自立: '一般浴', 見守り: '一般浴（見守り）', 一部介助: '特浴（座位）', 全介助: '機械浴（臥位）' } as const)[r.adl.bath];
  // 健康・服薬
  const night = has('不穏') ? '不穏あり（夜間の見守りを強化）' : has('頻回') ? 'トイレで2〜3回の中途覚醒' : g.pick(['良眠', '良眠', '寝つきに時間がかかる']);
  const rel = [g.pick(['長女', '長男', '次女']), g.pick(['次男', '孫（女）', '孫（男）', '姪', '甥'])];
  const famGiven = (rl: string) => (/女|姪/.test(rl) ? g.pick(FAM_F) : g.pick(FAM_M));
  const fam = [0, 1].slice(0, g.chance(0.6) ? 2 : 1).map((k) => ({
    name: `${k === 0 ? r.name.split(' ')[0] : g.pick(FAM_NAME)} ${famGiven(rel[k])}`, relation: rel[k],
    phone: `090-0000-${String(3000 + i * 3 + k)}（架空）`, keyPerson: k === 0, contact: g.pick(['平日の18時以降', '日中は仕事のため留守電に', 'メール優先（架空）', '緊急時は携帯へ']), visits: g.pick(['週1回', '月2回', '月1回', '年に数回']),
  }));
  const eol = lv >= 4 ? g.pick(['看取りを希望（家族と確認済み・2026-06）', '看取りを希望（家族と確認済み・2026-09）', '延命措置は望まない（本人・家族で確認）']) : g.pick(['未確認（次回の面談で確認）', '病院での治療を希望（家族と確認済み）', '未確認（次回の面談で確認）']);
  const given = r.name.split(' ')[1];
  const points = [
    `食事：${form}${thick !== 'なし' && thick !== '経口なし' ? `、${thick}` : ''}${has('拒食') ? '。食が進まない日は声かけと好物で促す' : ''}${r.adl.meal !== '自立' ? `（${r.adl.meal}）` : ''}`,
    `排泄：${elimDay}。夜間は${elimNight}`,
    `移動：${device}。移乗は${r.adl.transfer}${r.fallRisk === 'high' ? '。離床時は必ず付き添う' : ''}`,
    `入浴：${bathMethod}${has('午後') ? '。本人の希望で午後に実施' : ''}`,
    ...(has('難聴') ? ['会話：耳元で、ゆっくり話す'] : []), ...(has('片麻痺') ? ['介助：右側から。左側へ体重をかけない'] : []), ...(has('徘徊') ? ['外出：玄関付近の様子に注意し、施錠を確認する'] : []),
    ...(r.medical.length ? [`医療的ケア：${r.medical.join('・')}。対応できる職員の配置が必要`] : []),
  ];
  const history: ResidentDetail['history'] = [{ at: `${adm}-${pad(am)}`, text: '入居。ケアプランを作成' }, { at: cFrom.slice(0, 7), text: `要介護認定を更新（要介護${lv}）` }, { at: ymd(2026, g.int(5, 10), 1).slice(0, 7), text: 'ケアプランの見直し（担当者会議）' }, ...g.some(EVENTS, 2).map((t) => ({ at: ymd(2026, g.int(6, 11), 1).slice(0, 7), text: t }))];
  history.sort((a, b) => b.at.localeCompare(a.at));
  return {
    birth: `昭和${by - 1925}年${bm}月${bd}日（${r.age}歳）`, admittedOn: `${adm}-${pad(am)}`, stay: stayM >= 12 ? `${Math.floor(stayM / 12)}年${stayM % 12}か月` : `${stayM}か月`, certNo: `被保険者番号 0000${String(10000 + i * 13)}（架空）`,
    cert: { period: `${cFrom}〜${cTo}`, copay: g.pick(['1割', '1割', '1割', '2割']), insurer: '架空市 介護保険', careManager: g.pick(CARE_MGR), nextReview: `${ymd(2027, cm, 1).slice(0, 7)}（満了の約1か月前に更新申請）` },
    independence: { disability: g.pick(disability), dementia: DEMENTIA_LV[dem] },
    meal: { form, thickener: thick, amount: has('拒食') ? '5〜7割（声かけで増える）' : '全量', tool: r.adl.meal === '自立' ? '箸・スプーン' : g.pick(['スプーン（持ち手が太いもの）', '自助食器', '介助用スプーン']), allergies: g.chance(0.22) ? [g.pick(['卵', 'そば', 'えび・かに', '乳製品', 'さば'])] : [], likes: g.some(FOOD, 2), dislikes: g.some(DISLIKE, g.int(0, 2)) },
    elimination: { day: elimDay, night: elimNight },
    mobility: { device, transfer: r.adl.transfer, sensor: has('センサー') || r.fallRisk === 'high' ? '離床センサーを使用' : '使用なし' },
    bath: { method: bathMethod, days: ['月・木', '火・金', '水・土', '月・木'][Math.floor(i / 10)], time: has('午後') ? '午後（希望）' : '午前' },
    sleep: { bed: g.pick(['20:30', '21:00', '21:00', '21:30']), wake: g.pick(['06:00', '06:30', '07:00']), night },
    medication: { schedule: g.pick(['朝・夕', '朝・昼・夕', '朝・夕・就寝前', '朝のみ']), kinds: g.int(2, 9), method: '職員が管理し、服用を確認', form: has('嚥下') || lv >= 4 ? 'とろみやゼリーに混ぜて服用' : '水で服用' },
    senses: { vision: g.pick(['眼鏡を使用', '見えにくさあり（明るさに配慮）', '特になし']), hearing: has('難聴') ? '難聴（耳元で話す）' : g.pick(['特になし', '特になし', '補聴器を使用']), denture: g.pick(['総入れ歯（夜間は外す）', '部分入れ歯', '自歯（口腔ケアは見守り）']), communication: dem <= 2 ? '意思表示は明確' : dem <= 4 ? '簡単な質問なら答えられる' : '表情・しぐさで気持ちを読み取る' },
    risks: { fall: ({ low: '低', mid: '中', high: '高' } as const)[r.fallRisk], aspiration: has('嚥下') || tube ? '高（食事の姿勢・とろみに注意）' : '低', wander: has('徘徊') ? '高（出口の施錠確認）' : 'なし', skin: lv >= 4 ? '中（2〜3時間ごとの体位変換）' : '低' },
    family: fam,
    prefs: { callName: `${given}さん`, former: g.pick(FORMER), hobbies: g.some(HOBBY, 3), routine: g.some(ROUTINE, 2) },
    endOfLife: eol, points, history,
  };
}

const _res = new Map<string, ResidentDetail>();
export const residentDetail_ = (id: string): ResidentDetail | undefined => {
  if (!_res.has(id)) { const i = RESIDENTS.findIndex((x) => x.id === id); if (i < 0) return undefined; _res.set(id, residentDetail(i)); }
  return _res.get(id);
};
