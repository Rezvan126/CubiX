/* CubiX client portal: shop owners place orders, review previews, approve, download files and talk to the team. */
(function () {
  const { esc, icon, $, $$, get, post, toast, fail, modal, pill, money, ago, dateTime, date } = CX;
  const root = document.getElementById('root');
  const S = { me: null, shop: null, timer: null };
  const cpill = s => pill(s, CX.CLIENT_STATUS);
  const PRODUCTS = ['House replica', 'Pet or figurine', 'Sign or logo', 'Ornament or gift', 'Custom part', 'Something else'];
  const FORMATS = ['STL', '3MF', 'OBJ', 'STEP'];

  CX.onUnauthorized = () => { if (S.me) { S.me = null; toast('Your session ended. Please sign in again.', true); renderLogin(); } };

  // ---------------------------------------------------------------- auth
  const SIDE = `${CX.brand('Client portal', '../index.html', true)}
    <div><h2>You sell the prints. We build the models.</h2>
    <ul><li>${icon('gift')} Your first model is free, any complexity</li><li>${icon('clock')} Delivered in 24 to 48 hours, weekends included</li><li>${icon('eye')} Approve a preview before you pay</li><li>${icon('printer')} Print ready STL and 3MF files</li></ul></div>
    <p class="foot">Questions? Email <a href="mailto:rizwan@coraxys.com" style="color:#fff">rizwan@coraxys.com</a></p>`;
  const card = inner => CX.authShell(SIDE, `<div class="auth-mobile-brand">${CX.brand('Client portal')}</div>${inner}`);
  function renderLogin() {
    stopTimer();
    root.innerHTML = card(`<div><h1>Welcome back</h1><p class="muted" style="margin-top:6px">Sign in to see your orders and files.</p></div>
      <form id="f" novalidate><label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email"></label>${CX.passwordField()}
      <p class="form-msg" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Sign in</button></form>
      <p class="auth-switch"><button class="link" data-go="forgot">Forgot your password?</button></p>
      <p class="auth-switch">New to CubiX? <button class="link" data-go="signup">Create a shop account</button></p>`);
    CX.wirePeek(root);
    CX.submit($('#f'), async d => { await post('/auth/login', d); await boot(); });
    wireGo();
  }
  function renderSignup() {
    root.innerHTML = card(`<div><h1>Create your account</h1><p class="muted" style="margin-top:6px">Takes a minute. Your first model is on us.</p></div>
      <form id="f" novalidate><label class="field"><span>Your name</span><input class="input" name="name" required autocomplete="name"></label>
      <label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email"></label>
      <div class="grid2"><label class="field"><span>Shop name</span><input class="input" name="shop" autocomplete="organization" placeholder="Emma Minis"></label>
      <label class="field"><span>Shop link</span><input class="input" name="url" placeholder="etsy.com/shop/..."></label></div>
      ${CX.passwordField('password', 'Password', 'new-password')}<p class="small muted" style="margin-top:-6px">At least 8 characters.</p>
      <p class="form-msg" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Create account</button></form>
      <p class="auth-switch">Already have an account? <button class="link" data-go="login">Sign in</button></p>`);
    CX.wirePeek(root);
    CX.submit($('#f'), async d => { await post('/auth/signup', d); history.replaceState(null, '', '#/new'); await boot(); toast('Account created. Send us your first model, it is free.'); });
    wireGo();
  }
  function renderForgot() {
    root.innerHTML = card(`<div><h1>Reset password</h1><p class="muted" style="margin-top:6px">We will email you a link to set a new one.</p></div>
      <form id="f" novalidate><label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email"></label>
      <p class="form-msg" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Send reset link</button></form>
      <p class="auth-switch"><button class="link" data-go="login">Back to sign in</button></p>`);
    CX.submit($('#f'), async (d, msg) => { await post('/auth/forgot', d); msg.textContent = 'If that email has an account, a reset link is on its way. Nothing after a few minutes? Email rizwan@coraxys.com.'; msg.className = 'form-msg ok'; });
    wireGo();
  }
  function renderSetup(token) {
    root.innerHTML = card(`<div><h1>Set your password</h1><p class="muted" style="margin-top:6px">Then you can follow your orders, approve previews and download files any time.</p></div>
      <form id="f" novalidate>${CX.passwordField('password', 'New password', 'new-password')}${CX.passwordField('confirm', 'Repeat password', 'new-password')}
      <p class="form-msg" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Save and open my orders</button></form>`);
    CX.wirePeek(root);
    CX.submit($('#f'), async d => {
      if (d.password !== d.confirm) throw new Error('The two passwords do not match.');
      const r = await post('/auth/setup', { token, password: d.password });
      if (r.role !== 'client') { location.href = '/team/'; return; }
      history.replaceState(null, '', '#/'); await boot();
    });
  }
  function wireGo() { $$('[data-go]').forEach(b => b.addEventListener('click', () => ({ login: renderLogin, signup: renderSignup, forgot: renderForgot })[b.dataset.go]())); }

  // ---------------------------------------------------------------- shell
  function renderShell() {
    root.innerHTML = `<header class="ctop"><div class="in">${CX.brand('', '#/')}
      <nav aria-label="Main"><a href="#/" data-v="">My orders</a><a href="#/new" data-v="new">New order</a></nav>
      <div class="right"><a class="btn btn-primary" href="#/new">${icon('plus')}<span>New order</span></a>
        <div class="menu"><button class="icon-btn" id="mBtn" aria-haspopup="true" aria-expanded="false" aria-label="Account">${CX.avatar(S.me.name)}</button>
          <div class="menu-pop" id="mPop" hidden><div class="hd"><b>${esc(S.me.name)}</b><span class="muted">${esc(S.me.email)}</span>${S.shop ? `<div class="muted" style="margin-top:4px">${esc(S.shop.name)} · ${CX.PLANS[S.shop.plan] || ''}</div>` : ''}</div>
            <a href="#/">${icon('layers')} My orders</a><a href="#/invoices">${icon('file')} Invoices</a><button id="pwBtn">${icon('lock')} Change password</button><a href="mailto:rizwan@coraxys.com">${icon('mail')} Email the team</a><a href="../pricing.html#packages">${icon('card')} Monthly packages</a>
            <button id="logout">${icon('logout')} Sign out</button></div></div></div></div></header>
      <main class="cmain" id="main" tabindex="-1"></main>`;
    const btn = $('#mBtn'), pop = $('#mPop');
    btn.addEventListener('click', e => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); });
    document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    $('#pwBtn').addEventListener('click', () => { pop.hidden = true; CX.changePassword(); });
    $('#logout').addEventListener('click', async () => { try { await post('/auth/logout'); } catch {} S.me = null; renderLogin(); });
  }

  async function onRoute() {
    if (!S.me) return;
    const r = CX.route(), v = r.parts[0] || '';
    $$('[data-v]').forEach(a => a.dataset.v === (v === 'orders' ? '' : v) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    const main = $('#main'); main.innerHTML = `<div class="sk" style="height:36px;width:220px;margin-bottom:20px"></div><div class="sk" style="height:90px;margin-bottom:12px"></div><div class="sk" style="height:90px"></div>`;
    window.scrollTo(0, 0);
    try {
      if (v === '') await viewList(main);
      else if (v === 'new') viewNew(main);
      else if (v === 'invoices') await viewInvoices(main);
      else if (v === 'orders' && r.parts[1]) await viewOrder(main, r.parts[1]);
      else main.innerHTML = `<div class="empty"><h3>Page not found</h3><a class="btn btn-line" href="#/">Back to my orders</a></div>`;
    } catch (e) {
      if (e.status === 401) return;
      main.innerHTML = `<div class="empty">${icon('alert')}<h3>${e.status === 404 ? 'We could not find that order' : 'Could not load this page'}</h3><p>${esc(e.message)}</p><a class="btn btn-line" href="#/">Back to my orders</a></div>`;
    }
  }
  function startTimer() {
    stopTimer();
    S.timer = setInterval(() => {
      const r = CX.route();
      if (document.hidden || $('.modal') || $('#prev3d canvas') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) return;
      if ((r.parts[0] || '') === '') viewList($('#main'), true).catch(() => {});
      else if (r.parts[0] === 'orders' && r.parts[1]) viewOrder($('#main'), r.parts[1], true).catch(() => {});
    }, 45000);
  }
  function stopTimer() { if (S.timer) clearInterval(S.timer); S.timer = null; }

  // ---------------------------------------------------------------- orders list
  const needsYou = o => o.status === 'preview' ? 'Review your preview' : o.status === 'delivered' ? 'Download your files' : '';
  async function viewList(main, quiet) {
    const { orders } = await get('/client/orders');
    const me = await get('/auth/me'); S.shop = me.shop;
    const action = orders.filter(o => o.status === 'preview');
    const html = `<div class="top"><div><h1>My orders</h1><p class="muted">${orders.length ? `${orders.length} order${orders.length > 1 ? 's' : ''}. We reply within a few hours, every day.` : 'Send us your first model and watch it come to life here.'}</p></div></div>
      ${S.shop && !S.shop.free_used ? `<div class="banner">${icon('gift')}<div><b>Your first model is free.</b><div class="small">Any complexity. Send the order you have been turning down.</div></div><a class="btn btn-primary" href="#/new">Start my free model</a></div>` : ''}
      ${action.length ? `<div class="banner" style="background:var(--accent-soft);color:var(--ink-2);border:1.5px solid var(--accent)">${icon('eye')}<div><b style="color:var(--ink)">${action.length === 1 ? 'A preview is waiting for you' : `${action.length} previews are waiting for you`}</b><div class="small">Approve it, or tell us what to change. Your customer is waiting too.</div></div><a class="btn btn-dark" href="#/orders/${action[0].id}">Review now</a></div>` : ''}
      ${orders.length ? `<div class="olist">${orders.map(o => `<a class="oitem" href="#/orders/${o.id}">
        ${o.thumb ? `<img class="thumb" src="${CX.thumbUrl(o.thumb)}" alt="" loading="lazy">` : `<span class="thumb ph">${icon('cube')}</span>`}
        <div style="min-width:0"><div class="ttl ellipsis">${esc(o.title)}</div><div class="sub">${esc(o.code)} · ordered ${date(o.created_at)}${o.is_free ? ' · <span style="color:var(--ok);font-weight:600">Free model</span>' : ''}</div></div>
        <div class="act">${cpill(o.status)}${needsYou(o) ? `<span class="callout">${needsYou(o)} ${icon('arrow')}</span>` : (['new', 'confirmed', 'modeling', 'revisions'].includes(o.status) ? `<span class="small muted">Ready by ${dateTime(o.due_at)}</span>` : '')}</div></a>`).join('')}</div>`
      : `<div class="card empty" style="padding:64px 20px">${icon('upload')}<h3>No orders yet</h3><p>Upload a few photos of what your customer wants. We send back a preview within 48 hours.</p><a class="btn btn-primary" href="#/new">${icon('plus')} Place my first order</a></div>`}`;
    if (quiet && CX.route().parts.length) return;
    main.innerHTML = html;
  }

  // ---------------------------------------------------------------- invoices
  async function viewInvoices(main) {
    const { invoices } = await get('/client/invoices');
    main.innerHTML = `<a class="back" href="#/">${icon('arrow')} My orders</a><div class="top"><div><h1>Invoices</h1><p class="muted">Open any invoice to view it or save it as a PDF.</p></div></div>
      ${invoices.length ? `<div class="olist">${invoices.map(i => `<a class="oitem" style="grid-template-columns:48px 1fr auto" href="/invoice/#${esc(i.token)}" target="_blank" rel="noopener">
        <span class="thumb ph" style="width:48px;height:48px">${icon('file')}</span><div style="min-width:0"><div class="ttl ellipsis">Invoice ${esc(i.number)}</div><div class="sub">${esc(i.project_title || '')}${i.order_code ? ` · ${esc(i.order_code)}` : ''} · ${date(i.issued_at)}</div></div>
        <div class="act"><b class="num" style="color:var(--ink)">${esc(i.currency)} ${CX.amount(i.total)}</b>${i.status === 'paid' ? '<span class="pill st-delivered">Paid</span>' : '<span class="pill st-new">Open</span>'}</div></a>`).join('')}</div>`
      : `<div class="card empty" style="padding:56px 20px">${icon('file')}<h3>No invoices yet</h3><p>Invoices appear here once we send them. You only pay after you approve a model.</p></div>`}`;
  }

  // ---------------------------------------------------------------- new order
  function viewNew(main) {
    const free = S.shop && !S.shop.free_used;
    main.innerHTML = `<a class="back" href="#/">${icon('arrow')} My orders</a>
      <div class="top"><div><h1>New order</h1><p class="muted">Tell us what to model. The more photos, the closer the match.</p></div></div>
      <div class="new-grid"><section class="card card-pad"><form id="nf" novalidate>
        <label class="field"><span>What should we model?</span><input class="input" name="title" required maxlength="120" placeholder="Blue farmhouse with porch, for an Etsy order"></label>
        <div class="field"><span>Type</span><div class="chips-input">${PRODUCTS.map((p, i) => `<label><input type="radio" name="product" value="${p}" ${i === 0 ? 'checked' : ''}><span>${p}</span></label>`).join('')}</div></div>
        <div class="grid2"><label class="field"><span>Print size</span><input class="input" name="size" placeholder="15 cm wide"></label><label class="field"><span>Printer</span><input class="input" name="printer" placeholder="Bambu Lab X1C, resin, FDM"></label></div>
        <div class="field"><span>File formats</span><div class="chips-input">${FORMATS.map((f, i) => `<label><input type="checkbox" name="formats" value="${f}" ${i < 2 ? 'checked' : ''}><span>${f}</span></label>`).join('')}</div></div>
        <div class="grid2"><label class="field"><span>How many separate models?</span><select class="input" name="items">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<option value="${n}">${n === 1 ? '1 model' : n + ' models, same photos'}</option>`).join('')}</select><small>For example 3 houses on one street. Each one becomes its own job.</small></label>
          <label class="field"><span>Your ship by date (optional)</span><input class="input" type="date" name="ship_by" min="${new Date().toISOString().slice(0, 10)}"><small>From your Etsy order, so we can flag anything at risk.</small></label></div>
        <div class="field"><span>Turnaround</span><div class="chips-input"><label><input type="radio" name="priority" value="normal" checked><span>Standard, within 48 hours</span></label><label><input type="radio" name="priority" value="rush"><span>Rush, within 24 hours</span></label></div></div>
        <label class="field"><span>Notes</span><textarea class="input" name="notes" maxlength="4000" placeholder="Colors, details to keep, things to leave out, base or no base, split into parts for multicolor"></textarea></label>
        <div class="field"><span>Photos and files</span><div id="dz"></div></div>
        <div class="progress" id="prog" hidden><i></i></div>
        <p class="form-msg" role="alert"></p>
        <button class="btn btn-primary" type="submit" style="justify-self:start;min-width:200px">${free ? 'Send my free order' : 'Send order'}</button>
      </form></section>
      <aside class="card card-pad" style="display:grid;gap:16px"><h3>What happens next</h3><ul class="aside-list">
        <li>${icon('check')}<span>We confirm your order and a modeler starts on it.</span></li>
        <li>${icon('eye')}<span>You get a preview here, usually within 24 to 48 hours.</span></li>
        <li>${icon('refresh')}<span>Approve it or ask for changes. Revisions are included.</span></li>
        <li>${icon('printer')}<span>Download print ready files and print.</span></li>
        <li>${icon('card')}<span>${free ? 'This one is free. ' : ''}Pay after approval through Upwork, Fiverr, Payoneer or direct.</span></li></ul></aside></div>`;
    const dz = CX.dropzone($('#dz', main));
    const form = $('#nf', main);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]'), msg = form.querySelector('.form-msg'), prog = $('#prog', main);
      msg.textContent = ''; msg.className = 'form-msg';
      const fd = new FormData(form);
      if (!String(fd.get('title') || '').trim()) { msg.textContent = 'Tell us what to model.'; msg.className = 'form-msg err'; form.title.focus(); return; }
      const files = dz.files();
      if (!files.length) { msg.textContent = 'Add at least one photo or file.'; msg.className = 'form-msg err'; return; }
      files.forEach(f => fd.append('files', f, f.name)); fd.set('channel', 'Portal');
      try { const src = JSON.parse(localStorage.getItem('cx_src') || 'null'); if (src && src.s) fd.set('source', src.s); } catch {}
      await CX.addThumbs(fd, files);
      CX.busy(btn, true, 'Uploading'); prog.hidden = false;
      try {
        const r = await CX.upload('/client/orders', fd, p => { prog.firstElementChild.style.width = (p * 100) + '%'; });
        toast(r.free ? 'Order sent. This one is free.' : 'Order sent. We are on it.');
        location.hash = '#/orders/' + r.id;
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; CX.busy(btn, false); prog.hidden = true; }
    });
  }

  // ---------------------------------------------------------------- order detail
  const STEPS = ['Received', 'Modeling', 'Preview', 'Approved', 'Files ready'];
  const stepOf = s => ({ new: 0, confirmed: 0, modeling: 1, waiting: 1, review: 1, preview: 2, revisions: 1, approved: 3, delivered: 4, paid: 5 })[s] ?? 0;
  async function viewOrder(main, id, quiet) {
    const { order: o } = await get('/client/orders/' + id);
    if (S.pv) { S.pv.destroy(); S.pv = null; }
    if (quiet && (CX.route().parts[1] !== id)) return;
    const step = stepOf(o.status);
    const latest = kind => { const fs = o.files.filter(f => f.kind === kind); const v = Math.max(0, ...fs.map(f => f.version)); return { v, list: fs.filter(f => f.version === v), all: fs }; };
    const prev = latest('preview'), fin = latest('final'), refs = o.files.filter(f => f.kind === 'reference' && !f.request_id);
    const previewModel = prev.list.find(f => CX.isModel(f.name));
    if (o.status === 'preview' && !quiet) post(`/client/orders/${o.id}/seen`).catch(() => {});
    const lastAsk = [...o.messages].reverse().find(m => m.author_role !== 'client');
    const tile = f => `<a class="file" href="${CX.fileUrl(f.id)}" title="Download ${esc(f.name)}"><span class="fprev">${CX.isImg(f) ? `<img src="${CX.thumbUrl(f.id)}" alt="" loading="lazy">` : esc(CX.ext(f.name))}</span><span class="fname">${esc(f.name)}</span></a>`;
    let action = '';
    if (o.status === 'preview') action = `<div class="actionbox"><h3>Your preview is ready</h3><p class="small">Check the renders below. Approve to get your print ready files, or tell us what to change.</p>
        <div class="row wrap"><button class="btn btn-primary" id="approve">${icon('check')} Approve preview</button><button class="btn btn-line" id="changes">${icon('refresh')} Ask for changes</button></div></div>`;
    else if (o.status === 'waiting') action = `<div class="actionbox"><h3>We need one thing from you</h3>${lastAsk ? `<p style="white-space:pre-wrap">${esc(lastAsk.body)}</p>` : ''}
        <p class="small">Your turnaround clock is paused until you answer, so you lose no time. Reply below or add files.</p>
        <div class="row wrap"><button class="btn btn-primary" id="replyNow">${icon('chat')} Reply</button><button class="btn btn-line" id="addFiles2">${icon('upload')} Add photos or files</button></div></div>`;
    else if (o.status === 'revisions') action = `<div class="actionbox" style="border-color:var(--line-2);background:#fff"><h3>We are making your changes</h3><p class="small">A new preview will be here by ${dateTime(o.due_at)}. Add anything else in the conversation below.</p></div>`;
    else if (o.status === 'approved') action = `<div class="actionbox done"><h3>Approved. Preparing your files.</h3><p class="small">We are exporting print ready files now. You will see them here shortly.</p></div>`;
    else if (o.status === 'delivered' || o.status === 'paid') action = `<div class="actionbox done"><h3>${icon('check')} Your files are ready</h3><p class="small">${fin.list.length} file${fin.list.length === 1 ? '' : 's'}, version ${fin.v}. Something not printing right? Tell us below and we fix it.</p>
        <div class="row wrap">${fin.list.map(f => `<a class="btn btn-ok btn-sm" href="${CX.fileUrl(f.id)}">${icon('download')} ${esc(f.name)}</a>`).join('')}</div>
        ${o.status === 'delivered' ? `<button class="link small" id="changes" style="justify-self:start">Ask for a change</button>` : ''}</div>`;
    else if (o.status === 'cancelled') action = `<div class="actionbox" style="border-color:var(--line-2);background:#fff"><h3>This order was cancelled</h3><p class="small">Questions? Write to us below.</p></div>`;
    else action = `<div class="actionbox" style="border-color:var(--line-2);background:#fff"><h3>${o.status === 'modeling' ? 'A modeler is working on it' : 'We have your order'}</h3><p class="small">Your preview will be here by <b>${dateTime(o.due_at)}</b>. We will email you when it is ready.</p></div>`;

    main.innerHTML = `<a class="back" href="#/">${icon('arrow')} My orders</a>
      <div class="top"><div><div class="row wrap" style="gap:8px;margin-bottom:6px"><span class="code">${esc(o.code)}</span>${cpill(o.status)}${o.is_free ? '<span class="tag tag-free">Free model</span>' : ''}${o.priority === 'rush' ? '<span class="tag tag-rush">Rush</span>' : ''}</div><h1>${esc(o.title)}</h1>
        ${o.siblings && o.siblings.length > 1 ? `<div class="siblings" style="margin-top:10px">${o.siblings.map(x => `<a href="#/orders/${x.id}" ${x.id === o.id ? 'aria-current="true"' : ''}>Model ${x.item_no}</a>`).join('')}</div>` : ''}</div></div>
      <section class="card card-pad" style="margin-bottom:18px">${o.status === 'cancelled' ? '<p class="muted">Cancelled</p>' : `<div class="steps">${STEPS.map((s, i) => `<div class="${i < step || (i === 4 && step >= 4) ? 'done' : i === step ? 'now' : ''}"><i>${i < step || (i === 4 && step >= 4) ? icon('check') : i + 1}</i>${s}</div>`).join('')}</div>`}</section>
      <div class="cgrid"><div style="display:grid;gap:18px;min-width:0">
        ${action}
        ${previewModel ? `<section class="card"><div class="card-head"><h3>Your model in 3D${prev.v > 1 ? `, version ${prev.v}` : ''}</h3><span class="small muted">Drag to turn it</span></div><div style="padding:14px 16px 16px"><div id="prev3d"></div></div></section>` : ''}
        ${prev.list.length ? `<section class="card"><div class="card-head"><h3>Preview${prev.v > 1 ? `, version ${prev.v}` : ''}</h3><span class="small muted">Click to open full size</span></div>
          <div class="gallery">${prev.list.map(f => CX.isImg(f) ? `<a href="${CX.fileUrl(f.id, 1)}" target="_blank" rel="noopener" aria-label="Open ${esc(f.name)}"><img src="${CX.thumbUrl(f.id)}" alt="Preview ${esc(f.name)}" loading="lazy"></a>` : '').join('')}</div>
          ${prev.list.some(f => !CX.isImg(f)) ? `<div style="padding:0 20px 16px" class="files">${prev.list.filter(f => !CX.isImg(f)).map(tile).join('')}</div>` : ''}
          ${prev.v > 1 ? `<details style="padding:0 20px 16px"><summary class="small muted" style="cursor:pointer">Earlier versions</summary><div class="files" style="margin-top:10px">${prev.all.filter(f => f.version !== prev.v).map(tile).join('')}</div></details>` : ''}</section>` : ''}
        <section class="card"><div class="card-head"><h3>Conversation</h3><span class="small muted">We usually reply within a few hours</span></div>
          <div class="thread" id="thread">${o.messages.length ? o.messages.map(m => { const mine = m.author_role === 'client'; return `<div class="msg ${mine ? 'mine' : 'theirs'}"><div class="bub">${esc(m.body)}</div><div class="by">${mine ? 'You' : esc(m.author ? m.author + ', CubiX' : 'CubiX')} · ${ago(m.created_at)}</div></div>`; }).join('') : '<p class="small muted">No messages yet. Ask us anything about this order.</p>'}</div>
          <form class="compose" id="compose"><textarea class="input" name="body" placeholder="Write a message to the CubiX team" required maxlength="4000"></textarea><div class="row" style="justify-content:flex-end"><button class="btn btn-dark btn-sm" type="submit">${icon('send')} Send</button></div></form></section>
      </div>
      <aside style="display:grid;gap:18px">
        <section class="card"><div class="card-head"><h3>Order details</h3></div><dl class="specs" style="grid-template-columns:1fr 1fr">${[['Type', o.product], ['Ships by', o.ship_by ? date(o.ship_by) : ''], ['Size', o.size], ['Printer', o.printer], ['Formats', o.formats], ['Ordered', dateTime(o.created_at)], ['Revisions', o.revisions ? String(o.revisions) : '']].filter(x => x[1]).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
          ${o.notes ? `<div class="notes small">${esc(o.notes)}</div>` : ''}</section>
        <section class="card card-pad" style="display:grid;gap:8px"><h3>Payment</h3>${(o.invoices || []).map(i => `<a class="inv-link" href="/invoice/#${esc(i.token)}" target="_blank" rel="noopener"><span>${icon('file')} Invoice ${esc(i.number)}</span><span class="num">${esc(i.currency)} ${CX.amount(i.total)} ${i.status === 'paid' ? '<span class="pill st-delivered plain">Paid</span>' : '<span class="pill st-new plain">Open</span>'}</span></a>`).join('')}${o.is_free ? '<p class="small"><b style="color:var(--ok)">Free.</b> Your first model is on us.</p>' : o.paid ? `<p class="small"><b style="color:var(--ok)">Paid</b>${o.paid_via ? ' via ' + esc(o.paid_via) : ''}. Thank you.</p>` : o.price ? `<p class="small">Price: <b>${money(o.price)}</b>. Pay after approval through Upwork, Fiverr, Payoneer or direct. We send the details.</p>` : '<p class="small muted">We confirm the price before we start. You pay only after you approve the model.</p>'}</section>
        <section class="card"><div class="card-head"><h3>Your files</h3>${['paid', 'cancelled'].includes(o.status) ? '' : `<button class="btn btn-line btn-sm" id="addFiles">${icon('plus')} Add files</button>`}</div><div class="fgroup"><div class="files">${refs.map(tile).join('') || '<p class="small muted">None</p>'}</div>
          <input type="file" id="moreFiles" multiple hidden><div class="progress" id="moreProg" hidden><i></i></div></div></section>
      </aside></div>`;
    const th = $('#thread', main); th.scrollTop = th.scrollHeight;
    const af = $('#addFiles', main), mf = $('#moreFiles', main);
    af && af.addEventListener('click', () => mf.click());
    mf && mf.addEventListener('change', async () => {
      let list = [...mf.files]; mf.value = ''; if (!list.length) return;
      list = await CX.convertHeic(list, () => toast('Converting iPhone photos, one moment'));
      if (list.some(f => f.size > 25 * 1024 * 1024)) return toast('Each file must be under 25 MB. Email bigger files to us.', true);
      const fd = new FormData(); list.forEach(f => fd.append('files', f, f.name)); await CX.addThumbs(fd, list);
      const prog = $('#moreProg', main); prog.hidden = false; af.disabled = true;
      try { await CX.upload(`/client/orders/${o.id}/files`, fd, p => { prog.firstElementChild.style.width = (p * 100) + '%'; }); toast('Files added. The team can see them now.'); viewOrder(main, o.id); }
      catch (e) { fail(e); prog.hidden = true; af.disabled = false; }
    });
    const ap = $('#approve', main);
    ap && ap.addEventListener('click', async () => {
      if (!(await CX.confirm('Approve this preview?', 'We will prepare your print ready files right away.', 'Approve'))) return;
      try { await post(`/client/orders/${o.id}/approve`); toast('Approved. Your files are on the way.'); viewOrder(main, o.id); } catch (e) { fail(e); }
    });
    const ch = $('#changes', main);
    let prevViewer = null;
    const p3 = $('#prev3d', main);
    if (p3 && previewModel) CX.loadViewer().then(m => { prevViewer = S.pv = m.mount(p3, { url: CX.fileUrl(previewModel.id), name: previewModel.name }); }).catch(() => { p3.innerHTML = '<p class="small muted">The 3D view could not load on this device. Download the file instead.</p>'; });
    const rn = $('#replyNow', main); rn && rn.addEventListener('click', () => { const t = $('#compose textarea', main); t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.focus(); });
    const af2 = $('#addFiles2', main); af2 && af2.addEventListener('click', () => $('#moreFiles', main) && $('#moreFiles', main).click());
    ch && ch.addEventListener('click', () => {
      let pins = [], viewer = null, dz = null;
      modal(`<h2>What should we change?</h2><p class="muted small">${previewModel ? 'Click on the model to drop a numbered pin on each spot, and write what to change next to it. ' : ''}Add a note below, and photos if they help.</p>
      <form id="rf" style="display:grid;gap:14px">
        ${previewModel ? `<div id="pin3d"></div><ol class="pinlist" id="pinNotes"></ol>` : ''}
        <label class="field"><span>What to change</span><textarea class="input" name="body" required maxlength="4000" placeholder="Make the roof darker and add the chimney on the left side" style="min-height:100px"></textarea></label>
        <div class="field"><span>Photos (optional)</span><div id="rdz"></div></div>
        <p class="form-msg" role="alert"></p><div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">Send changes</button></div></form>`, (box, close) => {
        box.classList.add('wide');
        dz = CX.dropzone($('#rdz', box), { hint: 'Close ups or reference photos, up to 25 MB each' });
        const notes = $('#pinNotes', box);
        const drawNotes = () => { if (!notes) return; notes.innerHTML = pins.map((p, i) => `<li><button type="button" class="pn" data-pin="${p.n}" aria-label="Show pin ${p.n}">${p.n}</button><input class="input input-sm" data-note="${i}" value="${esc(p.note)}" placeholder="What to change at pin ${p.n}"><button type="button" class="icon-btn" data-rmpin="${i}" aria-label="Remove pin ${p.n}">${icon('x')}</button></li>`).join(''); };
        if (previewModel) CX.loadViewer().then(m => {
          viewer = m.mount($('#pin3d', box), { url: CX.fileUrl(previewModel.id), name: previewModel.name, editable: true, onChange: list => { pins = list.map((p, i) => ({ ...p, note: (pins[i] && pins[i].note) || '' })); drawNotes(); const last = notes && notes.querySelector(`[data-note="${pins.length - 1}"]`); last && last.focus(); } });
        }).catch(() => { $('#pin3d', box).innerHTML = '<p class="small muted">The 3D view could not load. Describe the changes below instead.</p>'; });
        notes && notes.addEventListener('input', e => { const i = e.target.dataset.note; if (i !== undefined) pins[+i].note = e.target.value; });
        notes && notes.addEventListener('click', e => {
          const rm = e.target.closest('[data-rmpin]'); if (rm) { pins.splice(+rm.dataset.rmpin, 1); pins = pins.map((p, i) => ({ ...p, n: i + 1 })); viewer && viewer.setPins(pins); drawNotes(); }
          const pb = e.target.closest('[data-pin]'); if (pb && viewer) viewer.focusPin(+pb.dataset.pin);
        });
        const obs = new MutationObserver(() => { if (!document.body.contains(box)) { obs.disconnect(); viewer && viewer.destroy(); } });
        obs.observe(document.body, { childList: true });
        CX.submit($('#rf', box), async d => {
          if (!d.body.trim() && !pins.length) throw new Error('Tell us what to change, or drop a pin on the model.');
          const fd = new FormData();
          fd.set('body', d.body.trim() || pins.map(p => `Pin ${p.n}: ${p.note || 'see pin'}`).join('\n'));
          fd.set('pins', JSON.stringify(pins)); if (previewModel) fd.set('model_file', previewModel.id);
          const photos = dz.files(); photos.forEach(f => fd.append('files', f, f.name)); await CX.addThumbs(fd, photos);
          const r = await CX.upload(`/client/orders/${o.id}/revision`, fd);
          close(); toast(`Got it. Round ${r.round} is on its way.`); viewOrder(main, o.id);
        });
      });
    });
    CX.submit($('#compose', main), async d => { if (!d.body.trim()) throw new Error('Write a message first.'); await post(`/client/orders/${o.id}/messages`, d); toast('Message sent'); viewOrder(main, o.id); });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const r = CX.route();
    if (r.parts[0] === 'setup' && r.parts[1]) return renderSetup(r.parts[1]);
    if (r.parts[0] === 'signup' && !S.me) { try { await get('/auth/me'); } catch { return renderSignup(); } }
    try { const me = await get('/auth/me'); S.me = me.user; S.shop = me.shop; }
    catch (e) { S.me = null; if (e.status === 401) return renderLogin(); root.innerHTML = `<div class="empty" style="min-height:100vh">${icon('alert')}<h3>Could not reach the server</h3><p>${esc(e.message)}</p><button class="btn btn-line" onclick="location.reload()">Try again</button></div>`; return; }
    if (S.me.role !== 'client') { location.href = '/team/'; return; }
    if (r.parts[0] === 'signup') history.replaceState(null, '', '#/');
    renderShell(); await onRoute(); startTimer();
  }
  window.addEventListener('hashchange', () => { const r = CX.route(); if (r.parts[0] === 'setup' || (!S.me && r.parts[0] === 'signup')) return boot(); if (S.me) onRoute(); });
  boot();
})();
