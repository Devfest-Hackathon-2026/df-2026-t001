export const pad = (n: number) => String(n).padStart(2, '0');
export const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return toYmd(d); };
export const dow = (s: string) => parseYmd(s).getDay();
export const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
export const fmtMD = (s: string) => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}（${DOW_JA[d.getDay()]}）`; };
export const fmtLong = (s: string) => { const d = parseYmd(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DOW_JA[d.getDay()]}）`; };
export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const fmtMin = (m: number) => { const day = m >= 1440 ? '翌' : ''; const mm = ((m % 1440) + 1440) % 1440; return `${day}${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`; };
export const fmtHM = (m: number) => { const mm = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`; };
export const monthStart = (s: string) => s.slice(0, 7) + '-01';
export const daysInRange = (a: string, b: string) => { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
let simNow = '';
export const setSimNow = (s: string) => { simNow = s; };
export const addMinutes = (stamp: string, n: number) => { const [d, t] = stamp.split(' '); const [h, m] = t.split(':').map(Number); const dt = parseYmd(d); dt.setHours(h, m + n); return `${toYmd(dt)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`; };
export const stampDay = (stamp: string) => stamp.split(' ')[0];
export const stampMin = (stamp: string) => toMin(stamp.split(' ')[1]);
export const stampTime = (stamp: string) => stamp.split(' ')[1];
export const nowStamp = () => { if (simNow) return simNow; const d = new Date(); return `${toYmd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 実在する日付なら YYYY-MM-DD、なければ undefined（2/30・4/31 などを弾く） */
export const ymdOf = (y: number, m: number, d: number): string | undefined => { if (m < 1 || m > 12 || d < 1) return undefined; const dt = new Date(y, m - 1, d); return dt.getMonth() === m - 1 && dt.getDate() === d ? toYmd(dt) : undefined; };
/** 「M/D」：今年の日付。30日より前に過ぎた日付は来年とみなす（12月に「1/5」→翌年1/5）。実在しない日付は undefined */
export const resolveMonthDay = (today: string, m: number, d: number): string | undefined => {
  const y = parseYmd(today).getFullYear();
  const cur = ymdOf(y, m, d);
  if (cur && cur >= addDays(today, -30)) return cur;
  return ymdOf(y + 1, m, d) ?? cur;
};
/** 「N日」：今日以降で最初にその日がある月の日付（11月に「31日」→12/31）。1〜31 以外は undefined */
export const resolveDayOfMonth = (today: string, d: number): string | undefined => {
  if (d < 1 || d > 31) return undefined;
  const t = parseYmd(today);
  for (let k = 0; k < 13; k++) { const f = new Date(t.getFullYear(), t.getMonth() + k, 1); const x = ymdOf(f.getFullYear(), f.getMonth() + 1, d); if (x && x >= today) return x; }
  return undefined;
};
/** 「M月」：今月以降で最初のその月（12月に「1月」→翌年1月）。YYYY-MM */
export const resolveMonth = (today: string, m: number): string | undefined => {
  if (m < 1 || m > 12) return undefined;
  const y = parseYmd(today).getFullYear(); const cm = parseYmd(today).getMonth() + 1;
  return `${m < cm ? y + 1 : y}-${pad(m)}`;
};
