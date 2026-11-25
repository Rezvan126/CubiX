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
  // Database bookmark: lets reads come from the nearest copy while always including this browser's own latest changes.
  const BM = 'cx_bm';
  const getBm = () => { try { return localStorage.getItem(BM) || ''; } catch { return ''; } };
  const setBm = v => { try { if (v) localStorage.setItem(BM, v); } catch {} };
  CX.api = async function (method, path, body) {
    const opt = { method, headers: { 'x-cubix': '1' }, credentials: 'same-origin' };
    const bm = getBm(); if (bm) opt.headers['x-d1-bookmark'] = bm;
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch('/api' + path, opt); }
    catch { throw new ApiError(0, { message: 'You seem to be offline. Check your connection and try again.' }); }
    setBm(r.headers.get('x-d1-bookmark'));
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
    const bm = getBm(); if (bm) x.setRequestHeader('x-d1-bookmark', bm);
    x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => { setBm(x.getResponseHeader('x-d1-bookmark')); let d = null; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(d) : reject(new ApiError(x.status, d)); };
    x.onerror = () => reject(new ApiError(0, { message: 'Upload failed. Check your connection and try again.' }));
    x.send(form);
  });

  // ---------------------------------------------------------------- formatting
  CX.STATUS = {
    new: 'New', confirmed: 'Confirmed', modeling: 'Modeling', waiting: 'Waiting on client', review: 'In review', preview: 'Preview sent', revisions: 'Revisions',
    approved: 'Approved', delivered: 'Delivered', paid: 'Paid', cancelled: 'Cancelled',
  };
  CX.CLIENT_STATUS = {
    new: 'Received', confirmed: 'In the queue', modeling: 'Being modeled', waiting: 'Waiting for you', review: 'Being modeled', preview: 'Preview ready', revisions: 'Changes in progress',
    approved: 'Approved, preparing files', delivered: 'Files ready', paid: 'Complete', cancelled: 'Cancelled',
  };
  CX.PLANS = { pay_per_model: 'Pay per model', starter: 'Starter', growth: 'Growth', studio: 'Studio' };
  CX.pill = (s, labels = CX.STATUS) => `<span class="pill st-${s}">${labels[s] || s}</span>`;
  CX.initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  CX.avatar = (n, cls = '') => n ? `<span class="avatar ${cls}" title="${CX.esc(n)}">${CX.esc(CX.initials(n))}</span>` : `<span class="avatar none ${cls}" title="Unassigned">${CX.icon('plus')}</span>`;
  CX.money = v => v === null || v === undefined || v === '' ? '' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  CX.amount = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  CX.thumbUrl = id => `/api/files/${id}/thumb`;
  // Small webp previews made in the browser, uploaded next to each image so lists load fast.
  CX.makeThumbs = async (files, max = 480) => {
    const out = [];
    for (const f of files) {
      if (!/^image\/(jpeg|png|webp|gif|bmp)/.test(f.type) || f.size > 30 * 1024 * 1024) continue;
      try {
        const bmp = await createImageBitmap(f);
        const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
        const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
        if (blob && blob.size < 300 * 1024) out.push(new File([blob], f.name, { type: 'image/webp' }));
      } catch {}
    }
    return out;
  };
  CX.addThumbs = async (fd, files) => { for (const t of await CX.makeThumbs(files)) fd.append('thumbs', t, t.name); };
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


  // iPhone photos (HEIC) do not display in most browsers. Convert them to JPEG before upload.
  // Safari decodes HEIC itself; elsewhere a converter (1.3 MB) is loaded only when a HEIC file is picked.
  const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
  let heicLib;
  const loadHeic = () => heicLib || (heicLib = new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = '/assets/vendor/heic2any.min.js'; sc.onload = () => ok(window.heic2any); sc.onerror = () => { heicLib = null; no(new Error('converter')); }; document.head.appendChild(sc); }));
  async function toJpeg(f) {
    const name = f.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
    try {
      const bmp = await createImageBitmap(f);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      if (blob) return new File([blob], name, { type: 'image/jpeg' });
    } catch {}
    const lib = await loadHeic();
    let out = await lib({ blob: f, toType: 'image/jpeg', quality: 0.9 });
    if (Array.isArray(out)) out = out[0];
    return new File([out], name, { type: 'image/jpeg' });
  }
  async function convertHeic(list, onStart) {
    const files = [...list];
    if (!files.some(isHeic)) return files;
    onStart && onStart();
    const out = [];
    for (const f of files) {
      if (!isHeic(f)) { out.push(f); continue; }
      try { out.push(await toJpeg(f)); } catch { out.push(f); } // keep the original if conversion fails, the team can still download it
    }
    return out;
  }
  CX.convertHeic = convertHeic;

  // ---------------------------------------------------------------- downloads in pieces
  // Large files come down in ranges of about 9 MB (3 at a time) and are joined in the browser,
  // because one long response is cut off on the free plan. Returns { blob, name }.
  CX.fetchFile = async (id, onProgress) => {
    const get = async (a, b) => {
      for (let attempt = 1; ; attempt++) {
        let r; try { r = await fetch(`/api/files/${id}`, { headers: { range: `bytes=${a}-${b}` }, credentials: 'same-origin' }); } catch { r = null; }
        if (r && (r.status === 206 || r.status === 200)) return r;
        if (r && r.status < 500 && r.status !== 429) throw new ApiError(r.status, { message: r.status === 404 ? 'File not found.' : 'Could not download the file.' });
        if (attempt >= 3) throw new ApiError(0, { message: 'Download interrupted. Try again.' });
        await new Promise(res => setTimeout(res, 800 * attempt));
      }
    };
    const first = await get(0, '');
    const name = ((first.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'file';
    const cr = /\/(\d+)$/.exec(first.headers.get('content-range') || '');
    const head = await first.blob();
    const total = cr ? Number(cr[1]) : head.size;
    if (head.size >= total) { onProgress && onProgress(1); return { blob: head, name }; }
    const step = head.size, ranges = [];
    for (let a = head.size; a < total; a += step) ranges.push([a, Math.min(total, a + step) - 1]);
    const parts = new Array(ranges.length); let next = 0, got = head.size;
    const worker = async () => { while (next < ranges.length) { const i = next++; const r = await get(...ranges[i]); parts[i] = await r.blob(); got += parts[i].size; onProgress && onProgress(got / total); } };
    await Promise.all([worker(), worker(), worker()]);
    const blob = new Blob([head, ...parts], { type: head.type });
    if (blob.size !== total) throw new ApiError(0, { message: 'The download was incomplete. Try again.' });
    return { blob, name };
  };
  // Every download link to /api/files/<id> goes through fetchFile, so big files always arrive whole.
  document.addEventListener('click', async e => {
    const a = e.target.closest('a[href^="/api/files/"]');
    if (!a || a.target === '_blank' || /[?&]inline=1/.test(a.getAttribute('href')) || e.metaKey || e.ctrlKey) return;
    const id = a.getAttribute('href').split('/')[3].split('?')[0];
    e.preventDefault();
    if (a.dataset.busy) return; a.dataset.busy = '1';
    try {
      const { blob, name } = await CX.fetchFile(id);
      const url = URL.createObjectURL(blob), dl = document.createElement('a');
      dl.href = url; dl.download = name; document.body.appendChild(dl); dl.click(); dl.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { CX.fail(err); } finally { delete a.dataset.busy; }
  });

  // ---------------------------------------------------------------- chunked uploads
  // Sends every file in 1.5 MB parts (3 at a time, each retried), so files up to 100 MB work on the free plan.
  // onProgress(0..1) covers all files together. Returns the upload ids to send with the order, message or hand in.
  CX.uploadFiles = async (files, onProgress) => {
    const list = [...files]; if (!list.length) return [];
    const total = list.reduce((a, f) => a + f.size, 0) || 1; let done = 0;
    const tick = n => { done += n; onProgress && onProgress(Math.min(1, done / total)); };
    const ids = [];
    const thumbs = await CX.makeThumbs(list);
    for (const f of list) {
      if (f.size > 100 * 1024 * 1024) throw new ApiError(413, { message: `${f.name} is over 100 MB. Share a download link in the notes instead.` });
      const up = await CX.post('/uploads', { name: f.name, size: f.size, type: f.type || '' });
      const t = thumbs.find(x => x.name === f.name);
      if (t) await CX.putRaw(`/uploads/${up.id}/thumb`, t).catch(() => {});
      let next = 0;
      const worker = async () => {
        while (next < up.parts) {
          const n = next++, blob = f.slice(n * up.part_size, Math.min(f.size, (n + 1) * up.part_size));
          for (let attempt = 1; ; attempt++) {
            try { await CX.putRaw(`/uploads/${up.id}/${n}`, blob); break; }
            catch (e) { if (attempt >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e; await new Promise(r => setTimeout(r, 800 * attempt)); }
          }
          tick(blob.size);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await CX.post(`/uploads/${up.id}/finish`);
      ids.push(up.id);
    }
    return ids;
  };
  CX.putRaw = async (path, blob) => {
    const headers = { 'x-cubix': '1', 'content-type': 'application/octet-stream' };
    const bm = getBm(); if (bm) headers['x-d1-bookmark'] = bm;
    let r; try { r = await fetch('/api' + path, { method: 'PUT', headers, body: blob, credentials: 'same-origin' }); }
    catch { throw new ApiError(0, { message: 'Upload interrupted. Check your connection and try again.' }); }
    setBm(r.headers.get('x-d1-bookmark'));
    if (!r.ok) { let d = null; try { d = await r.json(); } catch {} throw new ApiError(r.status, d); }
  };

  // File picker with drag and drop, previews and removal. Returns { files() , clear() }.
  CX.dropzone = (el, { accept = '', hint = 'Photos (iPhone too), screenshots, PDFs, sketches or 3D files, up to 100 MB each' } = {}) => {
    let list = [];
    el.innerHTML = `<label class="drop">${CX.icon('upload')}<b>Drop files here or click to choose</b><span class="small muted">${hint}</span><input type="file" multiple ${accept ? `accept="${accept}"` : ''}></label><div class="filelist"></div>`;
    const drop = el.querySelector('.drop'), input = el.querySelector('input'), out = el.querySelector('.filelist');
    const render = () => {
      out.innerHTML = list.map((f, i) => `<div>${/^image\//.test(f.type) ? `<img alt="" data-i="${i}">` : `<span class="thumb ph" style="width:36px;height:36px;font-size:10px;font-weight:700">${CX.esc(CX.ext(f.name))}</span>`}
        <span class="grow ellipsis">${CX.esc(f.name)}</span><span class="small muted">${CX.size(f.size)}</span>
        <button type="button" class="icon-btn x" data-rm="${i}" aria-label="Remove ${CX.esc(f.name)}">${CX.icon('x')}</button></div>`).join('');
      out.querySelectorAll('img[data-i]').forEach(img => { const u = URL.createObjectURL(list[img.dataset.i]); img.src = u; img.onload = () => URL.revokeObjectURL(u); });
    };
    const add = async picked => {
      const fs = await convertHeic(picked, () => CX.toast('Converting iPhone photos, one moment'));
      for (const f of fs) {
        if (f.size > 100 * 1024 * 1024) { CX.toast(`${f.name} is over 100 MB. Share a download link in the notes instead.`, true); continue; }
        if (list.length >= 20) { CX.toast('Up to 20 files per upload.', true); break; }
        list.push(f);
      }
      render();
    };
    input.addEventListener('change', async () => { const picked = [...input.files]; input.value = ''; await add(picked); });
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

  CX.changePassword = () => CX.modal(`<h2>Change password</h2><p class="muted small">You stay signed in here. Other devices are signed out.</p>
    <form id="cpf" style="display:grid;gap:14px" novalidate>${CX.passwordField('current', 'Current password', 'current-password')}${CX.passwordField('password', 'New password', 'new-password')}${CX.passwordField('confirm', 'Repeat new password', 'new-password')}
    <p class="form-msg" role="alert"></p><div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save password</button></div></form>`, (box, close) => {
    CX.wirePeek(box);
    CX.submit(CX.$('#cpf', box), async d => {
      if (d.password !== d.confirm) throw new Error('The two new passwords do not match.');
      await CX.post('/auth/password', { current: d.current, password: d.password }); close(); CX.toast('Password changed');
    });
  });

  // ---------------------------------------------------------------- 3D viewer (loaded only when needed)
  CX.isModel = name => /\.(stl|obj|3mf|glb|gltf)$/i.test(String(name || ''));
  CX.loadViewer = () => CX._v3d || (CX._v3d = import((document.getElementById('v3d') || {}).href || '/assets/js/viewer3d.js'));
  // Statuses the team adds on top of the client ones
  // Ship by risk: the shop's Etsy ship date is close to, or before, our delivery.
  CX.shipRisk = o => !!(o.ship_by && !['delivered', 'paid', 'cancelled'].includes(o.status) && (new Date(o.ship_by) - new Date(o.due_at) < 2 * 864e5 || new Date(o.ship_by) - Date.now() < 2 * 864e5));
  // Live countdowns: any element with data-until="<iso>" shows the time left, refreshed every second.
  CX.left = iso => { const ms = new Date(iso) - Date.now(), a = Math.abs(ms), d = Math.floor(a / 864e5), h = Math.floor(a % 864e5 / 36e5), m = Math.floor(a % 36e5 / 6e4), s = Math.floor(a % 6e4 / 1e3);
    const t = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s}s`; return { late: ms < 0, text: t }; };
  setInterval(() => { document.querySelectorAll('[data-until]').forEach(el => { const r = CX.left(el.dataset.until); el.textContent = (r.late ? `${el.dataset.late || 'Late by'} ` : `${el.dataset.pre || ''}`) + r.text; el.classList.toggle('late', r.late); }); }, 1000);
  CX.countdown = (iso, pre = 'Hand in in ', lateText = 'Past due by') => { const r = CX.left(iso); return `<span class="due ${r.late ? 'late' : (new Date(iso) - Date.now() < 6 * 36e5 ? 'soon' : '')}" data-until="${iso}" data-pre="${pre}" data-late="${lateText}">${r.late ? lateText + ' ' : pre}${r.text}</span>`; };

  // A model in its own window.
  CX.open3d = (id, name) => {
    let viewer;
    CX.modal(`<div class="row" style="justify-content:space-between"><h2 class="ellipsis">${CX.esc(name)}</h2><button class="icon-btn" data-close aria-label="Close">${CX.icon('x')}</button></div><div id="m3d"></div>
      <div class="modal-actions"><a class="btn btn-line" href="${CX.fileUrl(id)}">${CX.icon('download')} Download</a></div>`, box => {
      box.classList.add('wide');
      CX.loadViewer().then(m => { viewer = m.mount(CX.$('#m3d', box), { files: [{ url: CX.fileUrl(id), name, load: () => CX.fetchFile(id).then(x => x.blob.arrayBuffer()) }] }); })
        .catch(() => { CX.$('#m3d', box).innerHTML = '<p class="small muted">The 3D viewer could not load. Download the file instead.</p>'; });
      const obs = new MutationObserver(() => { if (!document.body.contains(box)) { obs.disconnect(); viewer && viewer.destroy(); } });
      obs.observe(document.body, { childList: true });
    });
  };

  // ---------------------------------------------------------------- model review: 3D viewer + comment threads
  // CX.review(el, { order, files, role: 'client' | 'team', canComment, load }) ; load() returns the fresh order.
  CX.review = (el, { order, files, role, canComment, load }) => {
    const esc = CX.esc, icon = CX.icon;
    let o = order, viewer = null, pick = null, showResolved = false, active = null;
    el.classList.add('rv-wrap');
    el.innerHTML = `<div class="review"><div><div class="rv3d"><div class="v3d-stage"><div class="v3d-msg">Loading 3D model</div></div></div></div><div class="threads-wrap"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b class="small rv-count"></b><label class="check small"><input type="checkbox" class="rv-res"> Show resolved</label></div><div class="newpin-slot"></div><div class="threads"></div></div></div>`;
    const list = el.querySelector('.threads'), slot = el.querySelector('.newpin-slot');
    const mine = r => (role === 'team') === (r.author_role !== 'client');
    const draw = () => {
      const pins = o.pins || [], open = pins.filter(p => p.status === 'open'), res = pins.filter(p => p.status === 'resolved');
      el.querySelector('.rv-count').textContent = pins.length ? `${open.length} open, ${res.length} resolved` : (canComment ? 'No comments yet. Click the model to add one.' : 'No comments yet.');
      const shown = showResolved ? pins : open;
      list.innerHTML = shown.length ? shown.map(p => `<div class="thread-pin ${p.status === 'resolved' ? 'res' : ''} ${active === p.n ? 'active' : ''}" data-pin="${p.n}" data-id="${p.id}">
        <div class="hd"><button type="button" class="pn" data-focus="${p.n}" aria-label="Show comment ${p.n} on the model">${p.n}</button><div class="grow"><div class="who">${esc(p.author || '')}${p.author_role === 'client' ? '' : ', CubiX'} · round ${p.round}${p.part ? ` · ${esc(p.part.replace(/\.[^.]+$/, ''))}` : ''} · ${CX.ago(p.created_at)}</div></div>
          ${p.status === 'open' ? (role === 'team' ? `<button type="button" class="btn btn-line btn-sm" data-resolve="${p.id}">${icon('check')} Resolved</button>` : '') : `<button type="button" class="link small" data-reopen="${p.id}">Reopen</button>`}</div>
        <div class="txt">${esc(p.body)}</div>
        ${(p.replies || []).map(r => `<div class="rep ${r.author_role === 'client' ? '' : 'team'}"><b class="small">${esc(r.author || '')}${r.author_role === 'client' ? '' : ', CubiX'}</b> <span class="small muted">${CX.ago(r.created_at)}</span><br>${esc(r.body)}</div>`).join('')}
        <form data-reply="${p.id}"><input class="input input-sm" name="body" placeholder="Reply" maxlength="2000" aria-label="Reply to comment ${p.n}"><button class="btn btn-dark btn-sm" type="submit">Send</button></form></div>`).join('')
        : (pins.length ? '<p class="small muted">All comments are resolved. Tick "Show resolved" to see them.</p>' : '');
      if (viewer) viewer.setPins(showResolved ? pins : open);
    };
    const refresh = async () => { o = await load(); draw(); };
    const newPin = p => {
      pick = p;
      slot.innerHTML = `<form class="newpin"><b class="small">New comment${p.part ? ` on ${esc(p.part.replace(/\.[^.]+$/, ''))}` : ''}</b><textarea class="input" name="body" required maxlength="2000" placeholder="What should change at this spot?" style="min-height:70px"></textarea>
        <div class="row"><button class="btn btn-primary btn-sm" type="submit">Save comment</button><button type="button" class="btn btn-ghost btn-sm" data-cancel>Cancel</button></div><p class="form-msg" role="alert"></p></form>`;
      const f = slot.querySelector('form'); f.body.focus();
      f.querySelector('[data-cancel]').addEventListener('click', () => { slot.innerHTML = ''; pick = null; viewer && viewer.clearTemp(); });
      CX.submit(f, async d => {
        if (!d.body.trim()) throw new Error('Write the comment first.');
        const path = role === 'team' ? `/team/orders/${o.id}/pins` : `/client/orders/${o.id}/pins`;
        const lastModel = files.find(x => x.name === pick.part) || files[0];
        const r = await CX.post(path, { body: d.body, pos: pick.pos, part: pick.part, model_file: lastModel && lastModel.id });
        slot.innerHTML = ''; pick = null; viewer && viewer.clearTemp(); active = r.n; CX.toast(`Comment ${r.n} saved`); await refresh();
      });
    };
    el.querySelector('.rv-res').addEventListener('change', e => { showResolved = e.target.checked; draw(); });
    list.addEventListener('click', async e => {
      const fb = e.target.closest('[data-focus]'); if (fb) { active = +fb.dataset.focus; viewer && viewer.focusPin(active); list.querySelectorAll('.thread-pin').forEach(t => t.classList.toggle('active', +t.dataset.pin === active)); }
      const rs = e.target.closest('[data-resolve],[data-reopen]');
      if (rs) { try { await CX.post(`/pins/${rs.dataset.resolve || rs.dataset.reopen}/resolve`, { resolved: !!rs.dataset.resolve }); await refresh(); } catch (err) { CX.fail(err); } }
    });
    list.addEventListener('submit', async e => {
      const f = e.target.closest('[data-reply]'); if (!f) return; e.preventDefault();
      const body = f.body.value.trim(); if (!body) return;
      f.querySelector('button').disabled = true;
      try { await CX.post(`/pins/${f.dataset.reply}/replies`, { body }); await refresh(); } catch (err) { CX.fail(err); f.querySelector('button').disabled = false; }
    });
    CX.loadViewer().then(m => {
      viewer = m.mount(el.querySelector('.rv3d'), { files: files.map(f => ({ url: CX.fileUrl(f.id), name: f.name, load: () => CX.fetchFile(f.id).then(x => x.blob.arrayBuffer()) })), pins: (o.pins || []).filter(p => p.status === 'open'), comment: canComment,
        onPick: canComment ? newPin : null,
        onPinClick: n => { active = n; const t = list.querySelector(`[data-pin="${n}"]`); if (t) { t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } list.querySelectorAll('.thread-pin').forEach(x => x.classList.toggle('active', +x.dataset.pin === n)); } });
      draw();
    }).catch(() => { el.querySelector('.rv3d').innerHTML = '<p class="small muted">The 3D view could not load on this device. Download the files instead.</p>'; });
    draw();
    return { destroy: () => viewer && viewer.destroy(), refresh, openCount: () => (o.pins || []).filter(p => p.status === 'open').length };
  };
  // The model files of the newest round that has any (for the client: only released previews).
  CX.roundModels = (o, includeHeld) => {
    const models = o.files.filter(f => CX.isModel(f.name) && f.kind !== 'reference' && (includeHeld || f.released !== 0));
    if (!models.length) return [];
    const finals = models.filter(f => f.kind === 'final'), previews = models.filter(f => f.kind === 'preview');
    const pool = ['delivered', 'paid'].includes(o.status) && finals.length ? finals : (previews.length ? previews : finals);
    const v = Math.max(...pool.map(f => f.version));
    return pool.filter(f => f.version === v);
  };

  // tiny hash router: '#/a/b?x=1' -> { parts: ['a','b'], q: URLSearchParams }
  CX.route = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, qs] = h.split('?');
    return { parts: p ? p.split('/').filter(Boolean).map(decodeURIComponent) : [], q: new URLSearchParams(qs || '') };
  };
  CX.go = h => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; };
})();
