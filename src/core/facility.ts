import type { ShiftCode, SkillId, Staff, Resident, TaskKind, Unit, Adl } from './types';

export const FACILITY = { name: 'さくら苑', kind: '特別養護老人ホーム（架空）', capacity: 40 };
export const DEMO_TODAY = '2026-11-18';
export const MY_ID = 'EMP-017'; // 美咲
export const LEADER_ID = 'EMP-001'; // 小林（主任）

export const UNITS: Unit[] = [
  { id: 'U1', name: 'ひなた', floor: 1, capacity: 10 },
  { id: 'U2', name: 'そよかぜ', floor: 1, capacity: 10 },
  { id: 'U3', name: 'あかり', floor: 2, capacity: 10 },
  { id: 'U4', name: 'つぼみ', floor: 2, capacity: 10 },
];
export const unitName = (id: string) => UNITS.find((u) => u.id === id)?.name ?? id;
export const floorOf = (unitId: string) => UNITS.find((u) => u.id === unitId)?.floor ?? 1;

export const SHIFTS: Record<ShiftCode, { start: number; end: number; label: string; breakMin: number; short: string }> = {
  早番: { start: 7 * 60, end: 16 * 60, label: '07:00〜16:00', breakMin: 60, short: '早' },
  日勤: { start: 9 * 60, end: 18 * 60, label: '09:00〜18:00', breakMin: 60, short: '日' },
  遅番: { start: 12 * 60, end: 21 * 60, label: '12:00〜21:00', breakMin: 60, short: '遅' },
  夜勤: { start: 16 * 60 + 30, end: 33 * 60 + 30, label: '16:30〜翌09:30', breakMin: 120, short: '夜' },
};
export const SHIFT_ORDER: ShiftCode[] = ['早番', '日勤', '遅番', '夜勤'];

export const SKILLS: Record<SkillId, { label: string; note: string }> = {
  medical: { label: '医療的ケア', note: '喀痰吸引・経管栄養（研修修了・要件確認済み）' },
  dementia: { label: '認知症ケア', note: '認知症介護実践者研修 等' },
  bath: { label: '入浴介助', note: '機械浴・特浴の操作可' },
  swallow: { label: '嚥下配慮', note: '食事形態・誤嚥予防の介助' },
  driver: { label: '送迎', note: '運転可（送迎業務）' },
  terminal: { label: '看取りケア', note: '看取り期の対応研修修了' },
  follow: { label: 'フォロー可', note: '新人・他ユニットの補助ができる' },
  night: { label: '夜勤可', note: '夜勤に入れる' },
  ict: { label: '記録・ICT', note: '記録システムの入力・集計' },
  preceptor: { label: '新人指導', note: 'プリセプター経験あり' },
};

// 業務種別。色は5系統の淡色に統合（種類の違いはラベルで区別）
export type TaskGroup = 'direct' | 'watch' | 'medical' | 'admin' | 'life' | 'rest';
export const TASK_GROUPS: Record<TaskGroup, { label: string; bg: string; fg: string; bar: string }> = {
  direct: { label: '直接介助（食事・排泄・入浴・起床・就寝）', bg: '#E8EEF7', fg: '#2F4A73', bar: '#9DB4D6' },
  watch: { label: '見守り・巡回', bg: '#E7F1EC', fg: '#2D6248', bar: '#9CC4AE' },
  medical: { label: '医療的ケア・服薬', bg: '#F3E9EE', fg: '#7A3552', bar: '#D2A7BA' },
  admin: { label: '記録・引き継ぎ・環境整備', bg: '#EEEFF1', fg: '#4A4F57', bar: '#BFC3CA' },
  life: { label: 'レク・送迎', bg: '#F5EFE3', fg: '#6E5426', bar: '#D7C49B' },
  rest: { label: '休憩・仮眠', bg: '#FFFFFF', fg: '#5F6368', bar: '#DADCE0' },
};
const G = (group: TaskGroup, label: string) => ({ label, group, bg: TASK_GROUPS[group].bg, fg: TASK_GROUPS[group].fg });
export const TASKS: Record<TaskKind, { label: string; group: TaskGroup; bg: string; fg: string }> = {
  handover: G('admin', '引き継ぎ'), wake: G('direct', '起床・整容'), meal: G('direct', '食事介助'), excretion: G('direct', '排泄介助'),
  bath: G('direct', '入浴介助'), med: G('medical', '配薬・服薬'), medical: G('medical', '医療的ケア'), round: G('watch', '巡回'),
  record: G('admin', '記録'), rec: G('life', 'レク・機能訓練'), transport: G('life', '送迎'), laundry: G('admin', '環境整備・洗濯'),
  bed: G('direct', '就寝介助'), watch: G('watch', '見守り・待機'), break: G('rest', '休憩'), nap: G('rest', '仮眠休憩'),
};

