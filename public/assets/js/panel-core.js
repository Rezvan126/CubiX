/* CubiX portal core, shared by /team and /app. */
(function () {
  const CX = window.CX = {};
  const BRAND = '<img src="/assets/brand/logo.svg" alt="CubiX" width="105" height="38">', BRAND_DARK = '<img src="/assets/brand/logo-on-dark.svg" alt="CubiX" width="105" height="38">';
  CX.brand = (label, href = '../index.html', dark) => `<a class="brand" href="${href}">${dark ? BRAND_DARK : BRAND}${label ? `<small>${label}</small>` : ''}</a>`;
  CX.icon = (id, cls = '') => `<svg class="icon ${cls}"><use href="#i-${id}"/></svg>`;
  CX.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  CX.$ = (s, r = document) => r.querySelector(s);
  CX.$$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------------------------------------------------------------- API
  class ApiError extends Error { constructor(status, data) { super((data && data.message) || 'Something went wrong.'); this.status = status; this.data = data; } }
  CX.ApiError = ApiError;
  CX.onUnauthorized = () => {};
  CX.api = async function (method, path, body) {
    const opt = { method, headers: { 'x-cubix': '1' }, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch('/api' + path, opt); }
    catch { throw new ApiError(0, { message: 'You seem to be offline. Check your connection and try again.' }); }
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (r.status === 401 && !path.startsWith('/auth/')) { CX.onUnauthorized(); }
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
  };
  CX.get = p => CX.api('GET', p);
  CX.post = (p, b) => CX.api('POST', p, b);
  CX.patch = (p, b) => CX.api('PATCH', p, b);
  // multipart upload with progress
  CX.upload = (path, form, onProgress) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api' + path); x.setRequestHeader('x-cubix', '1');
    x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(d) : reject(new ApiError(x.status, d)); };
    x.onerror = () => reject(new ApiError(0, { message: 'Upload failed. Check your connection and try again.' }));
    x.send(form);
  });

  // ---------------------------------------------------------------- formatting
  CX.STATUS = {
    new: 'New', confirmed: 'Confirmed', modeling: 'Modeling', preview: 'Preview sent', revisions: 'Revisions',
    approved: 'Approved', delivered: 'Delivered', paid: 'Paid', cancelled: 'Cancelled',
  };
  CX.CLIENT_STATUS = {
    new: 'Received', confirmed: 'In the queue', modeling: 'Being modeled', preview: 'Preview ready', revisions: 'Changes in progress',
    approved: 'Approved, preparing files', delivered: 'Files ready', paid: 'Complete', cancelled: 'Cancelled',
  };
  CX.PLANS = { pay_per_model: 'Pay per model', starter: 'Starter', growth: 'Growth', studio: 'Studio' };
  CX.pill = (s, labels = CX.STATUS) => `<span class="pill st-${s}">${labels[s] || s}</span>`;
  CX.initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  CX.avatar = (n, cls = '') => n ? `<span class="avatar ${cls}" title="${CX.esc(n)}">${CX.esc(CX.initials(n))}</span>` : `<span class="avatar none ${cls}" title="Unassigned">${CX.icon('plus')}</span>`;
  CX.money = v => v === null || v === undefined || v === '' ? '' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  CX.size = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  CX.date = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  CX.dateTime = iso => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  CX.ago = iso => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return CX.date(iso);
  };
  const hrs = ms => { const h = Math.abs(ms) / 3600e3; return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + ' days'; };
  CX.due = (o) => {
    if (!o.due_at || ['delivered', 'paid', 'cancelled', 'approved'].includes(o.status)) return '';
    const ms = new Date(o.due_at) - Date.now();
    if (ms < 0) return `<span class="due late">${CX.icon('alert')} ${hrs(ms)} late</span>`.replace('class="icon "', 'class="icon" style="width:13px;height:13px;display:inline;vertical-align:-2px"');
    return `<span class="due ${ms < 6 * 3600e3 ? 'soon' : ''}">Due in ${hrs(ms)}</span>`;
  };
  CX.isLate = o => o.due_at && !['delivered', 'paid', 'cancelled', 'approved'].includes(o.status) && new Date(o.due_at) < Date.now();
  CX.fileUrl = (id, inline) => `/api/files/${id}${inline ? '?inline=1' : ''}`;
  CX.ext = n => (String(n).split('.').pop() || '').slice(0, 4).toUpperCase();
  CX.isImg = f => /^image\//.test(f.type || '');

  // ---------------------------------------------------------------- toasts, modals
  let toasts;
  CX.toast = (text, err) => {
    if (!toasts) { toasts = document.createElement('div'); toasts.className = 'toasts'; toasts.setAttribute('role', 'status'); toasts.setAttribute('aria-live', 'polite'); document.body.appendChild(toasts); }
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : '');
    t.innerHTML = CX.icon(err ? 'alert' : 'check') + `<span>${CX.esc(text)}</span>`;
    while (toasts.children.length >= 2) toasts.firstElementChild.remove();
    t.addEventListener('click', () => t.remove());
    toasts.appendChild(t); setTimeout(() => t.remove(), err ? 5200 : 3200);
  };
  CX.fail = e => CX.toast(e && e.message ? e.message : 'Something went wrong.', true);
  CX.modal = (html, onMount) => {
    const m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = `<div class="modal-box">${html}</div>`;
    const prev = document.activeElement;
    const close = () => { m.remove(); document.removeEventListener('keydown', esc); prev && prev.focus && prev.focus(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(m);
    const f = m.querySelector('input,textarea,select,button.btn-primary'); f && f.focus();
    onMount && onMount(m.querySelector('.modal-box'), close);
    return close;
  };
  CX.confirm = (title, text, okLabel = 'Confirm') => new Promise(res => {
    let done = false;
    const close = CX.modal(`<h2>${CX.esc(title)}</h2><p class="muted">${CX.esc(text)}</p><div class="modal-actions"><button class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" data-ok>${CX.esc(okLabel)}</button></div>`,
      (box, c) => box.querySelector('[data-ok]').addEventListener('click', () => { done = true; c(); res(true); }));
    const obs = new MutationObserver(() => { if (!document.body.contains(document.querySelector('.modal'))) { obs.disconnect(); if (!done) res(false); } });
    obs.observe(document.body, { childList: true });
  });
  CX.linkModal = (title, text, link) => CX.modal(`<h2>${CX.esc(title)}</h2><p class="muted">${CX.esc(text)}</p>
      <div class="copybox"><span class="grow">${CX.esc(link)}</span><button class="btn btn-dark btn-sm" data-copy>${CX.icon('copy')} Copy</button></div>
      <div class="modal-actions"><button class="btn btn-line" data-close>Done</button></div>`, box => {
    box.querySelector('[data-copy]').addEventListener('click', async e => {
      try { await navigator.clipboard.writeText(link); e.currentTarget.innerHTML = CX.icon('check') + ' Copied'; } catch { CX.toast('Select the link and copy it manually.', true); }
    });
  });

  // ---------------------------------------------------------------- forms
  CX.busy = (btn, on, label) => {
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = label || 'Please wait'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  };
  CX.formData = form => Object.fromEntries(new FormData(form).entries());

  // File picker with drag and drop, previews and removal. Returns { files() , clear() }.
  CX.dropzone = (el, { accept = '', hint = 'Photos, sketches, PDFs or STL files up to 25 MB each' } = {}) => {
    let list = [];
    el.innerHTML = `<label class="drop">${CX.icon('upload')}<b>Drop files here or click to choose</b><span class="small muted">${hint}</span><input type="file" multiple ${accept ? `accept="${accept}"` : ''}></label><div class="filelist"></div>`;
    const drop = el.querySelector('.drop'), input = el.querySelector('input'), out = el.querySelector('.filelist');
    const render = () => {
      out.innerHTML = list.map((f, i) => `<div>${/^image\//.test(f.type) ? `<img alt="" data-i="${i}">` : `<span class="thumb ph" style="width:36px;height:36px;font-size:10px;font-weight:700">${CX.esc(CX.ext(f.name))}</span>`}
        <span class="grow ellipsis">${CX.esc(f.name)}</span><span class="small muted">${CX.size(f.size)}</span>
        <button type="button" class="icon-btn x" data-rm="${i}" aria-label="Remove ${CX.esc(f.name)}">${CX.icon('x')}</button></div>`).join('');
      out.querySelectorAll('img[data-i]').forEach(img => { const u = URL.createObjectURL(list[img.dataset.i]); img.src = u; img.onload = () => URL.revokeObjectURL(u); });
    };
    const add = fs => {
      for (const f of fs) {
        if (f.size > 25 * 1024 * 1024) { CX.toast(`${f.name} is over 25 MB. Email it to us or share a link in the notes.`, true); continue; }
        if (list.length >= 20) { CX.toast('Up to 20 files per upload.', true); break; }
        list.push(f);
      }
      render();
    };
    input.addEventListener('change', () => { add(input.files); input.value = ''; });
    out.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { list.splice(+b.dataset.rm, 1); render(); } });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => add(e.dataTransfer.files));
    return { files: () => list.slice(), clear: () => { list = []; render(); } };
  };

  // ---------------------------------------------------------------- auth screens
  CX.authShell = (side, inner) => `<div class="auth"><aside class="auth-side">${side}</aside><main class="auth-main"><div class="auth-card">${inner}</div></main></div>`;
  CX.passwordField = (name = 'password', label = 'Password', auto = 'current-password') =>
    `<label class="field"><span>${label}</span><div style="position:relative"><input class="input" type="password" name="${name}" required minlength="8" autocomplete="${auto}" style="padding-right:48px">
     <button type="button" class="icon-btn" data-peek aria-label="Show password" style="position:absolute;right:2px;top:2px">${CX.icon('eye')}</button></div></label>`;
  CX.wirePeek = root => root.querySelectorAll('[data-peek]').forEach(b => b.addEventListener('click', () => {
    const i = b.parentElement.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password';
    b.setAttribute('aria-label', i.type === 'password' ? 'Show password' : 'Hide password');
  }));
  CX.submit = (form, fn) => form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]'), msg = form.querySelector('.form-msg');
    if (msg) { msg.textContent = ''; msg.className = 'form-msg'; }
    CX.busy(btn, true);
    try { await fn(CX.formData(form), msg); }
    catch (err) { if (msg) { msg.textContent = err.message; msg.className = 'form-msg err'; } else CX.fail(err); }
    finally { if (document.body.contains(btn)) CX.busy(btn, false); }
  });

  // tiny hash router: '#/a/b?x=1' -> { parts: ['a','b'], q: URLSearchParams }
  CX.route = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, qs] = h.split('?');
    return { parts: p ? p.split('/').filter(Boolean).map(decodeURIComponent) : [], q: new URLSearchParams(qs || '') };
  };
  CX.go = h => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; };
})();
