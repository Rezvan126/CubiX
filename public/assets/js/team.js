/* CubiX team dashboard: overview, board, orders, shops, team, order drawer. */
(function () {
  const { esc, icon, $, $$, get, post, patch, toast, fail, modal, pill, avatar, money, ago, dateTime, date } = CX;
  // Team view of time: the hand in countdown while we build, paused while waiting, QC while in review.
  const due = o => {
    if (o.status === 'waiting') return '<span class="due">Paused, waiting on client</span>';
    if (o.status === 'review') return '<span class="due soon">Waiting for QC</span>';
    if (['new', 'confirmed', 'modeling', 'revisions'].includes(o.status) && o.handin_at) return CX.countdown(o.handin_at, 'Hand in: ', 'Past due by');
    return CX.due(o);
  };
  const open3d = (id, name) => CX.open3d(id, name);
  const badges = o => `${o.priority === 'rush' ? '<span class="tag tag-rush">Rush</span>' : ''}${CX.shipRisk(o) ? `<span class="tag tag-risk" title="Ships by ${date(o.ship_by)}">Ship date at risk</span>` : ''}${o.item_count ? `<span class="tag tag-item">${o.item_no} of ${o.item_count}</span>` : ''}${o.revisions ? `<span class="tag tag-round">Round ${o.revisions + 1}</span>` : ''}${o.is_free ? '<span class="tag tag-free">Free</span>' : ''}`;
  const root = document.getElementById('root');
  const S = { me: null, members: [], overview: null, view: '', timer: null, dragging: false };
  const BOARD = ['new', 'confirmed', 'modeling', 'waiting', 'review', 'preview', 'revisions', 'approved', 'delivered'];
  const PAY_VIA = ['Direct', 'Payoneer', 'Upwork', 'Fiverr', 'Free first model'];
  const admin = () => S.me && S.me.role === 'admin';

  CX.onUnauthorized = () => { if (S.me) { S.me = null; toast('Your session ended. Please sign in again.', true); renderLogin(); } };

  // ---------------------------------------------------------------- auth screens
  const SIDE = `${CX.brand('Team', '../index.html', true)}
    <div><h2>Every order, every modeler, one screen.</h2>
    <ul><li>${icon('gauge')} Live capacity against the 48 hour promise</li><li>${icon('board')} Drag orders through production</li><li>${icon('chat')} Talk to shops and leave internal notes</li><li>${icon('dollar')} Track approvals and payments</li></ul></div>
    <p class="foot">CubiX production dashboard. For team members only.</p>`;
  function renderLogin() {
    stopTimer();
    root.innerHTML = CX.authShell(SIDE, `<div class="auth-mobile-brand">${CX.brand('Team')}</div>
      <div><h1>Sign in</h1><p class="muted" style="margin-top:6px">Use the email your admin invited.</p></div>
      <form id="f" novalidate>
        <label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email"></label>
        ${CX.passwordField()}
        <p class="form-msg" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
      <p class="auth-switch"><button class="link" id="forgot">Forgot your password?</button></p>`);
    CX.wirePeek(root);
    CX.submit($('#f'), async d => { await post('/auth/login', d); await boot(); });
    $('#forgot').addEventListener('click', renderForgot);
  }
  function renderForgot() {
    root.innerHTML = CX.authShell(SIDE, `<div class="auth-mobile-brand">${CX.brand('Team')}</div>
      <div><h1>Reset password</h1><p class="muted" style="margin-top:6px">We will email you a link to set a new password.</p></div>
      <form id="f" novalidate><label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email"></label>
      <p class="form-msg" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Send reset link</button></form>
      <p class="auth-switch"><button class="link" id="back">Back to sign in</button></p>`);
    CX.submit($('#f'), async (d, msg) => { await post('/auth/forgot', d); msg.textContent = 'If that email has an account, a reset link is on its way. No email? Ask your admin for a new link.'; msg.className = 'form-msg ok'; });
    $('#back').addEventListener('click', renderLogin);
  }
  function renderSetup(token) {
    root.innerHTML = CX.authShell(SIDE, `<div class="auth-mobile-brand">${CX.brand('Team')}</div>
      <div><h1>Set your password</h1><p class="muted" style="margin-top:6px">Choose at least 8 characters. You will be signed in right after.</p></div>
      <form id="f" novalidate>${CX.passwordField('password', 'New password', 'new-password')}${CX.passwordField('confirm', 'Repeat password', 'new-password')}
      <p class="form-msg" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Save and continue</button></form>`);
    CX.wirePeek(root);
    CX.submit($('#f'), async d => {
      if (d.password !== d.confirm) throw new Error('The two passwords do not match.');
      const r = await post('/auth/setup', { token, password: d.password });
      if (r.role === 'client') { location.href = '/app/'; return; }
      history.replaceState(null, '', '#/'); await boot();
    });
  }

  // ---------------------------------------------------------------- shell
  const NAV_ALL = [['', 'Overview', 'gauge'], ['board', 'Board', 'board'], ['orders', 'Orders', 'list'], ['shops', 'Shops', 'store'], ['invoices', 'Invoices', 'file', true], ['handbook', 'Handbook', 'note'], ['team', 'Team', 'users'], ['settings', 'Settings', 'shield', true]];
  let NAV = NAV_ALL;
  function renderShell() {
    NAV = NAV_ALL.filter(n => !n[3] || admin());
    root.innerHTML = `<div class="shell">
      <aside class="side" aria-label="Main">
        ${CX.brand('Team', '#/')}
        <nav class="nav">${NAV.map(([h, l, i]) => `<a href="#/${h}" data-v="${h}">${icon(i)}${l}<span class="count" data-count="${h}" hidden></span></a>`).join('')}</nav>
        <div class="side-cap" id="sideCap"></div>
        <div class="side-user">${avatar(S.me.name)}<div class="who"><b class="ellipsis">${esc(S.me.name)}</b><span class="muted small">${S.me.role === 'admin' ? 'Admin' : 'Modeler'}</span></div>
          <button class="icon-btn" id="pw" aria-label="Change password" title="Change password">${icon('lock')}</button><button class="icon-btn" id="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button></div>
      </aside>
      <div class="mobilebar">${CX.brand('', '#/')}<div class="row">${avatar(S.me.name)}<button class="icon-btn" id="pw2" aria-label="Change password">${icon('lock')}</button><button class="icon-btn" id="logout2" aria-label="Sign out">${icon('logout')}</button></div></div>
      <main class="main" id="main" tabindex="-1"></main>
      <nav class="tabbar" aria-label="Main">${NAV.map(([h, l, i]) => `<a href="#/${h}" data-v="${h}">${icon(i)}${l}</a>`).join('')}</nav>
    </div>`;
    const out = async () => { try { await post('/auth/logout'); } catch {} S.me = null; renderLogin(); };
    $('#logout').addEventListener('click', out); $('#logout2').addEventListener('click', out);
    $('#pw').addEventListener('click', CX.changePassword); $('#pw2').addEventListener('click', CX.changePassword);
  }
  function markNav(v) { $$('[data-v]').forEach(a => a.dataset.v === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')); }
  function capClass(r) { return r >= 1 ? 'full' : r >= .75 ? 'mid' : ''; }
  function updateSide(ov) {
    if (!ov) return;
    const open = ov.byStatus.filter(s => !['delivered', 'paid', 'cancelled'].includes(s.status)).reduce((a, s) => a + s.n, 0);
    const set = (k, n, hot) => { const el = $(`[data-count="${k}"]`); if (!el) return; el.hidden = !n; el.textContent = n; el.classList.toggle('hot', !!hot); };
    set('board', open); set('orders', ov.overdue, true);
    const r = ov.capacity ? ov.load / ov.capacity : 0;
    $('#sideCap').innerHTML = `<div class="row" style="justify-content:space-between"><b>Team load</b><span class="small muted num">${ov.load} of ${ov.capacity}</span></div>
      <div class="bar thin ${capClass(r)}"><i style="width:${Math.min(100, r * 100)}%"></i></div>
      <span class="small muted">${r >= 1 ? 'At capacity. New orders will queue.' : `${Math.max(0, ov.capacity - ov.load)} more orders fit right now.`}</span>`;
  }
  async function refreshOverview() { try { S.overview = await get('/team/overview'); updateSide(S.overview); } catch {} return S.overview; }
  async function loadMembers() { S.members = (await get('/team/members')).members; }

  // ---------------------------------------------------------------- router
  const viewKey = () => { const r = CX.route(); r.q.delete('o'); return r.parts.join('/') + '?' + r.q.toString(); };
  async function onRoute() {
    if (!S.me) return;
    const r = CX.route(), key = viewKey();
    if (key !== S.view) { S.view = key; refreshOverview(); await renderView(true); }
    syncDrawer(r.q.get('o'));
  }
  async function renderView(first) {
    const r = CX.route(), v = r.parts[0] || '';
    markNav(v);
    const main = $('#main');
    if (first) main.innerHTML = `<div class="sk" style="height:38px;width:240px;margin-bottom:22px"></div><div class="sk" style="height:110px;margin-bottom:16px"></div><div class="sk" style="height:320px"></div>`;
    try {
      if (v === '') await viewOverview(main);
      else if (v === 'board') await viewBoard(main, r.q);
      else if (v === 'orders') await viewOrders(main, r.q);
      else if (v === 'shops') await viewShops(main);
      else if (v === 'team') await viewTeam(main);
      else if (v === 'invoices' && admin()) await viewInvoices(main, r.q);
      else if (v === 'settings' && admin()) await viewSettings(main);
      else if (v === 'handbook') await viewHandbook(main);
      else main.innerHTML = `<div class="empty"><h3>Page not found</h3><a class="btn btn-line" href="#/">Go to overview</a></div>`;
    } catch (e) { if (e.status !== 401) main.innerHTML = `<div class="empty">${icon('alert')}<h3>Could not load this page</h3><p>${esc(e.message)}</p><button class="btn btn-line" onclick="location.reload()">Try again</button></div>`; }
  }
  const setQ = (changes) => {
    const r = CX.route(); for (const [k, v] of Object.entries(changes)) v ? r.q.set(k, v) : r.q.delete(k);
    const qs = r.q.toString(); location.hash = '#/' + r.parts.join('/') + (qs ? '?' + qs : '');
  };
  const openOrder = id => setQ({ o: id });
  function startTimer() {
    stopTimer();
    S.timer = setInterval(async () => {
      if (document.hidden || S.dragging || $('.modal') || $('.drawer') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) return;
      await refreshOverview(); renderView(false);
    }, 30000);
  }
  function stopTimer() { if (S.timer) clearInterval(S.timer); S.timer = null; }

  // ---------------------------------------------------------------- overview
  async function viewOverview(main) {
    const ov = await refreshOverview();
    const count = s => (ov.byStatus.find(x => x.status === s) || { n: 0 }).n;
    const open = ['new', 'confirmed', 'modeling', 'preview', 'revisions', 'approved'].reduce((a, s) => a + count(s), 0);
    const r = ov.capacity ? ov.load / ov.capacity : 0;
    const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
    const kpi = (label, ic, val, sub, href, cls = '') => `<a class="kpi ${cls}" href="${href}"><span class="k-label">${icon(ic)}${label}</span><span class="k-val">${val}</span><span class="k-sub">${sub}</span></a>`;
    main.innerHTML = `
      <div class="top"><div><h1>${hello}, ${esc(S.me.name.split(' ')[0])}</h1><p class="muted">${open ? `${open} orders in production. ${ov.overdue ? `<b style="color:var(--bad)">${ov.overdue} overdue.</b>` : 'Nothing overdue.'}` : 'No open orders right now.'}</p></div>
        <div class="row wrap">${jobBank()}<a class="btn btn-dark" href="#/board">${icon('board')} Open board</a></div></div>
      <div class="kpis k8">
        ${kpi('Open orders', 'layers', open, `${count('new')} new, ${count('revisions')} in revisions`, '#/orders?status=open')}
        ${kpi('Due in 24h', 'clock', ov.dueSoon, 'Keep these moving', '#/orders?status=open', ov.dueSoon ? 'warn' : '')}
        ${kpi('Overdue', 'alert', ov.overdue, ov.overdue ? 'Past the promised time' : 'All on time', '#/orders?due=overdue', ov.overdue ? 'bad' : '')}
        ${kpi('Unassigned', 'users', ov.unassigned, 'In the Job Bank', '#/board?assignee=none', ov.unassigned ? 'warn' : '')}
        ${kpi('Needs QC', 'shield', ov.inReview, admin() ? 'Check and send to the client' : 'With an admin for review', '#/orders?status=review', ov.inReview ? 'warn' : '')}
        ${kpi('Waiting on clients', 'clock', ov.waiting, 'Clock paused', '#/orders?status=waiting')}
        ${kpi('Awaiting payment', 'card', money(ov.awaiting.total) || '$0', `${ov.awaiting.n} approved or delivered, unpaid`, '#/orders?unpaid=1')}
        ${kpi('Paid this month', 'dollar', money(ov.paidMonth.total) || '$0', `${ov.paidMonth.n} order${ov.paidMonth.n === 1 ? '' : 's'} closed`, '#/orders?status=paid')}
      </div>
      <div class="ov-grid">
        <div class="ov-col">
          <section class="card"><div class="card-head"><h2>Needs attention</h2><span class="small muted">Late, QC, unassigned, changes or new client messages</span></div>
            <div class="alist">${ov.attention.length ? ov.attention.map(o => `<button class="aitem" data-o="${o.id}">
              ${avatar(o.assignee_name)}<div class="grow"><div class="ttl ellipsis">${esc(o.title)}</div><div class="sub ellipsis">${esc(o.code)} · ${esc(o.shop_name)}</div></div>
              <div style="display:grid;justify-items:end;gap:4px">${pill(o.status)}${due(o) || (o.assignee_name ? '' : '<span class="due soon">Unassigned</span>')}</div></button>`).join('')
              : `<div class="empty" style="padding:36px">${icon('check')}<h3>All clear</h3><p>Nothing late, nothing unassigned.</p></div>`}</div></section>
          <section class="card"><div class="card-head"><h2>Pipeline</h2><a class="small muted" href="#/orders?status=open">See all</a></div>
            <div class="pipe">${BOARD.map(s => { const n = count(s), max = Math.max(1, ...BOARD.map(count)); return `<a href="#/orders?status=${s}"><div class="pb st-${s}" style="height:${34 + 40 * n / max}px">${n}</div><span>${CX.STATUS[s]}</span></a>`; }).join('')}</div></section>
        </div>
        <div class="ov-col">
          <section class="card"><div class="cap-big"><div class="row" style="justify-content:space-between"><h2>Capacity</h2><span class="small muted">Open orders per person</span></div>
            <div class="row" style="justify-content:space-between;align-items:baseline"><b class="num">${ov.load} / ${ov.capacity}</b><span class="small ${r >= 1 ? '' : 'muted'}" style="${r >= 1 ? 'color:var(--bad);font-weight:600' : ''}">${Math.round(r * 100)}% used</span></div>
            <div class="bar ${capClass(r)}"><i style="width:${Math.min(100, r * 100)}%"></i></div></div>
            <div class="mods">${ov.team.map(m => { const mr = m.capacity ? m.open / m.capacity : 0; return `<div class="mod">${avatar(m.name)}
              <div class="meta"><div class="row"><b class="small ellipsis" style="color:var(--ink)">${esc(m.name)}</b><span class="nums num">${m.open} of ${m.capacity}${m.overdue ? ` · <span style="color:var(--bad)">${m.overdue} late</span>` : ''}</span></div>
              <div class="bar thin ${capClass(mr)}"><i style="width:${Math.min(100, mr * 100)}%"></i></div></div>
              <a class="icon-btn" href="#/board?assignee=${m.id}" aria-label="Board for ${esc(m.name)}">${icon('chevron')}</a></div>`; }).join('') || '<div class="empty">No team members yet.</div>'}</div>
            ${admin() ? `<div style="padding:12px 20px;border-top:1px solid var(--line)"><a class="small" href="#/team" style="font-weight:600">Change capacity or add people</a></div>` : ''}</section>
          ${ov.sources && ov.sources.length ? `<section class="card"><div class="card-head"><h2>Where orders come from</h2><span class="small muted">Last 30 days</span></div>
            <div style="padding:8px 20px 16px;display:grid;gap:10px">${(() => { const max = Math.max(...ov.sources.map(x => x.n)); return ov.sources.map(x => `<div><div class="row" style="justify-content:space-between"><span class="small" style="font-weight:600;color:var(--ink)">${esc(x.source)}</span><span class="small muted num">${x.n}</span></div><div class="bar thin"><i style="width:${x.n / max * 100}%;background:var(--accent)"></i></div></div>`).join(''); })()}</div></section>` : ''}
          ${admin() && ov.storage && ov.storage.limit && ov.storage.bytes / ov.storage.limit > 0.6 ? `<section class="card card-pad" style="border-color:${ov.storage.bytes / ov.storage.limit > 0.8 ? 'var(--bad)' : '#e6c36a'}"><b style="color:var(--ink)">File storage ${Math.round(ov.storage.bytes / ov.storage.limit * 100)}% full</b><p class="small muted" style="margin-top:4px">${CX.size(ov.storage.bytes)} of 5 GB used. Plan the move to Cloudflare R2 before it fills up. <a href="#/settings">Details</a></p></section>` : ''}
          <section class="card card-pad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;text-align:center">
            <div><div class="k-val num" style="font-family:var(--display);font-size:1.5rem;font-weight:700;color:var(--ink)">${ov.avgHours === null ? 'Not yet' : Math.round(ov.avgHours) + 'h'}</div><div class="small muted">Avg turnaround, 30 days</div></div>
            <div><div class="num" style="font-family:var(--display);font-size:1.5rem;font-weight:700;color:var(--ink)">${ov.deliveredLast30}</div><div class="small muted">Delivered, 30 days</div></div>
            <div><div class="num" style="font-family:var(--display);font-size:1.5rem;font-weight:700;color:var(--ink)">${ov.newShops}</div><div class="small muted">New shops this month</div></div>
          </section>
        </div>
      </div>`;
    $$('[data-o]', main).forEach(b => b.addEventListener('click', () => openOrder(b.dataset.o)));
    wireJobBank(main);
  }

  // ---------------------------------------------------------------- shared filters
  function assigneeOptions(sel) {
    return `<option value="">Everyone</option><option value="me" ${sel === 'me' ? 'selected' : ''}>My orders</option><option value="none" ${sel === 'none' ? 'selected' : ''}>Unassigned</option>` +
      S.members.filter(m => m.active).map(m => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  }
  function wireToolbar(main) {
    const s = $('#q', main); let t;
    s && s.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => setQ({ q: s.value.trim() }), 350); });
    $$('[data-filter]', main).forEach(el => el.addEventListener('change', () => setQ({ [el.dataset.filter]: el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value })));
  }
  const thumb = o => o.thumb ? `<img class="thumb" src="${CX.thumbUrl(o.thumb)}" alt="" loading="lazy">` : `<span class="thumb ph">${icon('cube')}</span>`;

  // ---------------------------------------------------------------- board
  async function viewBoard(main, q) {
    const qs = new URLSearchParams(); if (q.get('assignee')) qs.set('assignee', q.get('assignee')); if (q.get('q')) qs.set('q', q.get('q'));
    const [open, delivered] = await Promise.all([get('/team/orders?status=open&' + qs), get('/team/orders?status=delivered&' + qs)]);
    const orders = [...open.orders, ...delivered.orders];
    await refreshOverview();
    main.innerHTML = `<div class="top"><div><h1>Board</h1><p class="muted">Drag a card to move it. Click to open.</p></div>${jobBank()}</div>
      <div class="toolbar"><label class="search">${icon('search')}<span class="sr">Search</span><input class="input input-sm" id="q" placeholder="Order code, title or shop" value="${esc(q.get('q') || '')}"></label>
        <select class="input input-sm" data-filter="assignee" style="width:auto" aria-label="Assignee">${assigneeOptions(q.get('assignee') || '')}</select>
        <span class="small muted" style="margin-left:auto">${orders.length} orders</span></div>
      <div class="board">${BOARD.map(s => { const list = orders.filter(o => o.status === s); return `<section class="col" data-status="${s}" aria-label="${CX.STATUS[s]}">
        <div class="col-head"><b>${CX.STATUS[s]}</b><span class="n">${list.length}</span></div>
        ${list.map(card).join('') || `<p class="small muted" style="text-align:center;padding:14px 0">${s === 'delivered' ? 'Unpaid deliveries show here' : 'Nothing here'}</p>`}</section>`; }).join('')}</div>`;
    wireToolbar(main); wireJobBank(main);
    $$('.ocard', main).forEach(c => {
      c.addEventListener('click', () => openOrder(c.dataset.id));
      c.addEventListener('dragstart', e => { S.dragging = true; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; });
      c.addEventListener('dragend', () => { S.dragging = false; c.classList.remove('dragging'); });
    });
    $$('.col', main).forEach(col => {
      col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
      col.addEventListener('drop', async e => {
        e.preventDefault(); col.classList.remove('over');
        const id = e.dataTransfer.getData('text/plain'), o = orders.find(x => x.id === id);
        if (!o || o.status === col.dataset.status) return;
        try { await patch('/team/orders/' + id, { status: col.dataset.status }); toast(`${o.code} moved to ${CX.STATUS[col.dataset.status]}`); refreshOverview(); renderView(false); }
        catch (err) { fail(err); }
      });
    });
  }
  function jobBank() {
    const meRow = S.overview && S.overview.team.find(m => m.id === S.me.id);
    const held = meRow ? meRow.open : 0, cap = meRow ? meRow.capacity : (S.me.capacity || 4);
    return `<div class="jobbank"><button class="btn btn-primary" id="takeNext" ${held >= cap ? 'disabled' : ''}>${icon('plus')} ${held >= cap ? 'You are at capacity' : 'Take next job'}</button><span class="hold">You hold ${held} of ${cap}</span></div>`;
  }
  function wireJobBank(main) {
    const b = $('#takeNext', main); if (!b) return;
    b.addEventListener('click', async () => {
      CX.busy(b, true);
      try { const r = await post('/team/jobs/next'); await refreshOverview(); if (!r.order) { toast('No jobs waiting right now. Nice work.'); renderView(false); return; } toast(`${r.order.code} is yours`); openOrder(r.order.id); renderView(false); }
      catch (e) { fail(e); CX.busy(b, false); }
    });
  }
  function card(o) {
    const late = ['new', 'confirmed', 'modeling', 'revisions'].includes(o.status) && o.handin_at && new Date(o.handin_at) < Date.now();
    return `<button class="ocard ${late || CX.isLate(o) ? 'late' : ''}" draggable="true" data-id="${o.id}">
      <div class="top-r">${thumb(o)}<div class="grow"><div class="ttl">${esc(o.title)}</div><div class="shop ellipsis">${esc(o.shop_name)}</div></div>${o.unread ? '<span class="unread-dot" title="New from the client"></span>' : ''}</div>
      <div class="tags">${badges(o)}${o.status === 'preview' ? `<span class="tag tag-plan">${o.preview_seen_at ? 'Seen' : 'Not opened yet'}</span>` : ''}</div>
      <div class="foot"><span class="code">${esc(o.code)}</span>${due(o) || (o.status === 'delivered' ? '<span class="due">Awaiting payment</span>' : '')}${avatar(o.assignee_name)}</div></button>`;
  }

  // ---------------------------------------------------------------- orders list
  async function viewOrders(main, q) {
    const qs = new URLSearchParams();
    for (const k of ['status', 'assignee', 'q', 'due', 'unpaid', 'sort', 'shop']) if (q.get(k)) qs.set(k, q.get(k));
    const { orders } = await get('/team/orders?' + qs);
    const st = q.get('status') || '';
    main.innerHTML = `<div class="top"><div><h1>Orders</h1><p class="muted">Every order across every shop.</p></div></div>
      <div class="toolbar"><label class="search">${icon('search')}<span class="sr">Search</span><input class="input input-sm" id="q" placeholder="Order code, title or shop" value="${esc(q.get('q') || '')}"></label>
        <select class="input input-sm" data-filter="status" style="width:auto" aria-label="Status"><option value="">All statuses</option><option value="open" ${st === 'open' ? 'selected' : ''}>Open</option>${Object.entries(CX.STATUS).map(([k, l]) => `<option value="${k}" ${st === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="input input-sm" data-filter="assignee" style="width:auto" aria-label="Assignee">${assigneeOptions(q.get('assignee') || '')}</select>
        <label class="check small"><input type="checkbox" data-filter="due" value="overdue" ${q.get('due') ? 'checked' : ''}> Overdue</label>
        <label class="check small"><input type="checkbox" data-filter="unpaid" ${q.get('unpaid') ? 'checked' : ''}> Unpaid</label>
        <select class="input input-sm" data-filter="sort" style="width:auto;margin-left:auto" aria-label="Sort"><option value="">Sort by due time</option><option value="new" ${q.get('sort') === 'new' ? 'selected' : ''}>Newest first</option></select></div>
      <section class="card">${orders.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Order</th><th class="hide-sm">Shop</th><th>Status</th><th class="hide-sm">Modeler</th><th>Due</th><th class="hide-sm">Price</th><th class="hide-sm">Updated</th></tr></thead><tbody>
        ${orders.map(o => `<tr class="click" data-o="${o.id}" tabindex="0"><td><div class="row">${thumb(o)}<div class="grow" style="min-width:140px"><div style="font-weight:600;color:var(--ink)">${esc(o.title)}</div><div class="code">${esc(o.code)} ${o.priority === 'rush' ? '<span class="tag tag-rush">Rush</span>' : ''} ${o.is_free ? '<span class="tag tag-free">Free</span>' : ''}</div></div></div></td>
          <td class="hide-sm">${esc(o.shop_name)}</td><td>${pill(o.status)}</td><td class="hide-sm"><div class="row">${avatar(o.assignee_name)}<span class="small">${esc(o.assignee_name || 'Unassigned')}</span></div></td>
          <td>${due(o) || `<span class="small muted">${date(o.due_at)}</span>`}</td><td class="hide-sm num">${o.is_free ? '<span class="muted small">Free</span>' : (money(o.price) || '<span class="muted small">Not set</span>')}${o.paid ? ' <span class="pill st-paid plain">Paid</span>' : ''}</td><td class="hide-sm small muted">${ago(o.updated_at)}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty">${icon('search')}<h3>No orders match</h3><p>Try clearing a filter.</p><a class="btn btn-line btn-sm" href="#/orders">Clear filters</a></div>`}</section>
      ${orders.length >= 300 ? '<p class="small muted" style="margin-top:10px">Showing the first 300. Narrow the filters to see more.</p>' : ''}`;
    wireToolbar(main);
    $$('tr[data-o]', main).forEach(tr => { tr.addEventListener('click', () => openOrder(tr.dataset.o)); tr.addEventListener('keydown', e => e.key === 'Enter' && openOrder(tr.dataset.o)); });
  }

  // ---------------------------------------------------------------- shops
  async function viewShops(main) {
    const { shops } = await get('/team/shops');
    main.innerHTML = `<div class="top"><div><h1>Shops</h1><p class="muted">${shops.length} shops have worked with you.</p></div>${admin() ? `<button class="btn btn-primary" id="inviteShop">${icon('plus')} Invite a shop</button>` : ''}</div>
      <div class="toolbar"><label class="search">${icon('search')}<span class="sr">Search shops</span><input class="input input-sm" id="shopQ" placeholder="Shop name or email"></label></div>
      <section class="card">${shops.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Shop</th><th>Plan</th><th>Orders</th><th class="hide-sm">Open</th><th class="hide-sm">Paid</th><th class="hide-sm">Last order</th><th class="hide-sm">Portal</th></tr></thead><tbody>
      ${shops.map(s => `<tr class="click" data-s="${s.id}" data-find="${esc((s.name + ' ' + (s.email || '')).toLowerCase())}" tabindex="0"><td><div style="font-weight:600;color:var(--ink)">${esc(s.name)}</div><div class="small muted">${esc(s.email || '')}</div></td>
        <td><span class="tag tag-plan">${CX.PLANS[s.plan] || s.plan}</span></td><td class="num">${s.orders}</td><td class="num hide-sm">${s.open_orders}</td><td class="num hide-sm">${money(s.revenue) || '$0'}</td>
        <td class="small muted hide-sm">${s.last_order ? ago(s.last_order) : 'None yet'}</td><td class="hide-sm">${s.active_logins ? '<span class="pill st-delivered">Active</span>' : '<span class="pill st-cancelled">No login yet</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${icon('store')}<h3>No shops yet</h3><p>Shops appear here when they order through the website, sign up, or when you invite them.</p></div>`}</section>`;
    const inv = $('#inviteShop', main);
    inv && inv.addEventListener('click', () => modal(`<h2>Invite a shop</h2><p class="muted small">Creates the shop and a portal login for its owner. You get a link to send them. It works once, for 7 days.</p>
      <form id="isf" style="display:grid;gap:14px" novalidate>
        <label class="field"><span>Shop name</span><input class="input" name="name" required placeholder="Emma Minis"></label>
        <div class="grid2"><label class="field"><span>Contact name</span><input class="input" name="contact" placeholder="Emma"></label>
        <label class="field"><span>Email</span><input class="input" type="email" name="email" required></label></div>
        <div class="grid2"><label class="field"><span>Shop link</span><input class="input" name="url" placeholder="etsy.com/shop/..."></label>
        <label class="field"><span>Plan</span><select class="input" name="plan">${Object.entries(CX.PLANS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>
        <p class="form-msg" role="alert"></p>
        <div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create and get link</button></div></form>`, (box, close) => {
      CX.submit($('#isf', box), async d => {
        const r = await post('/team/shops', d); close(); renderView(false);
        inviteReady(d.contact || d.name, r.link, r.emailed);
      });
    }));
    const sq = $('#shopQ', main);
    sq.addEventListener('input', () => { const v = sq.value.trim().toLowerCase(); $$('tr[data-s]', main).forEach(tr => tr.hidden = v && !tr.dataset.find.includes(v)); });
    $$('tr[data-s]', main).forEach(tr => { tr.addEventListener('click', () => shopModal(tr.dataset.s)); tr.addEventListener('keydown', e => e.key === 'Enter' && shopModal(tr.dataset.s)); });
  }
  function inviteReady(name, link, emailed) {
    const msg = `Hi ${name},\n\nYour CubiX client portal is ready. Set your password here:\n${link}\n\nIn the portal you can send new orders, approve previews and download your print ready files. Your first model is free.\n\nThe link works once and expires in 7 days.`;
    modal(`<h2>Invite ready</h2><p class="muted small">${emailed ? 'We emailed the invite. You can also send it yourself.' : 'Send this to the shop by email, Etsy message or WhatsApp.'}</p>
      <div class="copybox"><span class="grow">${esc(link)}</span><button class="btn btn-dark btn-sm" data-copy="link">${icon('copy')} Copy link</button></div>
      <label class="field"><span>Ready to send message</span><textarea class="input" readonly style="min-height:170px">${esc(msg)}</textarea></label>
      <div class="modal-actions"><button class="btn btn-line" data-close>Done</button><button class="btn btn-primary" data-copy="msg">${icon('copy')} Copy message</button></div>`, box => {
      $$('[data-copy]', box).forEach(b => b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy === 'msg' ? msg : link); b.innerHTML = icon('check') + ' Copied'; } catch { CX.toast('Select the text and copy it manually.', true); }
      }));
    });
  }
  async function shopModal(id) {
    let d, shopRules = []; try { [d, shopRules] = await Promise.all([get('/team/shops/' + id), get('/team/rules?shop=' + id).then(x => x.rules)]); } catch (e) { return fail(e); }
    const s = d.shop;
    modal(`<div class="row" style="justify-content:space-between;align-items:flex-start"><div><h2>${esc(s.name)}</h2>${s.url ? `<p class="small muted ellipsis" style="max-width:340px">${esc(s.url)}</p>` : ''}</div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="grid2"><label class="field"><span>Plan</span><select class="input" id="sPlan" ${admin() ? '' : 'disabled'}>${Object.entries(CX.PLANS).map(([k, l]) => `<option value="${k}" ${s.plan === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="field"><span>First free model</span><div class="input" style="display:flex;align-items:center;background:var(--surface)">${s.free_used ? 'Used' : 'Not used yet'}</div></div></div>
      <label class="field"><span>Notes for the team</span><textarea class="input" id="sNotes" ${admin() ? '' : 'disabled'} placeholder="Style preferences, volume, how they like to be contacted">${esc(s.notes || '')}</textarea></label>
      ${admin() ? '<div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-dark btn-sm" id="sSave">Save shop</button></div>' : ''}
      <div><div class="row" style="justify-content:space-between"><span class="label">Build rules for this shop</span>${admin() ? '<button type="button" class="link small" id="addShopRule">Add a rule</button>' : ''}</div>
        <div style="display:grid;gap:8px;margin-top:8px">${shopRules.map(r => `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#f6f3ff"><div class="row" style="justify-content:space-between"><b class="small" style="color:var(--ink)">${esc(r.title)}</b>${admin() ? `<button type="button" class="link small" data-delsr="${r.id}" style="color:var(--bad)">Delete</button>` : ''}</div><p class="small" style="white-space:pre-wrap;margin-top:3px">${esc(r.body)}</p></div>`).join('') || '<p class="small muted">None yet. Add the specs this shop always wants (base, wall thickness, colors, printer).</p>'}</div></div>
      <div><span class="label">People</span><div style="display:grid;gap:8px;margin-top:8px">${d.users.map(u => `<div class="row" style="padding:10px 12px;border:1px solid var(--line);border-radius:12px">${avatar(u.name)}<div class="grow"><b class="small" style="color:var(--ink)">${esc(u.name)}</b><div class="small muted ellipsis">${esc(u.email)}</div></div>
        ${u.has_login ? `<span class="small muted">${u.last_login_at ? 'Seen ' + ago(u.last_login_at) : 'Has login'}</span>` : ''}${admin() ? `<button class="btn btn-line btn-sm" data-link="${u.id}">${icon('link')} ${u.has_login ? 'Reset link' : 'Login link'}</button>` : ''}</div>`).join('')}</div></div>
      <div><span class="label">Orders</span><div style="display:grid;gap:6px;margin-top:8px">${d.orders.map(o => `<button class="aitem" style="border:1px solid var(--line);border-radius:12px;padding:10px 12px" data-o="${o.id}"><div class="grow"><div class="ttl ellipsis">${esc(o.title)}</div><div class="sub">${esc(o.code)} · ${date(o.created_at)}</div></div>${pill(o.status)}</button>`).join('') || '<p class="small muted">No orders yet.</p>'}</div></div>`,
    (box, close) => {
      const save = $('#sSave', box);
      save && save.addEventListener('click', async () => { CX.busy(save, true); try { await patch('/team/shops/' + id, { plan: $('#sPlan', box).value, notes: $('#sNotes', box).value }); toast('Shop saved'); close(); renderView(false); } catch (e) { fail(e); CX.busy(save, false); } });
      $$('[data-link]', box).forEach(b => b.addEventListener('click', async () => {
        try { const r = await post(`/team/users/${b.dataset.link}/link`); close(); CX.linkModal('Login link ready', r.emailed ? 'We emailed this link to the shop. You can also send it yourself. It works once, for 3 days.' : 'Send this link to the shop owner by email. It works once, for 3 days.', r.link); }
        catch (e) { fail(e); }
      }));
      $$('[data-o]', box).forEach(b => b.addEventListener('click', () => { close(); openOrder(b.dataset.o); }));
      const asr = $('#addShopRule', box);
      asr && asr.addEventListener('click', () => { close(); modal(`<h2>Rule for ${esc(s.name)}</h2><p class="muted small">Shows at the top of every job from this shop.</p>
        <form id="srf" style="display:grid;gap:14px"><label class="field"><span>Title</span><input class="input" name="title" required placeholder="Always a 3 mm base"></label>
        <label class="field"><span>The rule</span><textarea class="input" name="body" required style="min-height:110px" placeholder="3 mm base plate with the house number engraved. Split roof for multicolor. Bambu A1."></textarea></label>
        <p class="form-msg" role="alert"></p><div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save rule</button></div></form>`, (bx, c2) => {
        CX.submit($('#srf', bx), async dd => { await post('/team/rules', { ...dd, scope: 'shop', shop_id: id }); c2(); toast('Shop rule saved'); shopModal(id); });
      }); });
      $$('[data-delsr]', box).forEach(b => b.addEventListener('click', async () => { await post(`/team/rules/${b.dataset.delsr}/delete`); close(); toast('Rule deleted'); shopModal(id); }));
    });
  }

  // ---------------------------------------------------------------- team members
  async function viewTeam(main) {
    await loadMembers(); const ov = await refreshOverview();
    const load = id => (ov.team.find(t => t.id === id) || { open: 0, delivered_7d: 0 });
    main.innerHTML = `<div class="top"><div><h1>Team</h1><p class="muted">Capacity is how many open orders each person can carry at once.</p></div>${admin() ? `<button class="btn btn-primary" id="addM">${icon('plus')} Add team member</button>` : ''}</div>
      <section class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Load</th><th>Capacity</th><th class="hide-sm">Delivered, 7 days</th><th class="hide-sm">Last seen</th>${admin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${S.members.map(m => { const l = load(m.id), r = m.capacity ? l.open / m.capacity : 0; return `<tr style="${m.active ? '' : 'opacity:.55'}"><td><div class="row">${avatar(m.name)}<div><div style="font-weight:600;color:var(--ink)">${esc(m.name)}${m.id === S.me.id ? ' <span class="small muted">(you)</span>' : ''}</div><div class="small muted">${esc(m.email)}</div></div></div></td>
        <td>${admin() && m.id !== S.me.id ? `<select class="input input-sm" data-role="${m.id}" aria-label="Role" style="width:auto"><option value="modeler" ${m.role === 'modeler' ? 'selected' : ''}>Modeler</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option></select>` : (m.role === 'admin' ? 'Admin' : 'Modeler')}</td>
        <td style="min-width:130px"><div class="small num" style="margin-bottom:5px">${l.open} open</div><div class="bar thin ${capClass(r)}"><i style="width:${Math.min(100, r * 100)}%"></i></div></td>
        <td>${admin() ? `<input class="input input-sm num" type="number" min="1" max="50" value="${m.capacity}" data-cap="${m.id}" aria-label="Capacity for ${esc(m.name)}" style="width:80px">` : m.capacity}</td>
        <td class="num hide-sm">${l.delivered_7d || 0}</td><td class="small muted hide-sm">${m.has_login ? (m.last_login_at ? ago(m.last_login_at) : 'Never') : 'Invite pending'}</td>
        ${admin() ? `<td style="text-align:right;white-space:nowrap">${!m.has_login ? `<button class="btn btn-line btn-sm" data-relink="${m.id}">${icon('link')} Link</button> ` : ''}${m.id !== S.me.id ? `<button class="btn btn-ghost btn-sm" data-active="${m.id}" data-on="${m.active ? 0 : 1}">${m.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>` : ''}</tr>`; }).join('')}
      </tbody></table></div></section>`;
    if (!admin()) return;
    $('#addM', main).addEventListener('click', () => modal(`<h2>Add team member</h2><p class="muted small">They get a link to set their password. Modelers can claim and work orders. Admins can also set prices, payments and manage the team.</p>
      <form id="mf" style="display:grid;gap:14px"><label class="field"><span>Name</span><input class="input" name="name" required></label><label class="field"><span>Email</span><input class="input" type="email" name="email" required></label>
      <div class="grid2"><label class="field"><span>Role</span><select class="input" name="role"><option value="modeler">Modeler</option><option value="admin">Admin</option></select></label><label class="field"><span>Capacity</span><input class="input" type="number" name="capacity" min="1" max="50" value="4"></label></div>
      <p class="form-msg" role="alert"></p><div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">Add and get link</button></div></form>`, (box, close) => {
      CX.submit($('#mf', box), async d => { const r = await post('/team/members', d); close(); renderView(false); CX.linkModal('Invite ready', r.emailed ? `We emailed ${d.email} an invite. You can also send this link yourself.` : `Send this link to ${d.email}. It works once, for 3 days.`, r.link); });
    }));
    $$('[data-cap]', main).forEach(i => i.addEventListener('change', async () => { try { await patch('/team/members/' + i.dataset.cap, { capacity: +i.value }); toast('Capacity updated'); refreshOverview(); } catch (e) { fail(e); renderView(false); } }));
    $$('[data-role]', main).forEach(i => i.addEventListener('change', async () => { try { await patch('/team/members/' + i.dataset.role, { role: i.value }); toast('Role updated'); } catch (e) { fail(e); renderView(false); } }));
    $$('[data-active]', main).forEach(b => b.addEventListener('click', async () => {
      const on = b.dataset.on === '1';
      if (!on && !(await CX.confirm('Deactivate this person?', 'They are signed out right away and cannot sign in. Their orders stay assigned until you move them.', 'Deactivate'))) return;
      try { await patch('/team/members/' + b.dataset.active, { active: on }); toast(on ? 'Reactivated' : 'Deactivated'); renderView(false); } catch (e) { fail(e); }
    }));
    $$('[data-relink]', main).forEach(b => b.addEventListener('click', async () => { try { const r = await post(`/team/users/${b.dataset.relink}/link`); CX.linkModal('New invite link', 'Send this link to them. It works once, for 3 days.', r.link); } catch (e) { fail(e); } }));
  }

  // ---------------------------------------------------------------- order drawer
  let drawerId = null;
  function syncDrawer(id) {
    if (!id) { closeDrawerDom(); return; }
    if (id !== drawerId) renderDrawer(id);
  }
  const killViewers = () => { (S.viewers || []).forEach(v => { try { v.destroy(); } catch {} }); S.viewers = []; };
  function closeDrawerDom() { killViewers(); drawerId = null; $('.drawer') && $('.drawer').remove(); $('.drawer-bg') && $('.drawer-bg').remove(); document.removeEventListener('keydown', drawerKey); }
  const drawerKey = e => { if (e.key === 'Escape' && !$('.modal')) setQ({ o: '' }); };
  const toLocal = iso => { const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  async function renderDrawer(id, keepScroll) {
    drawerId = id;
    let dr = $('.drawer');
    if (!dr) {
      document.body.insertAdjacentHTML('beforeend', `<div class="drawer-bg"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Order"><div class="drawer-head"><div class="grow"><div class="sk" style="height:26px;width:60%"></div></div></div><div class="drawer-body"><div class="sk" style="height:200px"></div></div></aside>`);
      dr = $('.drawer');
      $('.drawer-bg').addEventListener('click', () => setQ({ o: '' }));
      document.addEventListener('keydown', drawerKey);
    }
    let o;
    try { o = (await get('/team/orders/' + id)).order; } catch (e) { if (drawerId === id) { setQ({ o: '' }); fail(e); } return; }
    if (drawerId !== id) return;
    const scroll = keepScroll ? $('.drawer-body', dr).scrollTop : 0;
    killViewers();
    const mine = o.assignee_id === S.me.id;
    const canAssign = admin() ? S.members.filter(m => m.active) : S.members.filter(m => m.id === S.me.id || m.id === o.assignee_id);
    const groups = { reference: [], preview: [], final: [] }; o.files.forEach(f => groups[f.kind].push(f));
    const fileTile = f => `<div class="file"><a href="${CX.fileUrl(f.id)}" title="Download ${esc(f.name)}" style="display:grid;gap:6px;text-decoration:none"><span class="fprev">${CX.isImg(f) ? `<img src="${CX.thumbUrl(f.id)}" alt="" loading="lazy">` : esc(CX.ext(f.name))}</span><span class="fname">${esc(f.name)}</span></a><span class="small muted">${CX.size(f.size)}${f.released === 0 ? ' · held for QC' : ''}</span>${CX.isModel(f.name) ? `<button type="button" class="link small" data-3d="${f.id}" data-name="${esc(f.name)}" style="justify-self:start">View in 3D</button>` : ''}</div>`;
    const models = o.files.filter(f => CX.isModel(f.name) && f.kind !== 'reference');
    const lastModel = models.filter(f => f.kind === 'preview' && f.released !== 0).sort((a, b) => b.version - a.version || (b.created_at > a.created_at ? 1 : -1))[0] || models[models.length - 1];
    const unread = o.client_msg_at && o.client_msg_at > (o.team_seen_at || '');
    const lastClientMsg = [...o.messages].reverse().find(m => m.author_role === 'client');
    const reqs = o.requests || [], cur = reqs[reqs.length - 1];
    const held = o.files.filter(f => f.kind === 'preview' && f.released === 0);
    const pinList = (pins, key) => pins.length ? `<ol class="pinlist" data-pins="${key}">${pins.map(p => `<li><button type="button" class="pn" data-pin="${p.n}" aria-label="Show pin ${p.n} on the model">${p.n}</button><p>${esc(p.note || 'No note')}</p></li>`).join('')}</ol>` : '<p class="small muted">No pins on the model.</p>';
    const versions = list => { const by = {}; list.forEach(f => (by[f.version] = by[f.version] || []).push(f)); return Object.keys(by).sort((a, b) => b - a).map(v => `<div class="small muted" style="font-weight:600">Version ${v}${+v === Math.max(...Object.keys(by)) ? ' (latest)' : ''}</div><div class="files">${by[v].map(fileTile).join('')}</div>`).join(''); };
    const quick = [];
    if (!o.assignee_id && ['new', 'confirmed', 'modeling', 'revisions'].includes(o.status)) quick.push(`<button class="btn btn-primary btn-sm" data-act="claim">${icon('plus')} Claim this order</button>`);
    if (o.status === 'confirmed' || o.status === 'new') quick.push(`<button class="btn btn-line btn-sm" data-act="modeling">Start modeling</button>`);
    if (['modeling', 'revisions', 'confirmed', 'new', 'review'].includes(o.status)) quick.push(`<button class="btn btn-dark btn-sm" data-up="preview">${icon('upload')} ${admin() ? 'Send preview' : 'Hand in preview'}</button>`);
    if (['modeling', 'revisions', 'confirmed', 'new'].includes(o.status)) quick.push(`<button class="btn btn-line btn-sm" data-act="ask">${icon('chat')} Ask the client</button>`);
    if (['approved', 'preview', 'modeling', 'revisions', 'delivered', 'paid'].includes(o.status)) quick.push(`<button class="btn ${o.status === 'approved' ? 'btn-ok' : 'btn-line'} btn-sm" data-up="final">${icon('upload')} ${o.status === 'delivered' || o.status === 'paid' ? 'Upload new final files' : 'Deliver final files'}</button>`);
    if (admin() && ['approved', 'delivered'].includes(o.status) && !o.paid) quick.push(`<button class="btn btn-line btn-sm" data-act="paid">${icon('dollar')} Mark paid</button>`);

    dr.innerHTML = `<div class="drawer-head"><div class="grow"><div class="row wrap" style="gap:8px;margin-bottom:6px"><span class="code">${esc(o.code)}</span>${pill(o.status)}${badges(o)}${due(o)}</div>
        <h2>${esc(o.title)}</h2><p class="small muted" style="margin-top:4px"><button class="link" data-shop="${o.shop_id}" style="color:var(--muted)">${esc(o.shop_name)}</button> · <span class="tag tag-plan">${CX.PLANS[o.shop_plan] || ''}</span> · ordered ${ago(o.created_at)} · client due ${dateTime(o.due_at)}${o.ship_by ? ` · ships by ${date(o.ship_by)}` : ''}</p>
        ${o.status === 'preview' ? `<p class="small" style="margin-top:4px;font-weight:600;color:${o.preview_seen_at ? 'var(--ok)' : 'var(--muted)'}">${o.preview_seen_at ? `Client opened the preview ${ago(o.preview_seen_at)}` : 'Client has not opened the preview yet'}</p>` : ''}
        ${o.siblings && o.siblings.length > 1 ? `<div class="siblings" style="margin-top:8px">${o.siblings.map(x => `<a href="#" data-sib="${x.id}" ${x.id === o.id ? 'aria-current="true"' : ''}>${x.item_no} of ${o.item_count}</a>`).join('')}</div>` : ''}</div>
        <button class="icon-btn" id="dClose" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-body">
        ${quick.length ? `<div class="upl">${quick.join('')}</div><div class="progress" id="upProg" hidden><i></i></div>` : ''}
        <input type="file" id="upInput" multiple hidden>
        ${unread ? `<div class="banner-new">${icon('chat')}<div class="grow"><b>New from the client</b> <span class="small muted">${ago(o.client_msg_at)}</span><p>${esc(lastClientMsg ? lastClientMsg.body : 'The client sent files or approved.')}</p></div><button class="btn btn-dark btn-sm" data-act="gotit">${icon('check')} Got it</button></div>` : ''}
        ${o.rules && o.rules.length ? `<section class="rulebox"><h3>This job must have</h3>${o.rules.map(r => `<div class="rule"><b>${esc(r.title)} <small>${r.scope === 'shop' ? 'for ' + esc(o.shop_name) : esc(r.product)}</small></b><p>${esc(r.body)}</p></div>`).join('')}</section>` : ''}
        ${o.status === 'waiting' ? `<div class="waitbox">${icon('clock')}<div class="grow"><b>Waiting on the client since ${ago(o.paused_at)}</b><div class="small muted">The clock is paused. It restarts by itself when the client answers.</div></div><button class="btn btn-line btn-sm" data-act="resume">Resume now</button></div>` : ''}
        ${o.status === 'review' ? `<section class="qcbox"><div class="row wrap" style="justify-content:space-between"><h3>${icon('shield')} QC check, round ${o.round}</h3><span class="small muted">The client sees nothing until it passes</span></div>
          ${held.length ? `<div class="files">${held.map(fileTile).join('')}</div>` : '<p class="small muted">No held preview files.</p>'}
          ${admin() ? `<div class="row wrap"><button class="btn btn-ok btn-sm" data-act="qcpass">${icon('check')} Pass and send to the client</button><button class="btn btn-line btn-sm" data-act="qcback">Send back to the modeler</button></div>` : '<p class="small">An admin checks this before it goes to the client.</p>'}</section>` : ''}
        ${cur ? `<section class="roundbox"><div class="row wrap" style="justify-content:space-between"><h3>What to change, round ${cur.round}</h3><span class="small muted">${esc(cur.author || 'Client')} · ${ago(cur.created_at)}</span></div>
          ${lastModel ? `<p class="small">Start from the last round: <a href="${CX.fileUrl(lastModel.id)}" style="font-weight:600">${esc(lastModel.name)}</a></p>` : ''}
          <div style="display:grid;gap:10px"><p style="white-space:pre-wrap;font-size:14.5px">${esc(cur.body)}</p>${cur.pins.length ? pinList(cur.pins, 'cur') : ''}
            ${o.files.filter(f => f.request_id === cur.id).length ? `<div class="files">${o.files.filter(f => f.request_id === cur.id).map(fileTile).join('')}</div>` : ''}</div>
          ${reqs.length > 1 ? `<details><summary class="small" style="cursor:pointer;font-weight:600">Earlier requests (${reqs.length - 1})</summary><div style="display:grid;gap:12px;margin-top:10px">${reqs.slice(0, -1).reverse().map(r => `<div style="padding:10px 12px;background:#fff;border-radius:10px;border:1px solid var(--line)"><b class="small">Round ${r.round} · ${date(r.created_at)}</b><p style="white-space:pre-wrap;font-size:13.5px;margin:4px 0 6px">${esc(r.body)}</p>${r.pins.length ? r.pins.map(p => `<div class="small muted">Pin ${p.n}: ${esc(p.note || 'No note')}</div>`).join('') : ''}</div>`).join('')}</div></details>` : ''}
        </section>` : ''}
        ${CX.roundModels(o, true).length ? `<section class="card"><div class="card-head"><h3>Model and comments</h3><span class="small muted">${(() => { const ms = CX.roundModels(o, true); return `${ms[0].kind === 'final' ? 'Final' : 'Preview'} version ${ms[0].version}${ms.length > 1 ? `, ${ms.length} parts` : ''}`; })()}</span></div><div id="trv"></div></section>` : ''}
        <section class="card card-pad"><div class="ctrls">
          <label class="field"><span>Status</span><select class="input input-sm" data-set="status">${Object.entries(CX.STATUS).map(([k, l]) => `<option value="${k}" ${o.status === k ? 'selected' : ''} ${k === 'paid' && !admin() ? 'disabled' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Modeler</span><select class="input input-sm" data-set="assignee_id"><option value="">Unassigned</option>${canAssign.map(m => `<option value="${m.id}" ${o.assignee_id === m.id ? 'selected' : ''}>${esc(m.name)}${m.id === S.me.id ? ' (me)' : ''}</option>`).join('')}</select></label>
          <label class="field"><span>Priority</span><select class="input input-sm" data-set="priority"><option value="normal">Normal</option><option value="rush" ${o.priority === 'rush' ? 'selected' : ''}>Rush</option></select></label>
          <label class="field"><span>Client due</span><input class="input input-sm" type="datetime-local" data-set="due_at" value="${toLocal(o.due_at)}"></label>
        </div>
        <div class="ctrls" style="margin-top:12px;grid-template-columns:1fr 1fr">
          <label class="field"><span>Hand in by</span><input class="input input-sm" type="datetime-local" data-set="handin_at" value="${o.handin_at ? toLocal(o.handin_at) : ''}" ${admin() ? '' : 'disabled'}></label>
          <label class="field"><span>Shop ships by</span><input class="input input-sm" type="date" data-set="ship_by" value="${o.ship_by ? o.ship_by.slice(0, 10) : ''}"></label>
        </div>
        ${admin() ? `<div class="ctrls" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
          <label class="field"><span>Price (USD)</span><input class="input input-sm num" type="number" min="0" step="1" data-set="price" value="${o.price ?? ''}" placeholder="${o.is_free ? 'Free' : 'Not set'}"></label>
          <label class="field"><span>Paid via</span><select class="input input-sm" data-set="paid_via"><option value="">Not set</option>${PAY_VIA.map(p => `<option ${o.paid_via === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <div class="field"><span>Payment</span><label class="check" style="min-height:36px"><input type="checkbox" data-set="paid" ${o.paid ? 'checked' : ''} ${['approved', 'delivered', 'paid'].includes(o.status) ? '' : 'disabled'}> ${o.paid ? 'Paid' : 'Not paid'}</label></div>
          <div class="field"><span>Revisions</span><div class="input input-sm num" style="background:var(--surface);display:flex;align-items:center">${o.revisions}</div></div></div>` : ''}
        </section>
        <section class="card"><div class="card-head"><h3>Brief</h3></div>
          <dl class="specs">${[['Product', o.product], ['Size', o.size], ['Printer', o.printer], ['Formats', o.formats], ['Came through', o.channel], ['Lead source', o.source], ['Ordered', dateTime(o.created_at)], ['Delivered', o.delivered_at ? dateTime(o.delivered_at) : ''], ['Approved', o.approved_at ? dateTime(o.approved_at) : '']].filter(x => x[1]).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
          ${o.notes ? `<div class="notes"><b class="small" style="color:var(--ink)">Seller's notes</b><br>${esc(o.notes)}</div>` : ''}
          ${o.customer_notes ? `<div class="notes"><b class="small" style="color:var(--ink)">Etsy customer's notes</b><br>${esc(o.customer_notes)}</div>` : ''}</section>
        ${admin() ? `<section class="card"><div class="card-head"><h3>Invoices</h3><button class="btn btn-line btn-sm" data-newinv>${icon('plus')} Create invoice</button></div>
          ${o.invoices && o.invoices.length ? `<div class="alist">${o.invoices.map(i => `<button class="aitem" data-inv="${i.id}"><div class="grow"><div class="ttl">${esc(i.number)}</div><div class="sub">${date(i.issued_at)}</div></div><span class="num small" style="font-weight:600">${esc(i.currency)} ${CX.amount(i.total)}</span>${invPill(i.status)}</button>`).join('')}</div>`
          : `<p class="small muted" style="padding:14px 20px">No invoice yet. ${o.is_free ? 'This is a free model.' : 'Create one from this order in a click.'}</p>`}</section>` : ''}
        <section class="card"><div class="card-head"><h3>Files</h3><span class="small muted">${o.files.length} total</span></div>
          <div class="fgroup"><h4>${icon('file')} From the shop</h4>${groups.reference.length ? `<div class="files">${groups.reference.map(fileTile).join('')}</div>` : '<p class="small muted">No reference files.</p>'}</div>
          <div class="fgroup"><h4>${icon('eye')} Previews</h4>${groups.preview.length ? versions(groups.preview) : '<p class="small muted">No preview sent yet.</p>'}</div>
          <div class="fgroup"><h4>${icon('printer')} Final files</h4>${groups.final.length ? versions(groups.final) : '<p class="small muted">Not delivered yet.</p>'}</div></section>
        <section class="card"><div class="card-head"><h3>Conversation</h3><span class="small muted">Yellow notes are internal</span></div>
          <div class="thread" id="thread">${o.messages.length ? o.messages.map(m => { const team = m.author_role !== 'client'; return `<div class="msg ${team ? 'mine' : 'theirs'} ${m.internal ? 'internal' : ''}"><div class="bub">${esc(m.body)}</div><div class="by">${esc(m.author || 'Shop')}${m.internal ? ' · internal note' : ''} · ${ago(m.created_at)}</div></div>`; }).join('') : '<p class="small muted">No messages yet.</p>'}</div>
          <form class="compose" id="compose"><textarea class="input" name="body" placeholder="Write to ${esc(o.shop_name)} or leave a note for the team" required></textarea>
            <div class="row wrap" style="justify-content:space-between"><label class="check small"><input type="checkbox" name="internal" value="1"> Internal note, the shop will not see it</label><button class="btn btn-dark btn-sm" type="submit">${icon('send')} Send</button></div></form></section>
        <section class="card"><div class="card-head"><h3>History</h3></div><ol class="timeline">${o.events.slice().reverse().map(e => `<li><div><b>${esc(eventText(e))}</b><div class="when">${esc(e.who || 'System')} · ${dateTime(e.created_at)}</div></div></li>`).join('')}</ol></section>
        ${admin() ? `<p style="text-align:center"><button type="button" class="link small" id="delOrder" style="color:var(--bad)">Delete this order</button></p>` : ''}
      </div>`;
    $('.drawer-body', dr).scrollTop = scroll;
    const th = $('#thread', dr); th.scrollTop = th.scrollHeight;
    $('#dClose', dr).addEventListener('click', () => setQ({ o: '' }));
    $('[data-shop]', dr).addEventListener('click', () => shopModal(o.shop_id));
    const changed = async (body, msg) => {
      try { await patch('/team/orders/' + o.id, body); if (msg) toast(msg); refreshOverview(); await renderDrawer(o.id, true); renderView(false); }
      catch (e) { fail(e); renderDrawer(o.id, true); }
    };
    $$('[data-set]', dr).forEach(el => el.addEventListener('change', () => {
      const k = el.dataset.set; let v = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'due_at' || k === 'handin_at') { if (!v) return; v = new Date(v).toISOString(); }
      if (k === 'assignee_id') v = v || null;
      changed({ [k]: v }, 'Saved');
    }));
    $$('[data-act]', dr).forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'claim') changed({ assignee_id: S.me.id }, 'Order is yours');
      if (a === 'modeling') changed({ status: 'modeling' }, 'Moved to modeling');
      if (a === 'paid') changed({ paid: true }, 'Marked as paid');
      if (a === 'gotit') post(`/team/orders/${o.id}/seen`).then(() => { renderDrawer(o.id, true); renderView(false); }).catch(fail);
      if (a === 'resume') post(`/team/orders/${o.id}/resume`).then(() => { toast('Clock running again'); refreshOverview(); renderDrawer(o.id, true); renderView(false); }).catch(fail);
      if (a === 'qcpass') post(`/team/orders/${o.id}/qc`, { action: 'pass' }).then(() => { toast('Passed. The client has the preview now.'); refreshOverview(); renderDrawer(o.id, true); renderView(false); }).catch(fail);
      if (a === 'qcback' || a === 'ask') modal(`<h2>${a === 'ask' ? 'Ask the client' : 'Send back to the modeler'}</h2><p class="muted small">${a === 'ask' ? 'The client gets this in their portal and by email. Your clock pauses until they answer.' : 'The modeler sees this as an internal note. The client sees nothing.'}</p>
        <form id="nf2" style="display:grid;gap:14px"><textarea class="input" name="body" required placeholder="${a === 'ask' ? 'Could you send a photo of the back of the house?' : 'The roof line does not match photo 2. Fix it and hand in again.'}" style="min-height:110px"></textarea>
        <p class="form-msg" role="alert"></p><div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">${a === 'ask' ? 'Send and pause the clock' : 'Send back'}</button></div></form>`, (box, close) => {
        CX.submit($('#nf2', box), async d => {
          if (!d.body.trim()) throw new Error(a === 'ask' ? 'Tell the client what you need.' : 'Tell the modeler what to fix.');
          await post(a === 'ask' ? `/team/orders/${o.id}/ask` : `/team/orders/${o.id}/qc`, a === 'ask' ? { body: d.body } : { action: 'back', note: d.body });
          close(); toast(a === 'ask' ? 'Sent. The clock is paused.' : 'Sent back to the modeler'); refreshOverview(); renderDrawer(o.id, true); renderView(false);
        });
      });
    }));
    $$('[data-sib]', dr).forEach(x => x.addEventListener('click', e => { e.preventDefault(); openOrder(x.dataset.sib); }));
    // 3D viewers: inline for the change request, and in a window for any model file
    $$('[data-mount3d]', dr).forEach(el => CX.loadViewer().then(m => {
      const pins = el.dataset.pinset === 'cur' && cur ? cur.pins : [];
      const v = m.mount(el, { files: [{ url: CX.fileUrl(el.dataset.mount3d), name: el.dataset.name, load: () => CX.fetchFile(el.dataset.mount3d).then(x => x.blob.arrayBuffer()) }], pins });
      (S.viewers = S.viewers || []).push(v);
      $$(`[data-pins="${el.dataset.pinset}"] [data-pin]`, dr).forEach(b => b.addEventListener('click', () => v.focusPin(+b.dataset.pin)));
    }).catch(() => { el.innerHTML = '<p class="small muted">The 3D viewer could not load. Download the file instead.</p>'; }));
    $$('[data-3d]', dr).forEach(b => b.addEventListener('click', () => open3d(b.dataset['3d'], b.dataset.name)));
    const trv = $('#trv', dr);
    if (trv) (S.viewers = S.viewers || []).push(CX.review(trv, { order: o, files: CX.roundModels(o, true), role: 'team', canComment: true, load: async () => (await get('/team/orders/' + o.id)).order }));
    const del = $('#delOrder', dr);
    del && del.addEventListener('click', async () => {
      if (!(await CX.confirm(`Delete ${o.code}?`, 'The order, its files, messages and history are removed for good. Use this for spam, tests or duplicates.', 'Delete order'))) return;
      try { await post(`/team/orders/${o.id}/delete`); toast(`${o.code} deleted`); setQ({ o: '' }); refreshOverview(); renderView(false); } catch (e) { fail(e); }
    });
    const ni = $('[data-newinv]', dr);
    ni && ni.addEventListener('click', async () => { CX.busy(ni, true); try { const r = await post('/team/invoices', { order_id: o.id }); invoiceEditor(r.invoice.id, () => renderDrawer(o.id, true)); } catch (e) { fail(e); } finally { CX.busy(ni, false); } });
    $$('[data-inv]', dr).forEach(b => b.addEventListener('click', () => invoiceEditor(b.dataset.inv, () => renderDrawer(o.id, true))));
    const inp = $('#upInput', dr); let kind = 'preview';
    // any file type: STL, 3MF, OBJ, GLB, renders, PDFs. Several part files (ground floor, upper floor, roof) go up together as one round.
    $$('[data-up]', dr).forEach(b => b.addEventListener('click', () => { kind = b.dataset.up; inp.removeAttribute('accept'); inp.click(); }));
    inp.addEventListener('change', async () => {
      if (!inp.files.length) return;
      const picked = [...inp.files]; inp.value = '';
      if (picked.some(x => x.size > 100 * 1024 * 1024)) return toast('Each file must be under 100 MB.', true);
      const prog = $('#upProg', dr); prog.hidden = false; $$('[data-up],[data-act]', dr).forEach(b => b.disabled = true);
      try {
        const ids = await CX.uploadFiles(picked, p => { prog.firstElementChild.style.width = (p * 100) + '%'; });
        const r = await post(`/team/orders/${o.id}/files`, { kind, upload_ids: ids });
        toast(kind === 'final' ? 'Final files delivered. The shop can download them now.' : r.status === 'review' ? `Version ${r.version} handed in for QC` : `Preview version ${r.version} sent to the shop`);
        refreshOverview(); await renderDrawer(o.id, true); renderView(false);
      } catch (e) { fail(e); prog.hidden = true; $$('[data-up],[data-act]', dr).forEach(b => b.disabled = false); }
    });
    CX.submit($('#compose', dr), async d => {
      if (!d.body.trim()) throw new Error('Write a message first.');
      await post(`/team/orders/${o.id}/messages`, { body: d.body, internal: !!d.internal });
      toast(d.internal ? 'Note saved' : 'Message sent'); await renderDrawer(o.id, true);
    });
  }
  function eventText(e) {
    const map = { qc: e.detail || 'QC check', waiting: e.detail || 'Asked the client', resumed: e.detail || 'Clock resumed', invoice: e.detail || 'Invoice', files: e.detail || 'Files added', handin: 'Hand in time changed', ship_by: e.detail || 'Ship by date changed', created: 'Order placed', approved: 'Shop approved the preview', revision: 'Shop asked for changes', preview: 'Preview sent', delivered: 'Final files delivered', assigned: 'Assigned to ' + (e.detail || ''), status: 'Status changed' };
    let t = map[e.type] || e.type.replace(/_/g, ' ');
    if (e.type === 'status' && e.detail) { const [a, b] = e.detail.split(' to '); t = `Moved from ${CX.STATUS[a] || a} to ${CX.STATUS[b] || b}`; }
    else if (['preview', 'delivered', 'revision', 'created'].includes(e.type) && e.detail) t += ': ' + e.detail;
    else if (!map[e.type] && e.detail) t = e.detail.replace(/_/g, ' ');
    return t;
  }

  // ---------------------------------------------------------------- handbook (standing build rules per product)
  async function viewHandbook(main) {
    const { rules, products } = await get('/team/rules');
    const groups = {}; rules.forEach(r => (groups[r.product || 'All'] = groups[r.product || 'All'] || []).push(r));
    main.innerHTML = `<div class="top"><div><h1>Handbook</h1><p class="muted">The standing build rules, per product. They show at the top of every matching job. Rules for a single shop live in that shop's page.</p></div>
        ${admin() ? `<button class="btn btn-primary" id="addRule">${icon('plus')} Add a rule</button>` : ''}</div>
      <div class="handbook">${rules.length ? Object.keys(groups).sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b)).map(g => `<section class="card"><div class="card-head"><h2>${esc(g === 'All' ? 'Every job' : g)}</h2><span class="small muted">${groups[g].length} rule${groups[g].length > 1 ? 's' : ''}</span></div>
        ${groups[g].map(r => `<div class="rulecard" style="border-top:1px solid var(--line)"><div class="row" style="justify-content:space-between"><b style="color:var(--ink)">${esc(r.title)}</b>${admin() ? `<span class="row"><button class="link small" data-edit="${r.id}">Edit</button><button class="link small" data-del="${r.id}" style="color:var(--bad)">Delete</button></span>` : ''}</div>
          <p>${esc(r.body)}</p><span class="small muted">Last changed ${date(r.updated_at)}${r.updated_by_name ? ` by ${esc(r.updated_by_name)}` : ''}</span></div>`).join('')}</section>`).join('')
        : `<div class="card empty">${icon('note')}<h3>No rules yet</h3><p>Write down how each product is built (wall thickness, hollow or solid, how windows are cut) so every modeler gets it right the first time.</p></div>`}</div>`;
    const editor = r => modal(`<h2>${r ? 'Edit rule' : 'Add a rule'}</h2>
      <form id="rf" style="display:grid;gap:14px"><label class="field"><span>Product</span><input class="input" name="product" list="prodList" value="${esc(r ? r.product : '')}" placeholder="House replica, or All for every job"><datalist id="prodList"><option value="All">${products.map(p => `<option value="${esc(p)}">`).join('')}</datalist><small>Must match the product name on orders. Use All for every job.</small></label>
      <label class="field"><span>Title</span><input class="input" name="title" required value="${esc(r ? r.title : '')}" placeholder="Hollow body, open underneath"></label>
      <label class="field"><span>The rule</span><textarea class="input" name="body" required style="min-height:130px" placeholder="Walls 2 mm. Open underneath. Every window cut through. One watertight mesh.">${esc(r ? r.body : '')}</textarea></label>
      <p class="form-msg" role="alert"></p><div class="modal-actions"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save rule</button></div></form>`, (box, close) => {
      CX.submit($('#rf', box), async d => { if (r) await patch('/team/rules/' + r.id, d); else await post('/team/rules', { ...d, scope: 'product' }); close(); toast('Rule saved'); renderView(false); });
    });
    const add = $('#addRule', main); add && add.addEventListener('click', () => editor(null));
    $$('[data-edit]', main).forEach(b => b.addEventListener('click', () => editor(rules.find(r => r.id === b.dataset.edit))));
    $$('[data-del]', main).forEach(b => b.addEventListener('click', async () => { if (!(await CX.confirm('Delete this rule?', 'It disappears from the handbook and from every job.', 'Delete'))) return; await post(`/team/rules/${b.dataset.del}/delete`); toast('Rule deleted'); renderView(false); }));
  }

  // ---------------------------------------------------------------- invoices
  const INV = { draft: 'Draft', sent: 'Sent', paid: 'Paid', void: 'Void' };
  const invPill = st => `<span class="pill inv-${st}">${INV[st] || st}</span>`;
  async function viewInvoices(main, q) {
    const st = q.get('status') || '';
    const { invoices, sums } = await get('/team/invoices' + (st ? '?status=' + st : ''));
    main.innerHTML = `<div class="top"><div><h1>Invoices</h1><p class="muted">Bill shops, share a link they can open or save as PDF, and track payment.</p></div>
        <div class="row wrap"><button class="btn btn-line" id="invSettings">${icon('note')} Invoice details</button><button class="btn btn-primary" id="invNew">${icon('plus')} New invoice</button></div></div>
      <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="kpi"><span class="k-label">${icon('card')}Outstanding</span><span class="k-val">${money(sums.outstanding) || '$0'}</span><span class="k-sub">${sums.outstanding_n || 0} sent, not paid yet</span></div>
        <div class="kpi"><span class="k-label">${icon('dollar')}Paid this month</span><span class="k-val">${money(sums.paid_month) || '$0'}</span><span class="k-sub">From paid invoices</span></div>
        <div class="kpi"><span class="k-label">${icon('file')}Invoices</span><span class="k-val">${invoices.length}</span><span class="k-sub">${st ? INV[st] : 'All statuses'}</span></div></div>
      <div class="toolbar"><div class="seg" role="group" aria-label="Filter">${[['', 'All'], ['draft', 'Drafts'], ['sent', 'Sent'], ['paid', 'Paid'], ['void', 'Void']].map(([k, l]) => `<button type="button" data-st="${k}" aria-pressed="${st === k}">${l}</button>`).join('')}</div></div>
      <section class="card">${invoices.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Invoice</th><th>Billed to</th><th class="hide-sm">Project</th><th>Total</th><th>Status</th><th class="hide-sm">Issued</th></tr></thead><tbody>
        ${invoices.map(i => `<tr class="click" data-i="${i.id}" tabindex="0"><td style="font-weight:600;color:var(--ink)">${esc(i.number)}</td><td>${esc(i.bill_name)}</td>
          <td class="hide-sm small muted">${esc(i.project_title || '')}${i.order_code ? ` · ${esc(i.order_code)}` : ''}</td><td class="num">${esc(i.currency)} ${CX.amount(i.total)}</td><td>${invPill(i.status)}</td><td class="small muted hide-sm">${date(i.issued_at)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${icon('file')}<h3>No invoices ${st ? 'here' : 'yet'}</h3><p>Create one from an order (open the order, then Create invoice) or start a blank one.</p></div>`}</section>`;
    $$('[data-st]', main).forEach(b => b.addEventListener('click', () => setQ({ status: b.dataset.st })));
    $$('tr[data-i]', main).forEach(tr => { const open = () => invoiceEditor(tr.dataset.i, () => renderView(false)); tr.addEventListener('click', open); tr.addEventListener('keydown', e => e.key === 'Enter' && open()); });
    $('#invSettings', main).addEventListener('click', () => { location.hash = '#/settings'; });
    $('#invNew', main).addEventListener('click', async () => {
      const { shops } = await get('/team/shops');
      if (!shops.length) return toast('Add or invite a shop first.', true);
      modal(`<h2>New invoice</h2><p class="muted small">Pick the shop to bill. To bill a specific order, open that order and use Create invoice instead.</p>
        <label class="field"><span>Shop</span><select class="input" id="nsShop">${shops.map(x => `<option value="${x.id}">${esc(x.name)}${x.email ? ` (${esc(x.email)})` : ''}</option>`).join('')}</select></label>
        <div class="modal-actions"><button class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" id="nsGo">Create draft</button></div>`, (box, close) => {
        $('#nsGo', box).addEventListener('click', async e => { CX.busy(e.currentTarget, true); try { const r = await post('/team/invoices', { shop_id: $('#nsShop', box).value }); close(); renderView(false); invoiceEditor(r.invoice.id, () => renderView(false)); } catch (err) { fail(err); CX.busy(e.currentTarget, false); } });
      });
    });
  }
  async function viewSettings(main) {
    const { settings: st, status } = await get('/team/settings');
    const pct = status.storage.limit ? Math.min(100, status.storage.bytes / status.storage.limit * 100) : 0;
    const dot = on => `<span class="pill ${on ? 'st-delivered' : 'st-cancelled'}">${on ? 'Connected' : 'Not connected'}</span>`;
    main.innerHTML = `<div class="top"><div><h1>Settings</h1><p class="muted">Notifications, invoices, payments, storage and backups. Admins only.</p></div></div>
      <form id="setf" class="settings" novalidate>
      <section class="card"><div class="card-head"><h2>${icon('mail')} Email</h2>${dot(status.email_ready)}</div><div class="card-pad set-grid">
        <p class="small muted set-wide">${status.email_ready ? 'Clients get emails for order received, preview ready, files ready, new messages and invoices. Your team gets alerts for new orders, messages, approvals and change requests.'
          : status.resend_key ? 'The Resend key is in place. Add the sender address below to switch email on.' : 'Email needs a free Resend account. Once its key is added in Cloudflare (see the setup guide), every email below switches on by itself.'}</p>
        <label class="field"><span>Sender address</span><input class="input" name="mail_from" value="${esc(st.mail_from)}" placeholder="CubiX <orders@axys3d.com>"><small>Must use a domain verified in Resend.</small></label>
        <label class="field"><span>Team alert emails</span><input class="input" name="alert_email" value="${esc(st.alert_email)}" placeholder="rizwan@..., attiq@..."><small>Comma separated. Empty means every admin.</small></label>
        <div class="set-wide"><button type="button" class="btn btn-line btn-sm" id="testEmail">${icon('send')} Send me a test email</button></div></div></section>
      <section class="card"><div class="card-head"><h2>${icon('zap')} Instant team alerts</h2>${dot(status.webhook)}</div><div class="card-pad set-grid">
        <p class="small muted set-wide">Paste a Slack, Discord or Google Chat webhook link. The channel gets a message for every new order, client message, approval, change request and new shop.</p>
        <label class="field set-wide"><span>Webhook link</span><input class="input" name="alert_webhook" value="${esc(st.alert_webhook)}" placeholder="https://hooks.slack.com/services/... or https://discord.com/api/webhooks/..."></label>
        <details class="set-wide small muted"><summary style="cursor:pointer;font-weight:600">How do I get a webhook link?</summary><p style="margin-top:8px"><b>Discord:</b> channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.<br><b>Slack:</b> api.slack.com/apps, Create New App, Incoming Webhooks, turn on, Add New Webhook, pick the channel, copy the link.<br><b>Google Chat:</b> space name, Apps and integrations, Webhooks, Add.</p></details>
        <div class="set-wide"><button type="button" class="btn btn-line btn-sm" id="testAlert">${icon('zap')} Send a test alert</button></div></div></section>
      <section class="card"><div class="card-head"><h2>${icon('shield')} Review before the seller</h2><span class="pill ${st.qc_enabled === '1' ? 'st-delivered' : 'st-cancelled'}">${st.qc_enabled === '1' ? 'On' : 'Off'}</span></div><div class="card-pad set-grid">
        <p class="small muted set-wide">When on, a modeler's preview waits in "In review" until an admin passes it. When off, previews go straight to the seller (admins' previews always do).</p>
        <label class="field"><span>Admin check before previews go out</span><select class="input" name="qc_enabled"><option value="0" ${st.qc_enabled !== '1' ? 'selected' : ''}>Off, send straight to the seller</option><option value="1" ${st.qc_enabled === '1' ? 'selected' : ''}>On, an admin checks first</option></select></label></div></section>
      <section class="card"><div class="card-head"><h2>${icon('file')} Invoice details</h2></div><div class="card-pad set-grid">
        <label class="field"><span>Business name</span><input class="input" name="biz_name" value="${esc(st.biz_name)}" required></label>
        <label class="field"><span>Tagline</span><input class="input" name="biz_tagline" value="${esc(st.biz_tagline)}"></label>
        <label class="field"><span>Email on invoices</span><input class="input" type="email" name="biz_email" value="${esc(st.biz_email)}"></label>
        <label class="field"><span>Website</span><input class="input" name="biz_website" value="${esc(st.biz_website)}"></label>
        <label class="field set-wide"><span>Address or tax details (optional)</span><textarea class="input" name="biz_address" style="min-height:64px">${esc(st.biz_address)}</textarea></label>
        <label class="field"><span>Invoice number prefix</span><input class="input" name="invoice_prefix" value="${esc(st.invoice_prefix)}" maxlength="10"></label>
        <label class="field"><span>Default terms</span><input class="input" name="terms" value="${esc(st.terms)}"></label>
        <label class="field set-wide"><span>Default payment note</span><textarea class="input" name="payment_note">${esc(st.payment_note)}</textarea></label>
        <label class="field set-wide"><span>Default confidentiality note</span><textarea class="input" name="notes">${esc(st.notes)}</textarea></label></div></section>
      <section class="card"><div class="card-head"><h2>${icon('card')} Online payment</h2>${dot(!!st.paypal_me)}</div><div class="card-pad set-grid">
        <p class="small muted set-wide">With a PayPal.me name, every sent invoice shows a "Pay with PayPal" button for the exact amount. For Payoneer or Stripe, paste a payment request link into the invoice itself (Pay now link).</p>
        <label class="field"><span>PayPal.me name</span><input class="input" name="paypal_me" value="${esc(st.paypal_me)}" placeholder="cubix3d"><small>From paypal.me/<b>name</b>. Leave empty to hide.</small></label></div></section>
      <div class="set-save"><p class="form-msg" role="alert"></p><button class="btn btn-primary" type="submit">Save settings</button></div>
      </form>
      <section class="card" style="margin-top:18px"><div class="card-head"><h2>${icon('layers')} File storage</h2><span class="small muted">${status.storage.backend === 'R2' ? 'Cloudflare R2' : 'Free database storage'}</span></div><div class="card-pad" style="display:grid;gap:10px">
        <div class="row" style="justify-content:space-between"><b class="num" style="color:var(--ink)">${CX.size(status.storage.bytes)}${status.storage.limit ? ' of 5 GB' : ''}</b><span class="small muted">${status.storage.files} files</span></div>
        ${status.storage.limit ? `<div class="bar ${pct > 80 ? 'full' : pct > 60 ? 'mid' : ''}"><i style="width:${Math.max(1, pct)}%"></i></div><p class="small muted">Roughly 1,000 to 2,000 orders fit. When this passes 80%, enable Cloudflare R2 and the switch is one line in the code. Existing files keep working.</p>` : ''}</div></section>
      <section class="card" style="margin-top:18px"><div class="card-head"><h2>${icon('download')} Backups</h2>${dot(status.backup_key)}</div><div class="card-pad" style="display:grid;gap:10px">
        <p class="small muted">A weekly automatic backup of all orders, shops, people, messages, history, invoices and settings is saved to GitHub (kept 90 days). Cloudflare also keeps 7 days of full database history, files included. You can download a copy any time.</p>
        <div><a class="btn btn-line btn-sm" href="/api/backup" download>${icon('download')} Download a backup now</a></div></div></section>`;
    const form = $('#setf', main);
    CX.submit(form, async (d, msg) => { await patch('/team/settings', d); toast('Settings saved'); renderView(false); });
    const test = (btnId, path, okMsg) => $(btnId, main).addEventListener('click', async e => {
      const b = e.currentTarget; CX.busy(b, true);
      try { await patch('/team/settings', CX.formData(form)); const r = await post(path); toast(okMsg(r)); } catch (err) { fail(err); } finally { CX.busy(b, false); }
    });
    test('#testEmail', '/team/settings/test-email', r => `Test email sent to ${r.to}`);
    test('#testAlert', '/team/settings/test-alert', () => 'Test alert sent. Check your channel.');
  }
  async function invoiceEditor(id, onDone) {
    let r; try { r = await get('/team/invoices/' + id); } catch (e) { return fail(e); }
    let inv = r.invoice; const link = r.link, editable = ['draft', 'sent'].includes(inv.status);
    const dis = editable ? '' : 'disabled';
    const itemRow = (it, i) => `<div class="inv-item" data-row="${i}">
      <div class="inv-item-top"><input class="input input-sm" data-k="title" value="${esc(it.title)}" placeholder="Line title, for example Architectural modeling, multicolor ready" ${dis}>
        <input class="input input-sm num" data-k="qty" type="number" min="0" step="1" value="${esc(it.qty)}" aria-label="Quantity" ${dis}>
        <input class="input input-sm num" data-k="rate" type="number" min="0" step="0.01" value="${esc(it.rate)}" aria-label="Rate" ${dis}>
        <span class="num inv-amt" data-amt>${CX.amount((Number(it.qty) || 0) * (Number(it.rate) || 0))}</span>
        ${editable ? `<button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button>` : ''}</div>
      <textarea class="input input-sm" data-k="description" placeholder="Short description" ${dis}>${esc(it.description || '')}</textarea>
      <textarea class="input input-sm" data-k="bullets" placeholder="What is included, one point per line" ${dis}>${esc((it.bullets || []).join('\n'))}</textarea></div>`;
    modal(`<div class="row" style="justify-content:space-between;align-items:flex-start"><div><h2>${esc(inv.number)}</h2><p class="small muted" style="margin-top:4px">${esc(inv.shop_name)}${inv.order_code ? ` · Order ${esc(inv.order_code)}` : ''}</p></div><div class="row">${invPill(inv.status)}<button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div></div>
      <form id="invf" style="display:grid;gap:14px" novalidate>
        <div class="grid2"><label class="field"><span>Billed to</span><input class="input" name="bill_name" value="${esc(inv.bill_name)}" ${dis}></label>
          <label class="field"><span>Billing email</span><input class="input" type="email" name="bill_email" value="${esc(inv.bill_email || '')}" ${dis}></label></div>
        <div class="grid2"><label class="field"><span>Project</span><input class="input" name="project_title" value="${esc(inv.project_title || '')}" ${dis}></label>
          <label class="field"><span>Reference</span><input class="input" name="project_ref" value="${esc(inv.project_ref || '')}" ${dis}></label></div>
        <div class="inv-grid4"><label class="field"><span>Issued</span><input class="input" type="date" name="issued_at" value="${esc(inv.issued_at.slice(0, 10))}" ${dis}></label>
          <label class="field"><span>Terms</span><input class="input" name="terms" value="${esc(inv.terms || '')}" ${dis}></label>
          <label class="field"><span>Currency</span><input class="input" name="currency" value="${esc(inv.currency)}" maxlength="3" ${dis}></label>
          <label class="field"><span>Tax %</span><input class="input num" type="number" min="0" max="100" step="0.01" name="tax_rate" value="${esc(inv.tax_rate)}" ${dis}></label></div>
        <div class="field"><span>Line items</span><div class="inv-items" id="items">${inv.items.map(itemRow).join('')}</div>
          ${editable ? `<button type="button" class="btn btn-line btn-sm" id="addItem" style="justify-self:start">${icon('plus')} Add line</button>` : ''}</div>
        <div class="inv-total"><span class="muted small">Subtotal <b class="num" id="tSub"></b> · Tax <b class="num" id="tTax"></b></span><span>Total <b class="num" id="tTot"></b></span></div>
        <label class="field"><span>Pay now link (optional)</span><input class="input" name="pay_url" value="${esc(inv.pay_url || '')}" placeholder="https://... a Payoneer, Stripe or PayPal payment request for this invoice" ${dis}><small>Shows a Pay now button on the invoice. Your PayPal.me (Settings) is shown automatically when set.</small></label>
        <label class="field"><span>Payment note</span><textarea class="input" name="payment_note" ${dis}>${esc(inv.payment_note || '')}</textarea></label>
        <label class="field"><span>Confidentiality note</span><textarea class="input" name="notes" style="min-height:64px" ${dis}>${esc(inv.notes || '')}</textarea></label>
        <p class="form-msg" role="alert"></p>
        <div class="modal-actions" style="justify-content:space-between">
          <div class="row wrap">${inv.status === 'draft' ? '<button type="button" class="btn btn-ghost" data-a="void">Delete draft</button>' : inv.status === 'sent' ? '<button type="button" class="btn btn-ghost" data-a="void">Void</button>' : ''}</div>
          <div class="row wrap"><button type="button" class="btn btn-line" data-a="preview">${icon('eye')} ${editable ? 'Preview' : 'Open'}</button>
            ${editable ? `<button type="button" class="btn btn-line" data-a="save">Save</button>` : ''}
            ${inv.status === 'sent' ? `<button type="button" class="btn btn-ok" data-a="paid">${icon('check')} Mark paid</button>` : ''}
            ${editable ? `<button type="button" class="btn btn-primary" data-a="send">${icon('send')} ${inv.status === 'sent' ? 'Save and get link' : 'Send'}</button>` : ''}</div></div>
      </form>`, (box, close) => {
      box.classList.add('wide');
      const form = $('#invf', box), items = $('#items', box), msg = $('.form-msg', box);
      const read = () => $$('[data-row]', items).map(row => { const g = k => $(`[data-k="${k}"]`, row).value; return { title: g('title'), qty: Number(g('qty')) || 0, rate: Number(g('rate')) || 0, description: g('description'), bullets: g('bullets').split('\n').map(x => x.trim()).filter(Boolean) }; });
      const recalc = () => {
        let sub = 0; $$('[data-row]', items).forEach(row => { const a = (Number($('[data-k=qty]', row).value) || 0) * (Number($('[data-k=rate]', row).value) || 0); sub += a; $('[data-amt]', row).textContent = CX.amount(a); });
        const tax = sub * (Number(form.tax_rate.value) || 0) / 100, cur = form.currency.value.toUpperCase() || 'USD';
        $('#tSub', box).textContent = CX.amount(sub); $('#tTax', box).textContent = CX.amount(tax); $('#tTot', box).textContent = `${cur} ${CX.amount(sub + tax)}`;
      };
      const reindex = () => $$('[data-row]', items).forEach((row, i) => { row.dataset.row = i; });
      items.addEventListener('input', recalc); form.tax_rate.addEventListener('input', recalc); form.currency.addEventListener('input', recalc);
      items.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { if ($$('[data-row]', items).length < 2) return toast('An invoice needs at least one line.', true); b.closest('[data-row]').remove(); reindex(); recalc(); } });
      const add = $('#addItem', box); add && add.addEventListener('click', () => { items.insertAdjacentHTML('beforeend', itemRow({ title: '', qty: 1, rate: 0, bullets: [] }, $$('[data-row]', items).length)); recalc(); $('[data-row]:last-child [data-k=title]', items).focus(); });
      recalc();
      const save = async () => {
        if (!editable) return inv;
        const d = CX.formData(form);
        const r2 = await patch('/team/invoices/' + inv.id, { ...d, issued_at: d.issued_at ? d.issued_at + 'T12:00:00.000Z' : undefined, tax_rate: Number(d.tax_rate) || 0, items: read() });
        inv = r2.invoice; return inv;
      };
      $$('[data-a]', box).forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.a; msg.textContent = ''; msg.className = 'form-msg';
        try {
          if (a === 'preview') { const w = window.open('', '_blank'); await save(); if (w) w.location = link; else location.href = link; return; }
          if (a === 'save') { CX.busy(b, true); await save(); CX.busy(b, false); toast('Invoice saved'); onDone && onDone(); return; }
          if (a === 'send') {
            CX.busy(b, true); await save(); const r3 = await post(`/team/invoices/${inv.id}/send`); close(); onDone && onDone();
            const name = (inv.bill_name || '').split(' ')[0] || 'there';
            const text = `Hi ${name},\n\nHere is invoice ${inv.number} for ${inv.currency} ${CX.amount(inv.total)}:\n${r3.link}\n\nYou can open it in any browser and save it as a PDF. Payment details are on the invoice.\n\nThank you.`;
            modal(`<h2>Invoice ready to share</h2><p class="muted small">${r3.emailed ? 'We emailed it to ' + esc(inv.bill_email) + '. You can also send it yourself.' : 'Send this link by email, Upwork, Fiverr or WhatsApp. It opens without a login.'}</p>
              <div class="copybox"><span class="grow">${esc(r3.link)}</span><button class="btn btn-dark btn-sm" data-c="link">${icon('copy')} Copy link</button></div>
              <label class="field"><span>Ready to send message</span><textarea class="input" readonly style="min-height:150px">${esc(text)}</textarea></label>
              <div class="modal-actions"><a class="btn btn-line" href="${esc(r3.link)}" target="_blank" rel="noopener">${icon('eye')} Open invoice</a><button class="btn btn-primary" data-c="msg">${icon('copy')} Copy message</button></div>`, bx => {
              $$('[data-c]', bx).forEach(c => c.addEventListener('click', async () => { try { await navigator.clipboard.writeText(c.dataset.c === 'msg' ? text : r3.link); c.innerHTML = icon('check') + ' Copied'; } catch { toast('Select the text and copy it manually.', true); } }));
            });
            return;
          }
          if (a === 'paid') {
            close();
            modal(`<h2>Mark ${esc(inv.number)} as paid</h2><p class="muted small">${inv.order_id ? 'The linked order is marked paid too, once the client has approved it.' : ''}</p>
              <label class="field"><span>Paid via</span><select class="input" id="pv">${['Direct', 'Payoneer', 'Upwork', 'Fiverr', 'Bank transfer', 'Other'].map(x => `<option>${x}</option>`).join('')}</select></label>
              <div class="modal-actions"><button class="btn btn-line" data-close>Cancel</button><button class="btn btn-ok" id="pvGo">${icon('check')} Mark paid</button></div>`, (bx, c2) => {
              $('#pvGo', bx).addEventListener('click', async e => { CX.busy(e.currentTarget, true); try { await post(`/team/invoices/${inv.id}/paid`, { paid_via: $('#pv', bx).value }); c2(); toast('Invoice marked paid'); refreshOverview(); onDone && onDone(); } catch (err) { fail(err); CX.busy(e.currentTarget, false); } });
            });
            return;
          }
          if (a === 'void') {
            if (!(await CX.confirm(inv.status === 'draft' ? 'Delete this draft?' : 'Void this invoice?', inv.status === 'draft' ? 'The draft is removed. Nothing was sent to the client.' : 'The link stays readable but shows the invoice as void. This cannot be undone.', inv.status === 'draft' ? 'Delete' : 'Void'))) return;
            await post(`/team/invoices/${inv.id}/void`); toast(inv.status === 'draft' ? 'Draft deleted' : 'Invoice voided'); onDone && onDone(); return;
          }
        } catch (e) { CX.busy(b, false); msg.textContent = e.message; msg.className = 'form-msg err'; }
      }));
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const r = CX.route();
    if (r.parts[0] === 'setup' && r.parts[1]) return renderSetup(r.parts[1]);
    try { S.me = (await get('/auth/me')).user; } catch (e) { S.me = null; if (e.status === 401) return renderLogin(); root.innerHTML = `<div class="empty" style="min-height:100vh">${icon('alert')}<h3>Could not reach the server</h3><p>${esc(e.message)}</p><button class="btn btn-line" onclick="location.reload()">Try again</button></div>`; return; }
    if (S.me.role === 'client') { location.href = '/app/'; return; }
    await loadMembers();
    renderShell(); S.view = ''; await refreshOverview();
    await onRoute(); startTimer();
  }
  window.addEventListener('hashchange', () => { const r = CX.route(); if (r.parts[0] === 'setup') return boot(); if (S.me) onRoute(); });
  boot();
})();