const S = (
  id: number, name: string, kana: string, age: number, years: number,
  role: Staff['role'], employment: Staff['employment'], skills: SkillId[], shifts: ShiftCode[],
  homeUnit: string, extra: Partial<Staff> = {},
): Staff => ({
  id: `EMP-${String(id).padStart(3, '0')}`, name, kana, age, years, role, employment,
  license: role === '新人' ? '初任者研修' : role === '介護職員' ? '実務者研修' : '介護福祉士',
  skills, shifts, homeUnit, phone: `090-0000-${String(1000 + id)}`, ...extra,
});
const ALL: ShiftCode[] = ['早番', '日勤', '遅番', '夜勤'];
const DAY: ShiftCode[] = ['早番', '日勤', '遅番'];

export const STAFF: Staff[] = [
  S(1, '小林 健一', 'こばやし けんいち', 46, 21, '主任', '常勤', ['follow', 'medical', 'dementia', 'ict', 'preceptor', 'night', 'terminal'], ['日勤', '早番'], 'U1', { isLeader: true }),
  S(2, '田中 恵子', 'たなか けいこ', 41, 15, '介護福祉士', '常勤', ['medical', 'dementia', 'bath', 'night', 'terminal', 'follow'], ALL, 'U1'),
  S(3, '佐々木 翔', 'ささき しょう', 33, 9, '介護福祉士', '常勤', ['medical', 'night', 'driver', 'bath', 'swallow'], ALL, 'U2'),
  S(4, '山本 由美', 'やまもと ゆみ', 52, 24, '介護福祉士', '常勤', ['dementia', 'terminal', 'swallow', 'follow', 'preceptor'], DAY, 'U2'),
  S(5, '伊藤 大輔', 'いとう だいすけ', 29, 6, '介護福祉士', '常勤', ['medical', 'night', 'bath', 'driver'], ALL, 'U3'),
  S(6, '高橋 美穂', 'たかはし みほ', 38, 12, '介護福祉士', '常勤', ['medical', 'dementia', 'night', 'ict'], ALL, 'U3'),
  S(7, '渡辺 光', 'わたなべ ひかる', 27, 4, '介護職員', '常勤', ['night', 'bath', 'driver'], ALL, 'U4'),
  S(8, '中島 里奈', 'なかじま りな', 31, 7, '介護福祉士', '常勤', ['medical', 'night', 'swallow', 'dementia'], ALL, 'U4'),
  S(9, '加藤 誠', 'かとう まこと', 45, 18, '介護福祉士', '常勤', ['night', 'terminal', 'bath', 'follow', 'driver'], ALL, 'U1'),
  S(10, '吉田 菜々', 'よしだ なな', 24, 2, '介護職員', '常勤', ['night', 'bath'], ALL, 'U2'),
  S(11, '山田 拓也', 'やまだ たくや', 35, 10, '介護福祉士', '常勤', ['medical', 'night', 'dementia', 'bath'], ALL, 'U3'),
  S(12, '松本 沙織', 'まつもと さおり', 39, 13, '介護福祉士', '常勤', ['dementia', 'swallow', 'ict', 'follow'], DAY, 'U4'),
  S(13, '井上 剛', 'いのうえ つよし', 48, 20, '介護福祉士', '常勤', ['medical', 'night', 'terminal', 'bath', 'preceptor'], ALL, 'U1'),
  S(14, '木村 愛', 'きむら あい', 26, 3, '介護職員', '常勤', ['night', 'swallow'], ALL, 'U2'),
  S(15, '林 悠斗', 'はやし ゆうと', 23, 1, '新人', '常勤', [], ['早番', '日勤', '遅番'], 'U3'),
  S(16, '斎藤 香織', 'さいとう かおり', 44, 16, '介護福祉士', 'パート', ['dementia', 'bath', 'swallow'], ['日勤', '早番'], 'U1', { leaveBy: '15:00', leaveReason: '子どもの迎え' }),
  S(17, '中村 美咲', 'なかむら みさき', 30, 8, '介護福祉士', '常勤', ['medical', 'night', 'dementia', 'bath', 'swallow'], ALL, 'U3', { leaveBy: '18:00', leaveReason: '送迎のため（夕勤の日）', breakPref: '02:00ごろ（夜勤）' }),
  S(18, '清水 大地', 'しみず だいち', 28, 5, '介護職員', '常勤', ['night', 'driver', 'bath'], ALL, 'U4'),
  S(19, '森 千尋', 'もり ちひろ', 36, 11, '介護福祉士', '常勤', ['medical', 'night', 'follow', 'ict'], ALL, 'U2'),
  S(20, '池田 優', 'いけだ ゆう', 25, 2, '介護職員', '常勤', ['night', 'bath'], ALL, 'U3'),
  S(21, '橋本 真理', 'はしもと まり', 50, 22, '介護福祉士', 'パート', ['dementia', 'terminal', 'swallow'], ['早番', '日勤'], 'U4', { leaveBy: '16:00', leaveReason: '家族の介護' }),
  S(22, '石川 徹', 'いしかわ とおる', 42, 14, '介護福祉士', '常勤', ['medical', 'night', 'driver', 'bath', 'follow'], ALL, 'U1'),
  S(23, '前田 彩', 'まえだ あや', 32, 7, '介護福祉士', '常勤', ['medical', 'dementia', 'night', 'swallow'], ALL, 'U2'),
  S(24, '藤田 蓮', 'ふじた れん', 22, 1, '新人', '常勤', ['night'], ['早番', '日勤', '遅番', '夜勤'], 'U4'),
  S(25, '岡田 紀子', 'おかだ のりこ', 55, 26, '介護福祉士', 'パート', ['dementia', 'terminal', 'preceptor'], ['日勤', '遅番'], 'U3'),
  S(26, '後藤 リナ', 'ごとう りな', 29, 5, '介護福祉士', '常勤', ['medical', 'night', 'dementia', 'bath'], ALL, 'U1'),
  S(27, '宮崎 陽菜', 'みやざき ひな', 27, 4, '介護職員', '常勤', ['night', 'swallow', 'bath'], ALL, 'U2'),
  S(28, '坂田 亮', 'さかた りょう', 34, 8, '介護福祉士', '常勤', ['medical', 'night', 'driver', 'dementia'], ALL, 'U4'),
  S(29, '原 美紀', 'はら みき', 40, 12, '介護福祉士', '常勤', ['medical', 'night', 'bath', 'swallow'], ALL, 'U3'),
  S(30, '金子 俊', 'かねこ しゅん', 31, 6, '介護職員', '常勤', ['night', 'bath', 'driver'], ALL, 'U1'),
  S(31, '長谷川 凛', 'はせがわ りん', 25, 3, '介護職員', '常勤', ['night', 'dementia'], ALL, 'U2'),
  S(32, '野口 剛史', 'のぐち たけし', 37, 11, '介護福祉士', '常勤', ['medical', 'night', 'follow', 'bath'], ALL, 'U4'),
  S(33, '内田 さくら', 'うちだ さくら', 28, 5, '介護職員', '常勤', ['night', 'swallow', 'ict'], ALL, 'U3'),
  S(34, '安藤 康介', 'あんどう こうすけ', 43, 17, '介護福祉士', '常勤', ['medical', 'night', 'terminal', 'bath'], ALL, 'U1'),
  S(900, '応募者 リナ', 'おうぼしゃ りな', 29, 5, '介護福祉士', 'パート', ['medical', 'night', 'dementia'], [], 'U1', { phone: '（求人経由・架空）' }),
  S(901, '応募者 佐藤 カズ', 'おうぼしゃ かず', 34, 9, '介護福祉士', 'パート', ['night', 'dementia', 'bath'], [], 'U1', { phone: '（求人経由・架空）' }),
  S(902, '応募者 大西 アヤ', 'おうぼしゃ あや', 41, 14, '介護福祉士', 'パート', ['medical', 'night', 'swallow', 'terminal'], [], 'U1', { phone: '（求人経由・架空）' }),
];
export const staffById = (id: string) => STAFF.find((s) => s.id === id)!;

