/*!
 * Corvanta chat widget.
 * Embed with:
 *   <script src="https://YOUR-API/api/v1/widget/embed.js" data-key="wk_..." async></script>
 *
 * No dependencies. Rendered inside a Shadow DOM so the host page's CSS cannot break it, and all
 * visitor / AI text is inserted with textContent (never as HTML).
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key) return;
  var guard = '__corvantaWidget_' + key;
  if (window[guard]) return;
  window[guard] = true;

  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    return;
  }
  var base = origin + '/api/v1/widget/' + encodeURIComponent(key);
  var storeKey = 'corvanta_widget_' + key;
  var POLL_MS = 4000;
  var MAX_CHARS = 2000;

  var state = {
    token: readToken(),
    config: null,
    open: false,
    started: false,
    starting: false,
    messages: [],
    pending: [],
    pollTimer: null,
    sending: false,
    notice: ''
  };

  function readToken() {
    try { return window.localStorage.getItem(storeKey) || ''; } catch (e) { return ''; }
  }
  function saveToken(token) {
    state.token = token || '';
    try {
      if (token) window.localStorage.setItem(storeKey, token);
      else window.localStorage.removeItem(storeKey);
    } catch (e) { /* storage unavailable: chat still works for this page view */ }
  }

  function api(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(base + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { status: res.status, ok: res.ok, json: json };
      });
    });
  }

  // ---- DOM -------------------------------------------------------------------------------
  var host = document.createElement('div');
  host.setAttribute('data-corvanta-widget', '');
  var root = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
    '.launcher{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;background:var(--c,#4f46e5);box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;font-size:24px}',
    '.launcher:focus-visible,.close:focus-visible,.send:focus-visible,textarea:focus-visible,.retry:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}',
    '.panel{position:fixed;right:20px;bottom:90px;width:360px;max-width:calc(100vw - 24px);height:min(560px,calc(100vh - 120px));background:#fff;color:#0f172a;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}',
    '.panel.open{display:flex}',
    '.head{background:var(--c,#4f46e5);color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;font-weight:600}',
    '.close{background:transparent;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px}',
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8fafc}',
    '.msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
    '.msg.visitor{align-self:flex-end;background:var(--c,#4f46e5);color:#fff;border-bottom-right-radius:4px}',
    '.msg.assistant,.msg.team{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}',
    '.msg.pending{opacity:.65}',
    '.msg.failed{border:1px solid #dc2626}',
    '.who{display:block;font-size:11px;opacity:.7;margin-bottom:2px}',
    '.retry{margin-left:8px;background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;font-size:12px}',
    '.note{align-self:center;font-size:12px;color:#475569;text-align:center;padding:2px 8px}',
    '.typing{align-self:flex-start;font-size:13px;color:#475569}',
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;background:#fff}',
    'textarea{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font-size:14px;height:42px;max-height:96px}',
    '.send{border:0;border-radius:10px;padding:0 14px;background:var(--c,#4f46e5);color:#fff;font-weight:600;cursor:pointer}',
    '.send:disabled{opacity:.5;cursor:not-allowed}',
    '@media (max-width:480px){.panel{right:8px;bottom:84px}.launcher{right:12px;bottom:12px}}',
    '@media (prefers-reduced-motion:no-preference){.panel{transition:opacity .15s}}'
  ].join('');

  var launcher = el('button', { class: 'launcher', type: 'button', 'aria-label': 'Open chat', 'aria-expanded': 'false' });
  launcher.textContent = '\uD83D\uDCAC';

  var panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Chat' });
  var head = el('div', { class: 'head' });
  var titleEl = el('span', {});
  var closeBtn = el('button', { class: 'close', type: 'button', 'aria-label': 'Close chat' });
  closeBtn.textContent = '\u00D7';
  head.appendChild(titleEl);
  head.appendChild(closeBtn);

  var log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  var form = el('form', { class: 'form' });
  var input = el('textarea', { rows: '1', 'aria-label': 'Type your message', placeholder: 'Type your message…', maxlength: String(MAX_CHARS) });
  var sendBtn = el('button', { class: 'send', type: 'submit' });
  sendBtn.textContent = 'Send';
  form.appendChild(input);
  form.appendChild(sendBtn);

  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(form);
  root.appendChild(style);
  root.appendChild(launcher);
  root.appendChild(panel);

  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function applyConfig(config) {
    state.config = config;
    root.host.style.setProperty('--c', config.color || '#4f46e5');
    titleEl.textContent = config.title || 'Chat with us';
    panel.setAttribute('aria-label', config.title || 'Chat');
  }

  function bubble(m, extraClass) {
    var node = el('div', { class: 'msg ' + (m.role || 'assistant') + (extraClass ? ' ' + extraClass : '') });
    if (m.role === 'team' || m.role === 'assistant') {
      var who = el('span', { class: 'who' });
      who.textContent = m.role === 'team' ? 'Team member' : 'Assistant';
      node.appendChild(who);
    }
    node.appendChild(document.createTextNode(m.body));
    return node;
  }

  function render() {
    while (log.firstChild) log.removeChild(log.firstChild);
    if (state.config && state.config.welcomeMessage && state.messages.length === 0) {
      log.appendChild(bubble({ role: 'assistant', body: state.config.welcomeMessage }));
    }
    state.messages.forEach(function (m) { log.appendChild(bubble(m)); });
    state.pending.forEach(function (p) {
      var node = bubble({ role: 'visitor', body: p.body }, p.failed ? 'failed' : 'pending');
      if (p.failed) {
        var retry = el('button', { class: 'retry', type: 'button' });
        retry.textContent = 'Not sent. Retry';
        retry.addEventListener('click', function () { retryPending(p); });
        node.appendChild(retry);
      }
      log.appendChild(node);
    });
    if (state.sending) {
      var typing = el('div', { class: 'typing' });
      typing.textContent = 'Typing…';
      log.appendChild(typing);
    }
    if (state.notice) {
      var note = el('div', { class: 'note' });
      note.textContent = state.notice;
      log.appendChild(note);
    }
    log.scrollTop = log.scrollHeight;
    sendBtn.disabled = state.sending || state.starting;
  }

  function lastCreatedAt() {
    return state.messages.length ? state.messages[state.messages.length - 1].createdAt : '';
  }

  function mergeMessages(incoming) {
    var seen = {};
    state.messages.forEach(function (m) { seen[m.id] = true; });
    incoming.forEach(function (m) { if (!seen[m.id]) { state.messages.push(m); seen[m.id] = true; } });
    state.messages.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; });
  }

  // ---- Session ---------------------------------------------------------------------------
  function startSession() {
    if (state.starting) return Promise.resolve();
    state.starting = true;
    state.notice = '';
    render();
    return api('POST', '/session', {}).then(function (r) {
      state.starting = false;
      if (!r.ok) {
        if (r.status === 401) saveToken('');
        state.notice = r.status === 429 ? 'Please wait a moment and try again.' : 'Chat is not available right now.';
        render();
        return;
      }
      saveToken(r.json.data.token);
      applyConfig(r.json.data.config);
      state.started = true;
      state.messages = [];
      mergeMessages(r.json.data.messages || []);
      render();
      startPolling();
    }).catch(function () {
      state.starting = false;
      state.notice = 'Could not connect. Check your internet connection.';
      render();
    });
  }

  function poll() {
    if (!state.open || !state.started || document.hidden || state.sending) return;
    var after = lastCreatedAt();
    api('GET', '/messages' + (after ? '?after=' + encodeURIComponent(after) : ''))
      .then(function (r) {
        if (r.status === 401) { saveToken(''); state.started = false; stopPolling(); startSession(); return; }
        if (!r.ok) return;
        var incoming = (r.json.data && r.json.data.messages) || [];
        if (incoming.length) { mergeMessages(incoming); state.notice = ''; render(); }
      })
      .catch(function () { /* transient network error: next poll retries */ });
  }
  function startPolling() { stopPolling(); state.pollTimer = window.setInterval(poll, POLL_MS); }
  function stopPolling() { if (state.pollTimer) { window.clearInterval(state.pollTimer); state.pollTimer = null; } }

  // ---- Sending ---------------------------------------------------------------------------
  function send(entry) {
    state.sending = true;
    state.notice = '';
    render();
    return api('POST', '/messages', { body: entry.body }).then(function (r) {
      state.sending = false;
      if (r.status === 401) {
        saveToken('');
        state.started = false;
        entry.failed = true;
        state.notice = 'Your chat session expired. Press retry to start a new chat.';
        render();
        return;
      }
      if (!r.ok) {
        entry.failed = true;
        state.notice = r.status === 429
          ? 'You are sending messages too quickly. Please wait a moment.'
          : (r.json && r.json.message) || 'Message could not be sent.';
        render();
        return;
      }
      state.pending = state.pending.filter(function (p) { return p !== entry; });
      mergeMessages(r.json.data.messages || []);
      var status = r.json.data.replyStatus;
      if (status === 'unavailable' || status === 'busy') {
        state.notice = 'Our assistant could not reply just now. A team member will follow up.';
      } else if (status === 'waiting_for_team') {
        state.notice = 'A team member will reply here soon.';
      }
      render();
    }).catch(function () {
      state.sending = false;
      entry.failed = true;
      state.notice = 'Could not connect. Check your internet connection.';
      render();
    });
  }

  function retryPending(entry) {
    entry.failed = false;
    var ready = state.started ? Promise.resolve() : startSession();
    ready.then(function () { if (state.started) send(entry); else { entry.failed = true; render(); } });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var body = input.value.trim();
    if (!body || state.sending || state.starting) return;
    var entry = { body: body, failed: false };
    state.pending.push(entry);
    input.value = '';
    var ready = state.started ? Promise.resolve() : startSession();
    ready.then(function () { if (state.started) send(entry); else { entry.failed = true; render(); } });
    render();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });

  function setOpen(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) {
      if (!state.started) startSession().then(function () { input.focus(); });
      else { startPolling(); input.focus(); }
    } else {
      stopPolling();
      launcher.focus();
    }
  }

  launcher.addEventListener('click', function () { setOpen(!state.open); });
  closeBtn.addEventListener('click', function () { setOpen(false); });
  panel.addEventListener('keydown', function (event) { if (event.key === 'Escape') setOpen(false); });

  // ---- Boot: show the launcher only when the chat is configured and available ------------
  fetch(base + '/config').then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json }; }); })
    .then(function (r) {
      if (!r.ok || !r.json.data || !r.json.data.available) return;
      applyConfig(r.json.data);
      if (document.body) document.body.appendChild(host);
      else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });
    })
    .catch(function () { /* host site stays untouched if the API is unreachable or the origin is not allowed */ });
})();
