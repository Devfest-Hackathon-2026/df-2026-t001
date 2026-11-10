// care-api との状態同期（リーダー画面 ⇔ 従業員画面で同じ状態を共有）。対象: localStorage 'kana-care-state-v<N>'（現行 v8）。
// /api が存在しない環境（Cloudflareの静的配信・ローカルの file://）では何もしない＝従来どおり localStorage のみで動く。
//
// 同期の約束ごと（楽観的排他制御＋3方向マージ）:
// - サーバーは状態にバージョンを持つ。PUT は {base: 手元が最後に同期したバージョン, app} を送り、base が古ければ 409 と現在の状態が返る。
// - 409 やポーリングで他端末の更新を受けたら、base（最後に同期した状態）・local（手元）・remote（サーバー）を3方向マージする。
//   トップレベルのキーごと、id を持つ要素の配列（欠員・申請・体調チェック・メッセージ等）は要素の id ごとにマージするので、
//   別々の端末が別々の項目を変えても両方残る。同じ値を両方が変えたときだけ手元（最後に操作した側）を優先する。
// - 送信していない手元の変更がある間は、受信した状態で上書きせずマージする。送信失敗は間隔を空けて再送する。
(function () {
  'use strict';
  const isBrowser = typeof window !== 'undefined';

  // ---------- 3方向マージ（DOMに依存しない純粋関数。node でも検証できる） ----------
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  // キー順に依存しない比較用の文字列（Firestore はマップのキー順を保たないため）
  function canon(x) {
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    if (isObj(x)) return '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
    return x === undefined ? 'null' : JSON.stringify(x);
  }
  const same = (a, b) => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));
  const idKeyed = (arr) => {
    if (!Array.isArray(arr)) return false;
    const seen = new Set();
    for (const x of arr) { if (!isObj(x) || typeof x.id !== 'string' || seen.has(x.id)) return false; seen.add(x.id); }
    return true;
  };
  const byId = (arr) => { const m = new Map(); (arr || []).forEach((x) => m.set(x.id, x)); return m; };

  function mergeArrayById(base, local, remote) {
    const b = byId(base), l = byId(local), r = byId(remote);
    const out = new Map();
    const ids = new Set([...b.keys(), ...l.keys(), ...r.keys()]);
    ids.forEach((id) => { const v = merge3(b.get(id), l.get(id), r.get(id)); if (v !== undefined) out.set(id, v); });
    // 並び順: サーバー側の順を土台にし、手元で追加した要素は手元での直前の要素の後ろに差し込む
    const order = remote.map((x) => x.id).filter((id) => out.has(id));
    const placed = new Set(order);
    local.forEach((x, i) => {
      if (placed.has(x.id) || !out.has(x.id)) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) { const k = order.indexOf(local[j].id); if (k >= 0) { at = k + 1; break; } }
      order.splice(at, 0, x.id); placed.add(x.id);
    });
    out.forEach((_, id) => { if (!placed.has(id)) order.push(id); });
    return order.map((id) => out.get(id));
  }

  // undefined は「その項目が無い（削除された）」を表す
  function merge3(base, local, remote) {
    if (same(local, remote)) return local;
    if (same(base, local)) return remote; // 手元は未変更 → 他端末の変更を採用
    if (same(base, remote)) return local; // 他端末は未変更 → 手元の変更を採用
    // 両方が変更した
    if (isObj(local) && isObj(remote)) {
      const bo = isObj(base) ? base : {};
      const out = {};
      new Set([...Object.keys(local), ...Object.keys(remote)]).forEach((k) => { const v = merge3(bo[k], local[k], remote[k]); if (v !== undefined) out[k] = v; });
      return out;
    }
    if (idKeyed(local) && idKeyed(remote) && (base === undefined || idKeyed(base))) return mergeArrayById(base || [], local, remote);
    return local; // 同じ値の衝突（スカラー・idの無い配列・型の違い）は手元を優先
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { merge3, canon };
  if (!isBrowser || location.protocol === 'file:') return;

  // --- Firebase 匿名認証（REST）。Webキーは公開前提で、リファラとAPIをGCP側で制限済み ---
  const WEB_API_KEY = 'AIzaSyBn3Q1_-Okh9g8qYAikfLZrt6CbWoFNV8k';
  const TOKEN_KEY = 'care-auth';
  let tokenCache = null;
  let tokenPromise = null;

  async function fetchToken() {
    const saved = (() => { try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY)); } catch (e) { return null; } })();
    if (saved && saved.idToken && saved.exp > Date.now() + 60000) return saved;
    let r;
    if (saved && saved.refreshToken) {
      r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + WEB_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(saved.refreshToken) });
      if (r.ok) { const j = await r.json(); return saveToken({ idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: j.expires_in }); }
    }
    r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + WEB_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error('auth');
    const j = await r.json();
    return saveToken({ idToken: j.idToken, refreshToken: j.refreshToken, expiresIn: j.expiresIn });
  }
  function saveToken(t) {
    const v = { idToken: t.idToken, refreshToken: t.refreshToken, exp: Date.now() + Number(t.expiresIn || 3600) * 1000 };
    try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(v)); } catch (e) { /* 保存不可でもメモリで継続 */ }
    return v;
  }
  async function getToken() {
    if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.idToken;
    if (!tokenPromise) tokenPromise = fetchToken().then((t) => { tokenCache = t; return t; }).finally(() => { tokenPromise = null; });
    try { return (await tokenPromise).idToken; } catch (e) { return null; } // ローカル開発（認証無効のAPI）では無しで続行
  }
  async function authFetch(url, opts) {
    opts = opts || {};
    const t = await getToken();
    opts.headers = Object.assign({}, opts.headers || {}, t ? { Authorization: 'Bearer ' + t } : {});
    const r = await fetch(url, opts);
    if (r.status === 401) { tokenCache = null; try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* 無視 */ } }
    return r;
  }

  // ---------- 対象キー（アプリの版上げ 'kana-care-state-vN' に追従し、古い版のキーは片付ける） ----------
  const POLL_MS = 2500;
  const KEY_RE = /^kana-care-state-v(\d+)$/;
  const keyVer = (k) => { const m = KEY_RE.exec(k || ''); return m ? Number(m[1]) : -1; };
  let KEY = 'kana-care-state-v8';
  function pickKey() {
    try {
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (keyVer(k) > keyVer(KEY)) KEY = k; }
    } catch (e) { /* 無視 */ }
  }
  function dropStaleKeys() {
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (keyVer(k) >= 0 && keyVer(k) < keyVer(KEY)) old.push(k); }
      old.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 無視 */ }
  }
  pickKey();
  dropStaleKeys();

  // ---------- 同期の状態 ----------
  const BASE_KEY = 'care-sync-base'; // 最後にサーバーと一致した状態（再読み込みしても手元の未送信分をマージできるよう sessionStorage に保持）
  let version = -1; // 最後に同期したサーバーのバージョン
  let base = null; // その時点の状態（添付を除いたもの）
  let baseSig = '';
  let alive = true;
  let inflight = false;
  let again = false;
  let timer = null;
  let retryMs = 0;
  let rejectedSig = ''; // サーバーが形式不正として拒否した内容（同じ内容は再送しない）

  const readRaw = () => { try { const r = localStorage.getItem(KEY); if (r) return r; return window.__careAi ? JSON.stringify(window.__careAi.snapshot()) : null; } catch (e) { return null; } };
  const readLocal = () => { const raw = readRaw(); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } };
  // 写真などの添付（base64）は同期しない（端末内のみ・サイズ上限のため）
  const strip = (obj) => { const c = JSON.parse(JSON.stringify(obj)); (c.messages || []).forEach((m) => { if (m.attachments) delete m.attachments; }); return c; };
  const sig = (obj) => canon(strip(obj));

  function setBase(ver, app) {
    version = ver; base = app ? strip(app) : null; baseSig = base ? canon(base) : '';
    try { sessionStorage.setItem(BASE_KEY, JSON.stringify({ key: KEY, version, base })); } catch (e) { /* 容量不足でもメモリで継続 */ }
  }
  (() => { try { const s = JSON.parse(sessionStorage.getItem(BASE_KEY)); if (s && s.key === KEY && s.base) { version = s.version; base = s.base; baseSig = canon(base); } } catch (e) { /* 無視 */ } })();

  const origSet = Storage.prototype.setItem;
  // マージ結果を手元に書き、アプリへ通知する（同一タブでは storage イベントが自動では発火しないため手動で通知）
  function writeLocal(next, local) {
    const att = {}; ((local && local.messages) || []).forEach((m) => { if (m.attachments) att[m.id] = m.attachments; });
    (next.messages || []).forEach((m) => { if (att[m.id]) m.attachments = att[m.id]; }); // 手元の写真は同じIDのメッセージに引き継ぐ
    const text = JSON.stringify(next);
    try { origSet.call(localStorage, KEY, text); } catch (e) { return; }
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: text }));
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(push, ms); }
  function backoff() { retryMs = Math.min(retryMs ? retryMs * 2 : 1000, 30000); schedule(retryMs); }

  // サーバーの状態 remote（バージョン ver）を取り込む。手元に未送信の変更があればマージして送り直す
  function absorb(ver, remote) {
    const local = readLocal();
    if (!remote) { setBase(ver, null); if (local) schedule(0); return; } // サーバーが空 → 手元を初期値として送る
    if (local && typeof local.v === 'number' && typeof remote.v === 'number' && local.v !== remote.v) {
      // 状態の版が違う：古い版のサーバー状態は捨てて手元（新しい版）で置き換える。手元の方が古ければ同期しない（再読み込みで新しい画面になる）
      if (local.v > remote.v) { setBase(ver, null); schedule(0); } else { alive = false; }
      return;
    }
    // 基準が無い（このタブで初めての同期）ときは、手元が前回の古い状態かもしれないのでサーバーを正とする
    const pending = !!(local && base && sig(local) !== baseSig);
    const merged = pending ? merge3(base, strip(local), remote) : remote;
    setBase(ver, remote);
    if (!local || sig(local) !== canon(merged)) writeLocal(JSON.parse(JSON.stringify(merged)), local);
    if (canon(merged) !== baseSig) schedule(0); // マージで手元の変更が残った → 送る
  }

  async function push() {
    if (!alive) return;
    if (inflight) { again = true; return; }
    if (version < 0) { schedule(POLL_MS); return; } // まだ一度も取得していない：先に pull で基準を得る
    const local = readLocal(); if (!local) return;
    const body = strip(local);
    const s = canon(body);
    if (s === baseSig || s === rejectedSig) return;
    inflight = true; again = false;
    try {
      const r = await authFetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: version, app: body }) });
      if (r.ok) { setBase((await r.json()).version, body); retryMs = 0; }
      else if (r.status === 409) { const j = await r.json(); retryMs = 0; inflight = false; absorb(j.version, (j.data || {}).app || null); return; }
      else if (r.status === 404) { alive = false; }
      else if (r.status === 413 || r.status === 422) { rejectedSig = s; console.warn('[sync] サーバーが状態を受け付けませんでした', r.status); }
      else throw new Error(String(r.status)); // 401/429/5xx 等は間隔を空けて再送
    } catch (e) {
      inflight = false; backoff(); return; // ローカルの状態は残る。再送する
    }
    inflight = false;
    const now = readLocal();
    if (again || (now && sig(now) !== baseSig && sig(now) !== rejectedSig)) schedule(0);
  }

  async function pull() {
    if (!alive || inflight) return;
    try {
      const r = await authFetch('/api/state?since=' + version, { cache: 'no-store' });
      if (r.status === 304) return;
      if (r.status === 404) { alive = false; return; }
      if (!r.ok || inflight) return; // 送信中に届いた古い応答は捨てる（送信結果側で取り込む）
      const j = await r.json();
      if (j.version === version) return;
      absorb(j.version, (j.data || {}).app || null);
    } catch (e) { /* 一時的な通信断は無視して次回ポーリング */ }
  }

  // アプリの localStorage 書き込みを検知して push（アプリ側の改修は不要）
  Storage.prototype.setItem = function (k, v) {
    origSet.apply(this, arguments);
    if (this !== window.localStorage || keyVer(k) < 0) return;
    if (keyVer(k) > keyVer(KEY)) { KEY = k; setBase(version, null); dropStaleKeys(); } // アプリの版上げに追従
    if (k === KEY) schedule(400);
  };

  fetch('/api/healthz').then((r) => (r.ok ? r.json() : Promise.reject())).then(() => {
    pull();
    setInterval(pull, POLL_MS);
  }).catch(() => { alive = false; });
})();
