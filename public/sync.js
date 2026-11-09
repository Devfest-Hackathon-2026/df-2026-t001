// care-api との状態同期（リーダー画面 ⇔ 従業員画面で同じ状態を共有）。対象: localStorage 'kana-care-state-v7'。
// /api が存在しない環境（Cloudflareの静的配信・ローカルの file://）では何もしない＝従来どおり localStorage のみで動く。
(function () {
  if (typeof window === 'undefined' || location.protocol === 'file:') return;
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
      if (r.ok) { const j = await r.json(); return store({ idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: j.expires_in }); }
    }
    r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + WEB_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error('auth');
    const j = await r.json();
    return store({ idToken: j.idToken, refreshToken: j.refreshToken, expiresIn: j.expiresIn });
  }
  function store(t) {
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
    return fetch(url, opts);
  }

  const POLL_MS = 2500;
  const KEY = 'kana-care-state-v7';
  let version = -1;
  let lastSent = '';
  let alive = true;
  let timer = null;

  const readRaw = () => { try { const r = localStorage.getItem(KEY); if (r) return r; return window.__careAi ? JSON.stringify(window.__careAi.snapshot()) : null; } catch (e) { return null; } };
  // 写真などの添付（base64）は同期しない（端末内のみ・サイズ上限のため）
  const strip = (obj) => { const c = JSON.parse(JSON.stringify(obj)); (c.messages || []).forEach((m) => { if (m.attachments) delete m.attachments; }); return c; };
  const sig = (obj) => JSON.stringify(strip(obj));

  async function push() {
    if (!alive) return;
    const raw = readRaw(); if (!raw) return;
    let cur; try { cur = JSON.parse(raw); } catch (e) { return; }
    const s = sig(cur);
    if (s === lastSent) return;
    try {
      const r = await authFetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { app: strip(cur) } }) });
      if (!r.ok) throw new Error(r.status);
      version = (await r.json()).version;
      lastSent = s;
    } catch (e) { /* ローカルの状態は残る。次の変更時に再送する */ }
  }

  async function pull() {
    if (!alive) return;
    try {
      const r = await authFetch('/api/state?since=' + version, { cache: 'no-store' });
      if (r.status === 304) return;
      if (r.status === 404) { alive = false; return; }
      if (!r.ok) return;
      const j = await r.json();
      version = j.version;
      const remote = (j.data || {}).app;
      if (!remote) { await push(); return; } // サーバーが空なら現在のローカル状態を初期値として送る
      const raw = readRaw();
      let local = null; try { local = raw ? JSON.parse(raw) : null; } catch (e) { /* 破損は上書き */ }
      if (local && sig(local) === sig(remote)) { lastSent = sig(remote); return; }
      // ローカルの添付（写真）は、同じIDのメッセージに引き継ぐ
      const att = {}; ((local && local.messages) || []).forEach((m) => { if (m.attachments) att[m.id] = m.attachments; });
      (remote.messages || []).forEach((m) => { if (att[m.id]) m.attachments = att[m.id]; });
      lastSent = sig(remote);
      const text = JSON.stringify(remote);
      localStorage.setItem(KEY, text);
      // アプリの既存の storage リスナーが再描画する（同一タブでは自動では発火しないため手動で通知）
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: text }));
    } catch (e) { /* 一時的な通信断は無視して次回ポーリング */ }
  }

  // アプリの localStorage 書き込みを検知して push（アプリ側の改修は不要）
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    origSet.apply(this, arguments);
    if (this === window.localStorage && k === KEY) { clearTimeout(timer); timer = setTimeout(push, 400); }
  };

  window.CareApi = { authFetch };

  fetch('/api/healthz').then((r) => (r.ok ? r.json() : Promise.reject())).then(() => {
    pull();
    setInterval(pull, POLL_MS);
  }).catch(() => { alive = false; });
})();