const FAMILY = ['山田','佐藤','鈴木','高田','小川','村上','原田','近藤','坂本','三浦','青木','福田','野村','大野','今井','上野','岩崎','菊地','久保','西村'];
const GIVEN_F = ['ハル','キヨ','トミ','フミ','ヨシ','マサ','シズ','チヨ','ミツ','ナツ','スミ','タネ','イネ','ハナ','サダ','アイ','トシ','ミヨ','ヒデ','カツ'];
const GIVEN_M = ['茂','清','勇','進','實','正雄','義男','勝','博','忠','昭','久','豊','孝','信一','健二','武','稔','哲','譲'];

const adlOf = (lv: number): Resident['adl'] => {
  const pick = (n: number): Adl => (['自立', '見守り', '一部介助', '全介助'] as Adl[])[Math.max(0, Math.min(3, n))];
  return { meal: pick(lv - 3), excretion: pick(lv - 2), bath: pick(lv - 2), transfer: pick(lv - 2) };
};
const MEDICAL: Record<number, string[]> = { 3: ['喀痰吸引'], 12: ['経管栄養（胃ろう）'], 17: ['喀痰吸引', '経管栄養（胃ろう）'], 24: ['インスリン注射（看護師）'], 31: ['喀痰吸引'], 36: ['酸素吸入（看護師）'] };
const NOTES = [
  ['嚥下に注意（とろみ付き）'], ['夜間不穏あり（見守り強化）'], ['転倒歴あり（居室でセンサー使用）'], ['拒食傾向（声かけ）'],
  ['左片麻痺（右側から介助）'], ['入浴は午後を希望'], ['難聴（耳元で話す）'], [], ['徘徊傾向（出口の施錠確認）'], ['夜間トイレ頻回'],
];
export const RESIDENTS: Resident[] = Array.from({ length: 40 }, (_, i) => {
  const unitIdx = Math.floor(i / 10);
  const unitId = UNITS[unitIdx].id;
  const sex = i % 3 === 0 ? '男性' : '女性';
  const level = (([3, 4, 2, 5, 3, 4, 1, 4, 3, 5][(i * 7) % 10]) as 1 | 2 | 3 | 4 | 5);
  const room = `${UNITS[unitIdx].floor}${String(unitIdx % 2 === 0 ? 1 : 2)}${String((i % 10) + 1).padStart(2, '0')}`;
  const fall: Resident['fallRisk'] = level >= 4 ? 'mid' : i % 4 === 0 ? 'high' : 'low';
  const notes = NOTES[i % NOTES.length].slice();
  const med = MEDICAL[i] ?? [];
  return {
    id: `RES-${String(i + 1).padStart(3, '0')}`,
    name: `${FAMILY[i % FAMILY.length]} ${sex === '男性' ? GIVEN_M[i % GIVEN_M.length] : GIVEN_F[i % GIVEN_F.length]}`,
    age: 78 + ((i * 5) % 17), sex, room, unitId, careLevel: level, adl: adlOf(level), medical: med,
    notes: notes.concat(med.length ? ['医療的ケア対応者の配置が必要'] : []),
    fallRisk: fall,
    nightCheck: level >= 4 || fall === 'high' ? '2時間ごと（体位変換・排泄）' : '3時間ごと',
  };
});
export const residentsOf = (unitId: string) => RESIDENTS.filter((r) => r.unitId === unitId);
