// 音声入力のマイクボタン。押して話す → もう一度押す（30秒で自動停止）→ care-solver-api の /api/v1/voice で文字にする → 入力欄に入れる。
// 送るかどうかは本人が文を確かめて決める（ここでは何も送らない）。API が無効・ブラウザが録音に対応していないときはボタンを出さない。
import { useEffect, useRef, useState } from 'preact/hooks';
import { SOLVER } from '../leader/ai/api';
import { Icon } from './ui';

const MAX_MS = 30000;
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
let avail: Promise<boolean> | null = null;

/** サーバーで音声入力が有効か（1回だけ確かめて覚える）。 */
export function voiceAvailable(): Promise<boolean> {
  if (avail) return avail;
  const ok = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  avail = !ok ? Promise.resolve(false) : fetch(`${SOLVER}/api/v1/voice`).then((r) => (r.ok ? r.json() : null)).then((j) => !!j?.enabled).catch(() => false);
  return avail;
}

type St = 'idle' | 'rec' | 'send';

export function VoiceButton({ target, onText, onError, class: cls = 'iconbtn' }: { target: 'leader' | 'employee' | 'plan'; onText: (t: string) => void; onError?: (m: string) => void; class?: string }) {
  const [on, setOn] = useState(false);
  const [st, setSt] = useState<St>('idle');
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { let live = true; void voiceAvailable().then((v) => live && setOn(v)); return () => { live = false; stop(); }; }, []);
  const fail = (m: string) => { setSt('idle'); onError?.(m); };

  function stop() { clearTimeout(timer.current); if (rec.current?.state === 'recording') rec.current.stop(); }

  async function start() {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { fail('マイクを使えませんでした。ブラウザの設定でマイクを許可してください'); return; }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    const mr = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
    const chunks: Blob[] = []; const t0 = Date.now();
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: (mr.mimeType || type || 'audio/webm').split(';')[0] });
      if (!blob.size) { fail('録音できませんでした'); return; }
      setSt('send');
      try {
        const r = await fetch(`${SOLVER}/api/v1/voice?target=${target}&duration_ms=${Math.min(Date.now() - t0, MAX_MS)}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!r.ok || !j.text) { fail(j.error ?? `音声を文字にできませんでした（${r.status}）`); return; }
        setSt('idle'); onText(j.text);
      } catch { fail('サーバーに接続できません。ネットワークを確認してください'); }
    };
    rec.current = mr; mr.start(); setSt('rec');
    timer.current = window.setTimeout(stop, MAX_MS);
  }

  if (!on) return null;
  const label = st === 'rec' ? '録音を止めて文字にする' : st === 'send' ? '文字にしています' : '音声で入力（30秒まで）';
  return <button type="button" class={`${cls}${st === 'rec' ? ' rec' : ''}`} aria-label={label} title={label} disabled={st === 'send'} aria-pressed={st === 'rec'}
    style={st === 'rec' ? 'color:var(--bad, #c62828)' : undefined} onClick={() => (st === 'rec' ? stop() : st === 'idle' && void start())}>
    <Icon n={st === 'rec' ? 'stop_circle' : st === 'send' ? 'hourglass_top' : 'mic'} fill={st === 'rec'} /></button>;
}
