import { useEffect, useState } from 'preact/hooks';

/** 施設の地域（デモは名古屋）の今日の天気。Open-Meteo（キー不要）から取り、失敗したら何も出さない */
const PLACE = { name: '名古屋', lat: 35.18, lon: 136.91 };
type Kind = 'sun' | 'part' | 'cloud' | 'rain' | 'snow' | 'storm' | 'fog';
type W = { kind: Kind; label: string; max: number; min: number; pop?: number };
const KEY = 'leader-weather-v1';

function kindOf(code: number): [Kind, string] {
  if (code === 0) return ['sun', '晴れ'];
  if (code <= 2) return ['part', '晴れ時々くもり'];
  if (code === 3) return ['cloud', 'くもり'];
  if (code === 45 || code === 48) return ['fog', '霧'];
  if (code >= 95) return ['storm', '雷雨'];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['snow', '雪'];
  return ['rain', '雨'];
}

export function Weather() {
  const [w, setW] = useState<W | null>(() => { try { const c = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as (W & { at: number }) | null; return c && Date.now() - c.at < 3 * 3600e3 ? c : null; } catch { return null; } });
  useEffect(() => {
    if (w) return;
    const ctl = new AbortController();
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${PLACE.lat}&longitude=${PLACE.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=1`;
    fetch(url, { signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const d = j?.daily; if (!d?.weather_code?.length) return;
      const [kind, label] = kindOf(d.weather_code[0]);
      const v: W = { kind, label, max: Math.round(d.temperature_2m_max[0]), min: Math.round(d.temperature_2m_min[0]), pop: d.precipitation_probability_max?.[0] ?? undefined };
      setW(v); try { sessionStorage.setItem(KEY, JSON.stringify({ ...v, at: Date.now() })); } catch { /* 保存できなくても表示はする */ }
    }).catch(() => { /* 取れなければ出さない */ });
    return () => ctl.abort();
  }, []);
  if (!w) return null;
  return (
    <span class="wx" title={`${PLACE.name}の今日の天気（Open-Meteo）`}>
      <WxIcon kind={w.kind} />
      <span class="wx-t"><b>{w.label}</b><span class="small">{PLACE.name}　{w.max}° / {w.min}°{w.pop !== undefined ? `　降水 ${w.pop}%` : ''}</span></span>
    </span>
  );
}

function WxIcon({ kind }: { kind: Kind }) {
  const sun = <g><circle cx="16" cy="16" r="7" fill="#fbbc04" />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <rect key={a} x="15" y="2" width="2" height="5" rx="1" fill="#fbbc04" transform={`rotate(${a} 16 16)`} />)}</g>;
  const cloud = (x: number, y: number, c = '#c7d0dc') => <path d={`M${x + 6} ${y + 14}h14a5 5 0 0 0 0-10a7 7 0 0 0-13-2a5 5 0 0 0-1 12z`} fill={c} />;
  return (
    <svg class="wx-i" viewBox="0 0 40 36" width="40" height="36" aria-hidden="true">
      {kind === 'sun' && <g transform="translate(4 2)">{sun}</g>}
      {kind === 'part' && <><g transform="translate(0 -2) scale(.85)">{sun}</g>{cloud(10, 14, '#dfe5ee')}</>}
      {(kind === 'cloud' || kind === 'fog') && <>{cloud(4, 4, '#dfe5ee')}{cloud(10, 12)}</>}
      {kind === 'fog' && [24, 29, 34].map((y) => <rect key={y} x="6" y={y - 2} width="28" height="2" rx="1" fill="#aab4c3" />)}
      {kind === 'rain' && <>{cloud(6, 4, '#aab8cc')}{[12, 19, 26].map((x) => <path key={x} d={`M${x} 24l-2 6`} stroke="#4a8fe7" stroke-width="2.2" stroke-linecap="round" />)}</>}
      {kind === 'snow' && <>{cloud(6, 4, '#c7d0dc')}{[12, 20, 28].map((x) => <circle key={x} cx={x} cy="28" r="2" fill="#8fb7ef" />)}</>}
      {kind === 'storm' && <>{cloud(6, 4, '#8f9bb0')}<path d="M20 20l-4 7h4l-3 7 8-10h-4l3-4z" fill="#fbbc04" /></>}
    </svg>
  );
}
