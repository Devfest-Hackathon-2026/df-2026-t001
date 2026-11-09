// AIアシスタント（Gemini / Vertex AI）パネル。リーダー画面・従業員画面の両方で使う。
// 安全方針: AI/サーバー由来の文字列は必ず textContent で描画する（innerHTMLに入れない）。
(function () {
  if (typeof window === 'undefined' || location.protocol === 'file:') return;

  const el = (tag, props, children) => {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); });
    (children || []).forEach((c) => n.appendChild(c));
    return n;
  };

  const css = el('style', { text: `
    .ai-fab{position:fixed;right:16px;bottom:84px;z-index:9000;border:0;border-radius:24px;padding:12px 16px;background:#1a73e8;color:#fff;font:500 14px/1 'Noto Sans JP',sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer}
    .ai-panel{position:fixed;right:16px;bottom:136px;z-index:9001;width:min(380px,calc(100vw - 32px));max-height:70vh;display:none;flex-direction:column;background:#fff;color:#202124;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.3);font:14px/1.5 'Noto Sans JP',sans-serif;overflow:hidden}
    .ai-panel.open{display:flex}
    .ai-head{padding:10px 14px;background:#1a73e8;color:#fff;font-weight:500;display:flex;justify-content:space-between;align-items:center}
    .ai-head button{background:none;border:0;color:#fff;font-size:18px;cursor:pointer}
    .ai-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid #e0e0e0}
    .ai-actions button{border:1px solid #1a73e8;background:#fff;color:#1a73e8;border-radius:14px;padding:4px 10px;font-size:12px;cursor:pointer}
    .ai-log{padding:10px 12px;overflow:auto;flex:1;min-height:120px;white-space:pre-wrap;word-break:break-word}
    .ai-msg{margin:0 0 8px}.ai-msg.me{color:#1a73e8}.ai-src{display:block;font-size:11px;color:#5f6368}
    .ai-form{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #e0e0e0}
    .ai-form input{flex:1;border:1px solid #bdc1c6;border-radius:8px;padding:8px;font-size:14px}
    .ai-form button{border:0;background:#1a73e8;color:#fff;border-radius:8px;padding:0 14px;cursor:pointer}
    .ai-note{font-size:11px;color:#5f6368;padding:0 12px 8px}` });
  document.head.appendChild(css);

  const log = el('div', { class: 'ai-log', 'aria-live': 'polite' });
  const input = el('input', { type: 'text', maxlength: '500', placeholder: '例: いま未充足の欠員は?', 'aria-label': 'AIへの質問' });
  const panel = el('div', { class: 'ai-panel', role: 'dialog', 'aria-label': 'AIアシスタント' });

  function add(text, who, src) {
    const m = el('div', { class: 'ai-msg' + (who === 'me' ? ' me' : '') }, [el('span', { text: text })]);
    if (src) m.appendChild(el('span', { class: 'ai-src', text: src }));
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  }
  const srcLabel = (d) => (d && d.source === 'gemini' ? 'Gemini（Vertex AI）による提案' : d && d.source === 'fallback' ? '代替ロジック（AI未使用）: ' + (d.fallbackReason || '') : '');

  async function call(path, body, render) {
    add('処理中…', 'ai');
    const pending = log.lastChild;
    try {
      const r = await window.CareApi.authFetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      pending.remove();
      if (!r.ok) { add(d.detail || 'うまくいきませんでした。入力は保存されています。もう一度お試しください。', 'ai'); return; }
      add(render(d), 'ai', srcLabel(d));
    } catch (e) {
      pending.remove();
      add('通信できませんでした。入力は保存されています。もう一度お試しください。', 'ai');
    }
  }

  const bridge = () => window.__careAi || null;
  const staffMap = () => { const b = bridge(); const m = {}; if (b) b.staff().slice(0, 80).forEach((x) => { m[x.id] = x.name; }); return m; };
  const nameOf = (id) => staffMap()[id] || id;

  const actions = [
    ['候補の提案', () => {
      const b = bridge(); const vs = b ? b.vacancies() : [];
      if (!vs.length) { add('いま未充足の欠員はありません。', 'ai'); return; }
      const v = vs[0]; const ctx = b.candidates(v.id);
      if (!ctx || !ctx.candidates.length) { add('条件に合う候補が見つかりませんでした。条件を見直してください。', 'ai'); return; }
      add(v.date + ' ' + v.shift + '（' + v.unit + '）の欠員について、候補を確認します。', 'ai');
      return call('/ai/explain-candidates', ctx, (d) => (d.candidates || []).map((c, i) => (i + 1) + '. ' + c.name + '（' + (c.reasons || []).slice(0, 2).join('・') + '）' + (c.aiReason ? '\n   ' + c.aiReason : '')).join('\n') + (d.overall ? '\n' + d.overall : '') + '\n※' + d.note);
    }],
    ['月次案の確認', () => {
      const b = bridge(); const p = b && b.plan();
      if (!p) { add('月次シフト案がまだありません。「シフト」→「シフト作成」で作成すると確認できます。', 'ai'); return; }
      return call('/ai/plan-review', { plan: p }, (d) => (d.summary || '') + ((d.checks || []).length ? '\n・' + d.checks.join('\n・') : '') + '\n案の確定はリーダーが行います。');
    }],
    ['体調の傾向', () => {
      const b = bridge(); const checks = b ? b.health() : [];
      if (!checks.length) { add('本日の体調チェックはまだ入力されていません。未入力は「健康」を意味しません。', 'ai'); return; }
      return call('/ai/health-insight', { checks: checks.map((c) => Object.assign({}, c, { staffId: undefined })) }, (d) => d.summary + (d.followUps && d.followUps.length ? '\n・' + d.followUps.join('\n・') : '') + '\n※' + d.disclaimer);
    }],
    ['分析インサイト', async () => {
      add('処理中…', 'ai'); const pending = log.lastChild;
      try {
        const r = await window.CareApi.authFetch('/api/analytics/summary'); const d = await r.json().catch(() => ({})); pending.remove();
        if (!r.ok) { add(d.detail || 'うまくいきませんでした。', 'ai'); return; }
        add((d.insight || '分析データがまだありません。') + '\n（イベント数: ' + ((d.stats && d.stats.events_total) || 0) + '）', 'ai', srcLabel(d));
      } catch (e) { pending.remove(); add('通信できませんでした。', 'ai'); }
    }],
  ];

  const bar = el('div', { class: 'ai-actions' }, actions.map(([label, fn]) => { const b = el('button', { type: 'button', text: label }); b.addEventListener('click', fn); return b; }));
  const form = el('form', { class: 'ai-form' }, [input, el('button', { type: 'submit', text: '送信' })]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim(); if (!q) return;
    input.value = ''; add(q, 'me');
    call('/ai/chat', { message: q.slice(0, 500), staff: staffMap() }, (d) => d.reply || '');
  });
  const close = el('button', { type: 'button', 'aria-label': '閉じる', text: '×' });
  panel.append(el('div', { class: 'ai-head' }, [el('span', { text: 'AIアシスタント' }), close]), bar, log, form,
    el('div', { class: 'ai-note', text: 'AIは提案のみです。診断や就業可否の判断はしません。個人情報は入力しないでください（デモ用の架空データです）。' }));
  const fab = el('button', { class: 'ai-fab', type: 'button', text: 'AI', 'aria-label': 'AIアシスタントを開く' });
  const toggle = () => panel.classList.toggle('open');
  fab.addEventListener('click', toggle); close.addEventListener('click', toggle);

  const start = () => {
    if (!window.CareApi) return;
    fetch('/api/healthz').then((r) => (r.ok ? r.json() : Promise.reject())).then((h) => {
      if (!h.ai) return;
      document.body.append(fab, panel);
      add('欠員・申請・体調チェックの状況について質問できます（Gemini）。', 'ai');
    }).catch(() => {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
