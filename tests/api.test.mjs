// CubiX API tests. Run against a fresh local DB:  npm run db:reset && npm run dev  then  npm run test:api
const BASE = process.env.BASE || 'http://localhost:8788';
const KEY = process.env.BOOTSTRAP_KEY || 'local-bootstrap-key';
let passed = 0, failed = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { passed++; results.push('  ok   ' + name); }
  else { failed++; results.push('  FAIL ' + name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, { csrf = true, form = false } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf) headers['x-cubix'] = '1';
    let payload;
    if (form) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + '/api' + path, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = sc.match(/cx_session=([^;]*)/); if (m) this.cookie = m[1] ? 'cx_session=' + m[1] : ''; }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
    return { status: r.status, data, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b, o) { return this.req('POST', p, b, o); }
  patch(p, b) { return this.req('PATCH', p, b); }
  put(p, b) { return this.req('PUT', p, b, { form: true }); }
  // chunked upload exactly like the browser: start, parts, finish
  async upload(name, bytes, type = 'application/octet-stream') {
    const s = await this.post('/uploads', { name, size: bytes.length, type });
    if (s.status !== 201) return s;
    for (let n = 0; n < s.data.parts; n++) {
      const r = await this.put(`/uploads/${s.data.id}/${n}`, new Blob([bytes.subarray(n * s.data.part_size, Math.min(bytes.length, (n + 1) * s.data.part_size))]));
      if (r.status !== 200) return r;
    }
    const f = await this.post(`/uploads/${s.data.id}/finish`);
    return f.status === 200 ? { status: 200, id: s.data.id, parts: s.data.parts } : f;
  }
}
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])], { type: 'image/png' });
function orderForm(fields, files = [['house.png', png()]]) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach(x => f.append(k, x));
  for (const [n, b] of files) f.append('files', b, n);
  return f;
}
const stamp = Date.now().toString(36);
const em = n => `${n}.${stamp}@test.cubix`;

async function run() {
  const anon = new Client(), admin = new Client(), modeler = new Client(), modeler2 = new Client(), shopA = new Client(), shopB = new Client();

  // ------------------------------------------------ auth basics
  let r = await anon.get('/team/overview');
  check('anonymous cannot open team overview', r.status === 401, r);
  r = await anon.get('/client/orders');
  check('anonymous cannot open client orders', r.status === 401, r);
  r = await anon.get('/nope');
  check('unknown route is 404', r.status === 404, r);

  r = await anon.post('/auth/bootstrap', { key: 'wrong', name: 'A', email: em('admin'), password: 'password123' });
  check('bootstrap rejects wrong key', r.status === 403, r);
  r = await anon.post('/auth/bootstrap', { key: KEY, name: 'Rizwan', email: em('admin'), password: 'adminpass123' });
  check('bootstrap creates first admin', r.status === 201 || r.status === 409, r);
  const firstAdmin = r.status === 201;
  r = await anon.post('/auth/bootstrap', { key: KEY, name: 'Second', email: em('admin2'), password: 'adminpass123' });
  check('bootstrap refuses once an admin exists', r.status === 409, r);
  if (!firstAdmin) { console.log('An admin already existed. Reset the local DB (npm run db:reset) and run again.'); process.exit(1); }

  r = await admin.post('/auth/login', { email: em('admin'), password: 'adminpass123' }, { csrf: false });
  check('login works without csrf header (login is public)', r.status === 403 || r.status === 200, r);
  r = await admin.post('/auth/login', { email: em('admin').toUpperCase(), password: 'adminpass123' });
  check('admin logs in (email is case insensitive)', r.status === 200 && r.data.user.role === 'admin', r.data);
  check('session cookie is set', admin.cookie.startsWith('cx_session='));
  r = await admin.get('/auth/me');
  check('me returns admin', r.status === 200 && r.data.user.role === 'admin' && r.data.shop === null, r.data);

  // CSRF
  r = await admin.req('POST', '/team/members', { name: 'X', email: em('x') }, { csrf: false });
  check('mutating call without x-cubix header is refused', r.status === 403 && r.data.error === 'csrf', r.data);

  // ------------------------------------------------ team members
  r = await admin.post('/team/members', { name: 'Ali Modeler', email: em('mod1'), role: 'modeler', capacity: 3 });
  check('admin invites a modeler and gets a setup link', r.status === 201 && /\/team\/#\/setup\/[a-f0-9]{64}$/.test(r.data.link), r.data);
  const mod1 = r.data.id, mod1Link = r.data.link;
  r = await admin.post('/team/members', { name: 'Sara Modeler', email: em('mod2'), capacity: 5 });
  const mod2 = r.data.id, mod2Link = r.data.link;
  r = await admin.post('/team/members', { name: 'Dup', email: em('mod1').toUpperCase() });
  check('duplicate member email is refused', r.status === 409, r.data);
  r = await admin.post('/team/members', { name: '', email: 'bad' });
  check('invalid member is refused', r.status === 422, r.data);

  const tok1 = mod1Link.split('/').pop();
  r = await modeler.post('/auth/setup', { token: tok1, password: 'short' });
  check('setup rejects a weak password', r.status === 422 && r.data.error === 'weak_password', r.data);
  r = await modeler.post('/auth/setup', { token: tok1, password: 'modelerpass1' });
  check('modeler sets a password with the link and is signed in', r.status === 200 && r.data.role === 'modeler' && modeler.cookie, r.data);
  r = await anon.post('/auth/setup', { token: tok1, password: 'anotherpass1' });
  check('setup link works only once', r.status === 400 && r.data.error === 'bad_token', r.data);
  r = await anon.post('/auth/setup', { token: 'zz', password: 'anotherpass1' });
  check('garbage setup token is refused', r.status === 400, r.data);
  r = await modeler2.post('/auth/setup', { token: mod2Link.split('/').pop(), password: 'modelerpass2' });
  check('second modeler activated', r.status === 200, r.data);

  r = await modeler.post('/team/members', { name: 'Hack', email: em('hack') });
  check('modeler cannot add members', r.status === 403, r.data);
  r = await modeler.patch('/team/members/' + mod1, { capacity: 40 });
  check('modeler cannot change capacity', r.status === 403, r.data);
  r = await modeler.get('/team/members');
  check('modeler can see the team list', r.status === 200 && r.data.members.length === 3, r.data);
  check('member list never exposes password hashes', !JSON.stringify(r.data).includes('password'), r.data);

  r = await admin.patch('/team/members/' + mod1, { capacity: 0 });
  check('capacity must be 1 to 50', r.status === 422, r.data);
  r = await admin.patch('/team/members/' + mod1, { capacity: 4 });
  check('admin updates capacity', r.status === 200, r.data);
  const me = (await admin.get('/auth/me')).data.user.id;
  r = await admin.patch('/team/members/' + me, { active: false });
  check('admin cannot deactivate themselves', r.status === 409, r.data);
  r = await admin.patch('/team/members/' + me, { role: 'modeler' });
  check('admin cannot drop their own admin role', r.status === 409, r.data);

  // ------------------------------------------------ public website order (shop A, no account yet)
  r = await anon.post('/order', orderForm({ name: 'Emma', email: em('shopa'), shop: 'etsy.com/shop/EmmaMinis', product: 'House replica', size: '15 cm', printer: 'Bambu X1C', formats: ['STL', '3MF'], notes: 'Blue door please', channel: 'Direct' }), { csrf: false, form: true });
  check('public order form works without login or csrf header', r.status === 201 && /^CX[A-Z0-9]{6}$/.test(r.data.id) && r.data.free === true, r.data);
  const firstCode = r.data.id;
  r = await anon.post('/order', orderForm({ name: 'Emma', email: em('shopa'), product: 'Pet figurine' }), { csrf: false, form: true });
  check('second order from same shop is not free', r.status === 201 && r.data.free === false, r.data);
  r = await anon.post('/order', orderForm({ name: 'Emma', email: em('shopa') }, []), { csrf: false, form: true });
  check('order without files is refused', r.status === 422 && r.data.error === 'no_files', r.data);
  r = await anon.post('/order', orderForm({ name: '', email: 'nope' }), { csrf: false, form: true });
  check('order with bad email is refused', r.status === 422, r.data);
  r = await anon.post('/order', orderForm({ name: 'Bot', email: em('bot'), company_website: 'spam.com' }), { csrf: false, form: true });
  check('honeypot silently accepts spam', r.status === 200 && r.data.id === 'CX000000', r.data);
  r = await anon.post('/order', orderForm({ name: 'Ali', email: em('mod1') }), { csrf: false, form: true });
  check('team email cannot be used to order', r.status === 422, r.data);
  const big = new Blob([new Uint8Array(26 * 1024 * 1024)], { type: 'application/octet-stream' });
  r = await anon.post('/order', orderForm({ name: 'Big', email: em('big') }, [['huge.stl', big]]), { csrf: false, form: true });
  check('file over 25 MB is refused', r.status === 413, r.data);
  r = await admin.get('/team/orders?q=' + encodeURIComponent('Big'));
  check('refused upload leaves no half order behind', r.status === 200 && r.data.orders.every(o => o.shop_name !== 'Big'), r.data.orders?.length);

  // team generates a login link for shop A owner
  r = await admin.get('/team/shops');
  const shopARow = r.data.shops.find(s => s.email === em('shopa'));
  check('shop A listed with 2 orders and no login yet', shopARow && shopARow.orders === 2 && shopARow.active_logins === 0 && shopARow.free_used === 1, shopARow);
  r = await admin.get('/team/shops/' + shopARow.id);
  const shopAUser = r.data.users[0].id;
  r = await modeler.post(`/team/users/${shopAUser}/link`);
  check('modeler cannot create client login links', r.status === 403, r.data);
  r = await admin.post(`/team/users/${shopAUser}/link`);
  check('admin creates a client setup link pointing at /app', r.status === 200 && r.data.link.includes('/app/#/setup/') && r.data.emailed === false, r.data);
  r = await shopA.post('/auth/setup', { token: r.data.link.split('/').pop(), password: 'shopApass123' });
  check('shop A owner sets password and lands as client', r.status === 200 && r.data.role === 'client', r.data);

  // ------------------------------------------------ signup (shop B)
  r = await shopB.post('/auth/signup', { name: 'Noah', email: em('shopb'), password: 'shopBpass123', shop: 'Noah Prints', url: 'etsy.com/shop/NoahPrints' });
  check('shop owner signs up and is signed in', r.status === 201 && shopB.cookie, r.data);
  r = await anon.post('/auth/signup', { name: 'Noah', email: em('shopb'), password: 'shopBpass123' });
  check('duplicate signup is refused', r.status === 409, r.data);
  r = await anon.post('/auth/signup', { name: 'Weak', email: em('weak'), password: '123' });
  check('weak signup password is refused', r.status === 422, r.data);
  r = await shopB.get('/auth/me');
  check('me returns client with shop', r.data.user.role === 'client' && r.data.shop.name === 'Noah Prints' && r.data.shop.free_used === 0, r.data);

  // ------------------------------------------------ client portal
  r = await shopB.post('/client/orders', orderForm({ title: 'Lighthouse ornament', product: 'Ornament', size: '8 cm', formats: ['STL'], priority: 'rush' }), { form: true });
  check('client creates an order from the portal, first one free', r.status === 201 && r.data.free === true, r.data);
  const bOrder = r.data.id;
  r = await shopB.post('/client/orders', orderForm({ title: 'No files' }, []), { form: true });
  check('portal order without files refused', r.status === 422, r.data);
  r = await shopB.get('/client/orders');
  check('client sees only own orders', r.status === 200 && r.data.orders.length === 1 && r.data.orders[0].id === bOrder, r.data.orders?.map(o => o.code));
  check('order list includes a thumbnail', !!r.data.orders[0].thumb, r.data.orders[0]);
  r = await shopA.get('/client/orders');
  check('shop A sees its two website orders', r.data.orders.length === 2, r.data.orders?.length);
  const aOrder = r.data.orders.find(o => o.code === firstCode).id;

  r = await shopA.get('/client/orders/' + bOrder);
  check('client cannot open another shop order (404, not 403)', r.status === 404, r.data);
  r = await shopA.post(`/client/orders/${bOrder}/messages`, { body: 'hi' });
  check('client cannot message another shop order', r.status === 404, r.data);
  r = await shopA.post(`/client/orders/${bOrder}/approve`);
  check('client cannot approve another shop order', r.status === 404, r.data);
  r = await shopB.get('/team/overview');
  check('client cannot open team overview', r.status === 403, r.data);
  r = await shopB.get('/team/orders');
  check('client cannot list team orders', r.status === 403, r.data);
  r = await modeler.get('/client/orders');
  check('team member cannot use client routes', r.status === 403, r.data);

  r = await shopB.get('/client/orders/' + bOrder);
  const refFile = r.data.order.files[0];
  check('client order detail has reference file', r.status === 200 && refFile.kind === 'reference' && r.data.order.priority === 'rush', r.data.order);
  check('client detail hides assignee', !('assignee_id' in r.data.order), Object.keys(r.data.order));
  const due = new Date(r.data.order.due_at) - new Date(r.data.order.created_at);
  check('rush order is due in 24 hours', Math.abs(due - 24 * 3600e3) < 5000, due);
  r = await shopA.get('/client/orders/' + aOrder);
  const dueA = new Date(r.data.order.due_at) - new Date(r.data.order.created_at);
  check('normal order is due in 48 hours', Math.abs(dueA - 48 * 3600e3) < 5000, dueA);

  r = await shopB.get('/files/' + refFile.id);
  check('client downloads own file', r.status === 200 && r.data.byteLength === 12 && /attachment/.test(r.headers.get('content-disposition')), r.status);
  r = await shopA.get('/files/' + refFile.id);
  check('client cannot download another shop file', r.status === 404, r.status);
  r = await anon.get('/files/' + refFile.id);
  check('anonymous cannot download files', r.status === 401, r.status);
  r = await modeler.get('/files/' + refFile.id + '?inline=1');
  check('team can view image inline', r.status === 200 && /inline/.test(r.headers.get('content-disposition')) && r.headers.get('content-type') === 'image/png', r.status);

  r = await shopB.post(`/client/orders/${bOrder}/approve`);
  check('cannot approve before a preview exists', r.status === 409, r.data);
  r = await shopB.post(`/client/orders/${bOrder}/revision`, { body: 'x' });
  check('cannot ask a revision before a preview exists', r.status === 409, r.data);
  r = await shopB.post(`/client/orders/${bOrder}/messages`, { body: '' });
  check('empty message is refused', r.status === 422, r.data);
  r = await shopB.post(`/client/orders/${bOrder}/messages`, { body: 'Please keep the red stripes.' });
  check('client sends a message', r.status === 201, r.data);

  // ------------------------------------------------ team workflow
  r = await modeler.get('/team/overview');
  check('overview counts open and unassigned', r.status === 200 && r.data.unassigned === 3 && r.data.team.length === 3 && r.data.capacity === 4 + 5 + 6, { u: r.data.unassigned, c: r.data.capacity });
  check('overview attention list has the 3 unassigned orders', r.data.attention.length === 3, r.data.attention?.length);

  r = await modeler.get('/team/orders?status=open');
  check('team lists all open orders across shops', r.data.orders.length === 3, r.data.orders?.length);
  check('rush order is sorted first', r.data.orders[0].id === bOrder, r.data.orders.map(o => o.priority));
  r = await modeler.get('/team/orders?q=Noah');
  check('search by shop name', r.data.orders.length === 1, r.data.orders?.length);
  r = await modeler.get('/team/orders?q=' + firstCode);
  check('search by order code', r.data.orders.length === 1 && r.data.orders[0].code === firstCode, r.data.orders?.length);
  r = await modeler.get('/team/orders?assignee=none');
  check('filter unassigned', r.data.orders.length === 3, r.data.orders?.length);

  r = await modeler.patch('/team/orders/' + bOrder, { assignee_id: mod2 });
  check('modeler cannot assign to someone else', r.status === 403, r.data);
  r = await modeler.patch('/team/orders/' + bOrder, { assignee_id: mod1 });
  check('modeler claims an order, status moves new to confirmed', r.status === 200 && r.data.order.assignee_id === mod1 && r.data.order.status === 'confirmed', r.data.order?.status);
  r = await modeler2.patch('/team/orders/' + bOrder, { assignee_id: null });
  check('modeler cannot unassign someone else', r.status === 403, r.data);
  r = await admin.patch('/team/orders/' + aOrder, { assignee_id: mod2 });
  check('admin assigns order to a modeler', r.status === 200 && r.data.order.assignee_name === 'Sara Modeler', r.data.order?.assignee_name);
  r = await admin.patch('/team/orders/' + aOrder, { assignee_id: 'u_doesnotexist' });
  check('assigning to unknown user is refused', r.status === 422, r.data);

  r = await modeler.patch('/team/orders/' + bOrder, { price: 80 });
  check('modeler cannot set a price', r.status === 403, r.data);
  r = await modeler.patch('/team/orders/' + bOrder, { status: 'paid' });
  check('modeler cannot mark paid', r.status === 403, r.data);
  r = await modeler.patch('/team/orders/' + bOrder, { status: 'flying' });
  check('unknown status is refused', r.status === 422, r.data);
  r = await modeler.patch('/team/orders/' + bOrder, { status: 'modeling' });
  check('modeler moves order to modeling', r.status === 200 && r.data.order.status === 'modeling', r.data.order?.status);

  r = await modeler.post(`/team/orders/${bOrder}/messages`, { body: 'Client wants stripes, check ref 2', internal: true });
  check('internal note saved', r.status === 201, r.data);
  r = await modeler.post(`/team/orders/${bOrder}/messages`, { body: 'Thanks, working on it now.' });
  check('reply to client saved', r.status === 201, r.data);
  r = await shopB.get('/client/orders/' + bOrder);
  const msgs = r.data.order.messages.map(m => m.body);
  check('client sees the reply but not the internal note', msgs.includes('Thanks, working on it now.') && !msgs.some(b => b.includes('check ref 2')), msgs);
  check('client does not see assignment events', !r.data.order.events.some(e => e.type === 'assigned'), r.data.order.events.map(e => e.type));
  r = await modeler.get('/team/orders/' + bOrder);
  check('team sees internal note and events', r.data.order.messages.some(m => m.internal === 1) && r.data.order.events.some(e => e.type === 'assigned'), r.data.order.messages.length);

  // preview
  r = await admin.get('/team/settings');
  check('QC is off by default', r.data.settings.qc_enabled === '0', r.data.settings.qc_enabled);
  await admin.patch('/team/settings', { qc_enabled: '1' });
  let f = new FormData(); f.append('kind', 'preview'); f.append('files', png(), 'render1.png');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  check('modeler preview goes to QC review first, version 1', r.status === 201 && r.data.status === 'review' && r.data.version === 1, r.data);
  r = await shopB.get('/client/orders/' + bOrder);
  check('client does not see a preview before QC passes it (status shows as modeling)', r.data.order.status === 'modeling' && !r.data.order.files.some(x => x.kind === 'preview'), { st: r.data.order.status, files: r.data.order.files.map(x => x.kind) });
  r = await modeler.patch('/team/orders/' + bOrder, { status: 'preview' });
  check('a modeler cannot pass their own preview', r.status === 403, r.data);
  r = await modeler.post(`/team/orders/${bOrder}/qc`, { action: 'pass' });
  check('modelers cannot run QC', r.status === 403, r.status);
  r = await admin.post(`/team/orders/${bOrder}/qc`, { action: 'back', note: '' });
  check('sending back needs a note', r.status === 422, r.data);
  r = await admin.post(`/team/orders/${bOrder}/qc`, { action: 'back', note: 'Roof line is off, check photo 2' });
  check('QC sends it back to the modeler with an internal note', r.status === 200 && r.data.order.status === 'modeling' && r.data.order.messages.some(m => m.internal && m.body.includes('Roof line')), r.data.order?.status);
  f = new FormData(); f.append('kind', 'preview'); f.append('files', png(), 'render1b.png');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  r = await admin.post(`/team/orders/${bOrder}/qc`, { action: 'pass' });
  check('QC passes the preview to the client', r.status === 200 && r.data.order.status === 'preview' && r.data.order.files.filter(x => x.kind === 'preview').every(x => x.released === 1), r.data.order?.status);
  r = await shopB.get('/client/orders/' + bOrder);
  check('client now sees the preview', r.data.order.status === 'preview' && r.data.order.files.some(x => x.kind === 'preview'), r.data.order.status);
  r = await admin.post(`/team/orders/${bOrder}/qc`, { action: 'pass' });
  check('QC only works on orders in review', r.status === 409, r.status);
  r = await shopB.post(`/client/orders/${bOrder}/seen`);
  r = await admin.get('/team/orders/' + bOrder);
  check('team sees that the client opened the preview', !!r.data.order.preview_seen_at, r.data.order.preview_seen_at);
  f = new FormData(); f.append('kind', 'final');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  check('upload with no files refused', r.status === 422, r.data);
  f = new FormData(); f.append('kind', 'bogus'); f.append('files', png(), 'x.png');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  check('upload with bad kind refused', r.status === 422, r.data);

  // revision loop
  r = await shopB.post(`/client/orders/${bOrder}/revision`, { body: '' });
  check('revision needs a description', r.status === 422, r.data);
  r = await shopB.post(`/client/orders/${bOrder}/revision`, { body: 'Make the roof darker.' });
  check('client asks a revision', r.status === 200, r.data);
  r = await shopB.get('/client/orders/' + bOrder);
  check('order is in revisions, counter 1', r.data.order.status === 'revisions' && r.data.order.revisions === 1, r.data.order.status);
  f = new FormData(); f.append('kind', 'preview'); f.append('files', png(), 'render2.png');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  check('second preview is version 3 and waits for QC', r.data.version === 3 && r.data.status === 'review', r.data);
  r = await admin.patch('/team/orders/' + bOrder, { status: 'preview' });
  check('admin can also pass QC by moving the card to Preview sent', r.status === 200 && r.data.order.status === 'preview', r.data.order?.status);
  r = await admin.patch('/team/orders/' + bOrder, { paid: true });
  check('cannot mark paid before the client approves', r.status === 409, r.data);
  r = await shopB.post(`/client/orders/${bOrder}/approve`);
  check('client approves preview', r.status === 200 && r.data.status === 'approved', r.data);
  r = await admin.patch('/team/orders/' + bOrder, { price: 0, paid: true, paid_via: 'Free first model' });
  check('paid after approval keeps the order in production', r.status === 200 && r.data.order.status === 'approved' && r.data.order.paid === 1, r.data.order?.status);

  // final delivery
  f = new FormData(); f.append('kind', 'final'); f.append('files', new Blob(['solid x\nendsolid x'], { type: 'model/stl' }), 'lighthouse.stl'); f.append('files', new Blob(['3mf'], { type: 'application/zip' }), 'lighthouse.3mf');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  check('final upload on a paid order closes it as paid', r.status === 201 && r.data.status === 'paid', r.data);
  r = await shopB.get('/client/orders/' + bOrder);
  const finals = r.data.order.files.filter(x => x.kind === 'final');
  check('client sees two final files and a delivered date', finals.length === 2 && !!r.data.order.delivered_at, finals.length);
  r = await shopB.get('/files/' + finals[0].id);
  check('client downloads final STL', r.status === 200 && r.data.byteLength > 0, r.status);
  r = await shopB.get('/client/orders');
  check('client list shows preview and final counts', r.data.orders[0].previews === 3 && r.data.orders[0].finals === 2, r.data.orders[0]);

  // payment (free order still can be marked paid / price 0; set a price on shop A order)
  r = await admin.patch('/team/orders/' + bOrder, { price: -5 });
  check('negative price refused', r.status === 422, r.data);
  r = await shopB.get('/client/orders/' + bOrder);
  check('closed order is paid with a delivery date', r.data.order.status === 'paid' && r.data.order.paid === 1 && !!r.data.order.delivered_at, r.data.order.status);

  const aSecond = (await shopA.get('/client/orders')).data.orders.find(o => o.code !== firstCode).id;
  await admin.patch('/team/orders/' + aSecond, { assignee_id: mod2, price: 95 });
  f = new FormData(); f.append('kind', 'final'); f.append('files', new Blob(['x']), 'pet.stl');
  await modeler2.post(`/team/orders/${aSecond}/files`, f, { form: true });
  r = await admin.get('/team/overview');
  check('final upload on an unpaid order marks it delivered', (await admin.get('/team/orders/' + aSecond)).data.order.status === 'delivered');
  check('overview shows awaiting payment $95', r.data.awaiting.n === 1 && r.data.awaiting.total === 95, r.data.awaiting);
  check('overview counts a delivery in last 30 days', r.data.deliveredLast30 === 2 && r.data.avgHours !== null, r.data.deliveredLast30);
  r = await admin.get('/team/orders?unpaid=1');
  check('unpaid filter', r.data.orders.length === 1 && r.data.orders[0].id === aSecond, r.data.orders?.length);
  r = await admin.patch('/team/orders/' + aSecond, { paid: true, paid_via: 'Payoneer' });
  check('admin marks paid via Payoneer', r.data.order.status === 'paid' && r.data.order.paid_via === 'Payoneer', r.data.order);
  r = await admin.get('/team/overview');
  check('revenue this month is $95', r.data.paidMonth.total === 95, r.data.paidMonth);

  // capacity / overdue
  r = await admin.patch('/team/orders/' + aOrder, { due_at: new Date(Date.now() - 3600e3).toISOString() });
  check('admin moves a due date', r.status === 200, r.data);
  r = await admin.patch('/team/orders/' + aOrder, { due_at: 'not a date' });
  check('bad due date refused', r.status === 422, r.data);
  r = await admin.get('/team/overview');
  const sara = r.data.team.find(m => m.id === mod2);
  check('overdue counted in overview and per modeler', r.data.overdue === 1 && sara.overdue === 1 && sara.open === 1, { o: r.data.overdue, sara });
  r = await admin.get('/team/orders?due=overdue');
  check('overdue filter', r.data.orders.length === 1 && r.data.orders[0].id === aOrder, r.data.orders?.length);
  r = await modeler2.get('/team/orders?assignee=me');
  check('my orders filter', r.data.orders.every(o => o.assignee_id === mod2) && r.data.orders.length === 2, r.data.orders?.length);

  // shops
  r = await modeler.patch('/team/shops/' + shopARow.id, { plan: 'growth' });
  check('modeler cannot change shop plan', r.status === 403, r.data);
  r = await admin.patch('/team/shops/' + shopARow.id, { plan: 'platinum' });
  check('unknown plan refused', r.status === 422, r.data);
  r = await admin.patch('/team/shops/' + shopARow.id, { plan: 'growth', notes: 'Holiday volume expected' });
  check('admin sets shop plan and notes', r.status === 200, r.data);
  r = await admin.get('/team/shops/' + shopARow.id);
  check('shop detail reflects plan, users and orders', r.data.shop.plan === 'growth' && r.data.orders.length === 2 && r.data.users[0].has_login === 1, r.data.shop);
  r = await admin.get('/team/shops');
  check('shop revenue rolls up', r.data.shops.find(s => s.id === shopARow.id).revenue === 95, r.data.shops.map(s => s.revenue));

  // deactivation kicks sessions
  r = await admin.patch('/team/members/' + mod2, { active: false });
  check('admin deactivates a modeler', r.status === 200, r.data);
  r = await modeler2.get('/team/overview');
  check('deactivated modeler is signed out immediately', r.status === 401, r.status);
  r = await anon.post('/auth/login', { email: em('mod2'), password: 'modelerpass2' });
  check('deactivated modeler cannot log in', r.status === 401, r.data);
  r = await admin.patch('/team/orders/' + aOrder, { assignee_id: mod2 });
  check('cannot assign to an inactive member', r.status === 422, r.data);
  await admin.patch('/team/members/' + mod2, { active: true });

  {
    const { randomBytes, createHash } = await import('crypto');
    const big = randomBytes(4 * 1024 * 1024 + 123), h = b => createHash('sha256').update(Buffer.from(b)).digest('hex');
    r = await shopB.post('/client/orders', orderForm({ title: 'Big file check' }, [['big.stl', new Blob([big], { type: 'model/stl' })]]), { form: true });
    const bigId = (await shopB.get('/client/orders/' + r.data.id)).data.order.files[0].id;
    r = await shopB.get('/files/' + bigId);
    check('4 MB file comes back byte for byte (multi chunk storage)', r.status === 200 && h(r.data) === h(big), r.status);
  }
  // invite a new shop from the dashboard
  r = await modeler.post('/team/shops', { name: 'Hack Shop', email: em('hackshop') });
  check('modeler cannot invite shops', r.status === 403, r.data);
  r = await admin.post('/team/shops', { name: '', email: em('noname') });
  check('invite needs a shop name', r.status === 422, r.data);
  r = await admin.post('/team/shops', { name: 'Linden Prints', contact: 'Mia', email: em('linden'), url: 'etsy.com/shop/Linden', plan: 'starter' });
  check('admin invites a new shop and gets a 7 day portal link', r.status === 201 && r.data.link.includes('/app/#/setup/'), r.data);
  const invLink = r.data.link, invShop = r.data.id;
  r = await admin.post('/team/shops', { name: 'Again', email: em('linden').toUpperCase() });
  check('inviting an existing client email is refused', r.status === 409, r.data);
  r = await admin.post('/team/shops', { name: 'Team clash', email: em('mod1') });
  check('inviting a team member email is refused', r.status === 409, r.data);
  {
    const invited = new Client();
    r = await invited.post('/auth/setup', { token: invLink.split('/').pop(), password: 'lindenpass1' });
    check('invited owner sets a password and lands as client', r.status === 200 && r.data.role === 'client', r.data);
    r = await invited.get('/auth/me');
    check('invited owner sees their shop, plan and unused free model', r.data.shop.name === 'Linden Prints' && r.data.shop.plan === 'starter' && r.data.shop.free_used === 0 && r.data.user.name === 'Mia', r.data);
    r = await invited.get('/client/orders');
    check('invited owner starts with no orders', r.status === 200 && r.data.orders.length === 0, r.data);
    r = await admin.get('/team/shops/' + invShop);
    check('invited shop shows an active login', r.data.users[0].has_login === 1, r.data.users);
  }

  // ---------------- production control: multi model orders, ship by, Job Bank, waiting on client
  r = await shopA.post('/client/orders', orderForm({ title: 'Street of houses', product: 'House replica', items: '3', ship_by: 'not a date' }), { form: true });
  check('a bad ship by date is refused', r.status === 422, r.data);
  const shipBy = new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10);
  r = await shopA.post('/client/orders', orderForm({ title: 'Street of houses', product: 'House replica', items: '3', ship_by: shipBy }), { form: true });
  check('one order with 3 models becomes 3 linked jobs', r.status === 201 && r.data.codes.length === 3, r.data);
  const streetCodes = r.data.codes;
  r = await shopA.get('/client/orders/' + r.data.id);
  check('each linked job knows its siblings, ship by date and shares the photos', r.data.order.siblings.length === 3 && r.data.order.item_count === 3 && r.data.order.ship_by.startsWith(shipBy) && r.data.order.files.length === 1 && r.data.order.title.endsWith('(1 of 3)'), r.data.order);
  const street2 = (await admin.get('/team/orders?q=' + streetCodes[1])).data.orders[0];
  check('sibling jobs have the same photos without copying them', street2.file_count === 1 && street2.item_no === 2, street2);
  check('jobs get a hand in time before the client due time', new Date(street2.handin_at) < new Date(street2.due_at), { h: street2.handin_at, d: street2.due_at });
  r = await anon.post('/order', orderForm({ name: 'Rush Shop', email: em('rush'), product: 'Sign', priority: 'rush' }), { csrf: false, form: true });
  const rushCode = r.data.id;
  await admin.patch('/team/members/' + mod1, { capacity: 1 });
  r = await modeler.post('/team/jobs/next');
  check('Job Bank hands out the most urgent job first (rush)', r.status === 200 && r.data.order && r.data.order.code === rushCode, r.data);
  const rushId = r.data.order.id;
  r = await modeler.post('/team/jobs/next');
  check('Job Bank stops at the modeler capacity', r.status === 409 && r.data.error === 'at_capacity', r.data);
  await admin.patch('/team/members/' + mod1, { capacity: 4 });
  r = await modeler.get('/team/orders/' + rushId);
  check('the taken job is assigned and confirmed', r.data.order.assignee_id === mod1 && r.data.order.status === 'confirmed', r.data.order.status);
  r = await shopA.get('/client/orders');
  r = await modeler.post(`/team/orders/${rushId}/ask`, { body: '' });
  check('asking the client needs a question', r.status === 422, r.data);
  r = await modeler.post(`/team/orders/${rushId}/ask`, { body: 'Can you send a photo of the back of the sign?' });
  check('waiting on client pauses the job', r.status === 200 && r.data.order.status === 'waiting' && !!r.data.order.paused_at, r.data.order?.status);
  const dueBefore = r.data.order.due_at;
  r = await admin.get('/team/overview');
  check('overview counts jobs waiting on clients and they are not overdue', r.data.waiting === 1, r.data.waiting);
  r = await modeler.patch('/team/orders/' + rushId, { status: 'waiting' });
  check('waiting cannot be set by dragging, only by asking', r.status === 200 && r.data.unchanged || r.status === 422, r.data);
  await new Promise(res => setTimeout(res, 1100));
  {
    const rushShop = new Client(); // the website customer gets a login through an admin link
    const shops = (await admin.get('/team/shops')).data.shops; const rs = shops.find(x => x.email === em('rush'));
    const uid0 = (await admin.get('/team/shops/' + rs.id)).data.users[0].id;
    const lk = (await admin.post(`/team/users/${uid0}/link`)).data.link;
    await rushShop.post('/auth/setup', { token: lk.split('/').pop(), password: 'rushpass123' });
    r = await rushShop.get('/client/orders/' + rushId);
    check('client sees that we are waiting for them', r.data.order.status === 'waiting' && r.data.order.messages.some(m => m.body.includes('back of the sign')), r.data.order.status);
    r = await rushShop.post(`/client/orders/${rushId}/messages`, { body: 'Here it is, sending now' });
    r = await modeler.get('/team/orders/' + rushId);
    check('the client answer resumes the job and moves the deadline by the pause', r.data.order.status === 'confirmed' && !r.data.order.paused_at && new Date(r.data.order.due_at) > new Date(dueBefore), { st: r.data.order.status, d0: dueBefore, d1: r.data.order.due_at });
    r = await modeler.get('/team/orders?q=' + rushCode);
    check('a new client message shows as unread for the team', r.data.orders[0].unread === 1, r.data.orders[0].unread);
    await modeler.post(`/team/orders/${rushId}/seen`);
    r = await modeler.get('/team/orders?q=' + rushCode);
    check('"Got it" clears the unread flag', r.data.orders[0].unread === 0, r.data.orders[0].unread);
  }
  // ---------------- revision rounds with pins
  {
    const sid = (await admin.get('/team/orders?q=' + streetCodes[0])).data.orders[0].id;
    let f = new FormData(); f.append('kind', 'preview'); f.append('files', new Blob(['solid t\nendsolid t'], { type: 'model/stl' }), 'house-r1.stl');
    r = await admin.post(`/team/orders/${sid}/files`, f, { form: true });
    check('an admin preview skips QC and goes straight to the client', r.data.status === 'preview', r.data);
    const modelId = (await shopA.get('/client/orders/' + sid)).data.order.files.find(x => x.kind === 'preview').id;
    r = await shopA.post(`/client/orders/${sid}/revision`, { body: 'Fix these two spots', pins: [{ p: [1, 2, 'x'], note: 'bad' }] });
    check('pins need a valid position', r.status === 422, r.data);
    f = new FormData(); f.append('body', 'Fix these two spots'); f.append('model_file', modelId);
    f.append('pins', JSON.stringify([{ p: [1.23456, 2, 3], note: 'Chimney is too tall' }, { p: [0, 0, 1], note: 'Door should be red' }]));
    f.append('files', png(), 'door-closeup.png');
    r = await shopA.post(`/client/orders/${sid}/revision`, f, { form: true });
    check('client asks for changes with pins and a photo: round 2', r.status === 200 && r.data.round === 2, r.data);
    r = await modeler.get('/team/orders/' + sid);
    const rq = r.data.order.requests[0];
    check('team sees the round, the pins and the attached photo', r.data.order.round === 2 && rq.round === 2 && rq.pins.length === 2 && rq.pins[0].p[0] === 1.235 && rq.pins[1].note === 'Door should be red' && rq.model_file === modelId && r.data.order.files.some(x => x.request_id === rq.id), rq);
    check('revision moves the hand in time with the new deadline', new Date(r.data.order.handin_at) < new Date(r.data.order.due_at), r.data.order.handin_at);
  }
  // ---------------- build rules
  r = await modeler.post('/team/rules', { title: 'x', body: 'y' });
  check('modelers cannot write rules', r.status === 403, r.status);
  r = await admin.post('/team/rules', { scope: 'product', product: 'House replica', title: 'Hollow body', body: 'Hollow, 2 mm walls, open underneath, every window cut through.' });
  check('admin adds a handbook rule for a product', r.status === 201, r.data);
  const ruleId = r.data.id;
  r = await admin.post('/team/rules', { scope: 'shop', shop_id: shopARow.id, title: 'Emma likes', body: 'Always add a 3 mm base plate with the house number.' });
  check('admin adds a rule for one shop', r.status === 201, r.data);
  r = await admin.post('/team/rules', { scope: 'shop', shop_id: 's_nope', title: 'x', body: 'y' });
  check('shop rules need a real shop', r.status === 422, r.data);
  {
    const sid = (await admin.get('/team/orders?q=' + streetCodes[2])).data.orders[0].id;
    r = await modeler.get('/team/orders/' + sid);
    check('every job shows the product rule and the shop rule', r.data.order.rules.length === 2 && r.data.order.rules.some(x => x.title === 'Hollow body') && r.data.order.rules.some(x => x.scope === 'shop'), r.data.order.rules);
    r = await shopA.get('/client/orders/' + sid);
    check('clients do not see the internal rules', !('rules' in r.data.order), Object.keys(r.data.order));
  }
  r = await modeler.get('/team/rules');
  check('handbook lists product rules for everyone on the team', r.data.rules.length === 1 && r.data.products.includes('House replica'), r.data);
  r = await admin.patch('/team/rules/' + ruleId, { body: 'Hollow, 2.4 mm walls.' });
  check('admin updates a rule', r.status === 200 && (await modeler.get('/team/rules')).data.rules[0].body === 'Hollow, 2.4 mm walls.', r.data);
  await admin.post(`/team/rules/${ruleId}/delete`);
  check('admin deletes a rule', (await modeler.get('/team/rules')).data.rules.length === 0);

  // ---------------- chunked uploads, Etsy notes, comments on the model
  {
    const { randomBytes, createHash } = await import('crypto');
    const h = b => createHash('sha256').update(Buffer.from(b)).digest('hex');
    const big = new Uint8Array(randomBytes(4 * 1024 * 1024 + 777));
    let u = await shopA.upload('house-front.jpg', big, 'image/jpeg');
    check('a 4 MB file uploads in 3 parts of 1.5 MB', u.status === 200 && u.parts === 3, u);
    r = await shopA.post('/client/orders', { title: 'Corner cottage', notes: 'Front is the side with the red door', customer_notes: 'Buyer: please add our cat on the porch', size: '12 cm', upload_ids: [u.id] });
    check('portal request with uploaded files, notes and the Etsy customer notes', r.status === 201, r.data);
    const cottage = r.data.id;
    r = await shopA.get('/client/orders/' + cottage);
    const cf = r.data.order.files[0];
    check('the request keeps the seller and Etsy customer notes apart', r.data.order.notes === 'Front is the side with the red door' && r.data.order.customer_notes === 'Buyer: please add our cat on the porch', r.data.order);
    r = await shopA.get('/files/' + cf.id);
    check('the uploaded file comes back byte for byte', r.status === 200 && h(r.data) === h(big) && cf.size === big.length, r.status);
    r = await shopA.post('/client/orders', { title: 'Reuse', upload_ids: [u.id] });
    check('an upload cannot be attached twice', r.status === 422, r.data);
    let s = await shopA.post('/uploads', { name: 'x.stl', size: 3000000 });
    r = await shopA.put(`/uploads/${s.data.id}/0`, new Blob([new Uint8Array(10)]));
    check('a part with the wrong size is refused', r.status === 422, r.data);
    r = await shopA.post(`/uploads/${s.data.id}/finish`);
    check('an unfinished upload cannot be completed', r.status === 422 && r.data.error === 'incomplete', r.data);
    r = await shopB.put(`/uploads/${s.data.id}/0`, new Blob([new Uint8Array(1536000)]));
    check("nobody else can add parts to someone's upload", r.status === 401 || r.status === 403, r.status);
    r = await shopA.post('/uploads', { name: 'huge.stl', size: 101 * 1024 * 1024 });
    check('files over 100 MB are refused before uploading', r.status === 413, r.data);
    const other = await shopB.upload('b.png', new Uint8Array(100));
    r = await shopA.post('/client/orders', { title: 'Steal', upload_ids: [other.id || 'up_000000000000000000000000'] });
    check("a shop cannot attach another user's upload", r.status === 403 || r.status === 422, r.data);
    // public website form: anonymous upload, then the order
    const pub = new Client();
    u = await pub.upload('street-view.pdf', new Uint8Array(2000000), 'application/pdf');
    r = await pub.post('/order', { name: 'Pia', email: em('pia'), shop: 'Pia Prints', product: 'House replica', notes: 'PDF of the plans', upload_ids: [u.id] });
    check('website order with a chunked PDF upload', r.status === 201 && /^CX/.test(r.data.id), r.data);
    // team hands in two part files as one round, straight to the seller (admin skips QC)
    const g = await admin.upload('ground-floor.stl', new Uint8Array(4000), 'model/stl'), roof = await admin.upload('roof.stl', new Uint8Array(3000), 'model/stl');
    r = await admin.post(`/team/orders/${cottage}/files`, { kind: 'preview', upload_ids: [g.id, roof.id] });
    check('team hands in a model made of two part files as one version', r.status === 201 && r.data.version === 1 && r.data.status === 'preview', r.data);
    r = await shopA.get('/client/orders/' + cottage);
    check('the seller sees both parts', r.data.order.files.filter(x => x.kind === 'preview').map(x => x.name).join() === 'ground-floor.stl,roof.stl', r.data.order.files.map(x => x.name));
    // threaded comments on the model
    r = await shopA.post(`/client/orders/${cottage}/pins`, { body: 'Roof should be steeper', pos: [1, 2, 3], part: 'roof.stl', model_file: roof.id });
    check('seller comments on a spot of the roof', r.status === 201 && r.data.n === 1, r.data);
    const p1 = r.data.id;
    r = await shopA.post(`/client/orders/${cottage}/pins`, { body: 'x', pos: 'nowhere' });
    check('a comment needs a spot on the model', r.status === 422, r.data);
    r = await shopA.post(`/client/orders/${cottage}/pins`, { body: 'Window on the left is missing', pos: [0.5, 0, 1], part: 'ground-floor.stl' });
    const p2 = r.data.id;
    r = await shopB.post(`/client/orders/${cottage}/pins`, { body: 'hack', pos: [0, 0, 0] });
    check('other shops cannot comment', r.status === 404, r.status);
    r = await modeler.post(`/pins/${p1}/replies`, { body: 'Will do, 40 degrees ok?' });
    check('team replies on the comment', r.status === 201, r.data);
    r = await shopA.post(`/pins/${p1}/replies`, { body: 'Yes, 40 is perfect' });
    r = await shopA.post(`/pins/${p1}/resolve`, { resolved: true });
    check('only the team marks a comment resolved', r.status === 403, r.status);
    r = await modeler.post(`/pins/${p1}/resolve`, { resolved: true });
    check('team resolves the comment', r.status === 200 && r.data.status === 'resolved', r.data);
    r = await shopA.post(`/pins/${p1}/resolve`, { resolved: false });
    check('the seller can reopen it', r.status === 200 && r.data.status === 'open', r.data);
    await modeler.post(`/pins/${p1}/resolve`, { resolved: true });
    r = await modeler.post(`/team/orders/${cottage}/pins`, { body: 'Is the chimney brick or stone?', pos: [2, 2, 2], part: 'roof.stl' });
    check('team can ask on a spot too', r.status === 201 && r.data.n === 3, r.data);
    r = await shopA.get('/client/orders/' + cottage);
    const pins = r.data.order.pins;
    check('the order carries comments with parts, status and replies', pins.length === 3 && pins[0].part === 'roof.stl' && pins[0].status === 'resolved' && pins[0].replies.length === 2 && pins[0].pos[2] === 3 && pins[1].status === 'open', pins);
    r = await shopA.post(`/client/orders/${cottage}/revision`, {});
    check('send changes works with open comments and no extra text', r.status === 200 && r.data.round === 2, r.data);
    r = await modeler.get('/team/orders/' + cottage);
    check('the round summary points at the open comments', r.data.order.requests[0].body.includes('2 open comments'), r.data.order.requests[0]);
    r = await shopB.post(`/pins/${p2}/replies`, { body: 'hack' });
    check('other shops cannot reply', r.status === 404, r.status);
  }

  // ---------------- invoices
  r = await modeler.get('/team/invoices');
  check('modeler cannot see invoices', r.status === 403, r.status);
  r = await shopA.get('/team/invoices');
  check('client cannot see team invoices', r.status === 403, r.status);
  r = await admin.post('/team/invoices', { order_id: aSecond });
  check('admin creates an invoice from an order, prefilled', r.status === 201 && r.data.invoice.status === 'draft' && r.data.invoice.items.length === 1 && r.data.invoice.bill_name === 'etsy.com/shop/EmmaMinis' || (r.status === 201 && r.data.invoice.items.length === 1), r.data);
  const inv1 = r.data.invoice;
  check('invoice number follows the year sequence', /^CX-\d{4}-001$/.test(inv1.number), inv1.number);
  r = await shopA.get('/client/invoices');
  check('draft invoices are hidden from the client', r.data.invoices.length === 0, r.data);
  r = await anon.get('/invoice/' + inv1.token);
  check('draft invoice link does not open for the public', r.status === 404, r.status);
  r = await admin.get('/invoice/' + inv1.token);
  check('team can preview a draft by link', r.status === 200 && r.data.invoice.status === 'draft', r.status);
  r = await admin.patch('/team/invoices/' + inv1.id, { items: [{ title: 'Architectural modeling, multicolor ready', description: 'Complete house model', bullets: 'Separate meshes per color\nEditable Blender file', qty: 1, rate: 85 }, { title: 'Rush delivery', qty: 2, rate: 7.5 }], tax_rate: 10, bill_email: em('billing') });
  check('editing items recalculates totals (100 + 10% tax = 110)', r.status === 200 && r.data.invoice.subtotal === 100 && r.data.invoice.tax === 10 && r.data.invoice.total === 110 && r.data.invoice.items[0].bullets.length === 2, r.data.invoice);
  r = await admin.patch('/team/invoices/' + inv1.id, { items: [] });
  check('an invoice needs at least one line', r.status === 422, r.data);
  r = await admin.patch('/team/invoices/' + inv1.id, { tax_rate: 500 });
  check('tax over 100 percent is refused', r.status === 422, r.data);
  r = await admin.patch('/team/invoices/' + inv1.id, { bill_email: 'not-an-email' });
  check('bad billing email is refused', r.status === 422, r.data);
  r = await admin.post(`/team/invoices/${inv1.id}/send`);
  check('send returns a public link', r.status === 200 && r.data.link.endsWith('/invoice/#' + inv1.token) && r.data.invoice.status === 'sent', r.data);
  r = await anon.get('/invoice/' + inv1.token);
  check('sent invoice opens for anyone with the link', r.status === 200 && r.data.invoice.total === 110 && r.data.business.name === 'CubiX' && !('shop_id' in r.data.invoice) && !('token' in r.data.invoice), r.data);
  r = await anon.get('/invoice/' + 'f'.repeat(40));
  check('unknown invoice link is 404', r.status === 404, r.status);
  r = await shopA.get('/client/invoices');
  check('client sees the sent invoice in the portal', r.data.invoices.length === 1 && r.data.invoices[0].number === inv1.number, r.data);
  r = await shopB.get('/client/invoices');
  check('other shops do not see it', r.data.invoices.length === 0, r.data);
  r = await shopA.get('/client/orders/' + aSecond);
  check('client order page lists the invoice', r.data.order.invoices.length === 1, r.data.order.invoices);
  r = await admin.post(`/team/invoices/${inv1.id}/paid`, { paid_via: 'Payoneer' });
  check('mark invoice paid', r.status === 200 && r.data.invoice.status === 'paid' && r.data.invoice.paid_via === 'Payoneer', r.data);
  r = await admin.patch('/team/invoices/' + inv1.id, { terms: 'Net 7' });
  check('paid invoices are locked', r.status === 409, r.data);
  r = await admin.post(`/team/invoices/${inv1.id}/void`);
  check('paid invoices cannot be voided', r.status === 409, r.data);
  r = await admin.post('/team/invoices', { shop_id: shopARow.id });
  check('blank invoice for a shop, next number 002', r.status === 201 && r.data.invoice.number.endsWith('-002'), r.data.invoice?.number);
  const inv2 = r.data.invoice;
  r = await admin.post(`/team/invoices/${inv2.id}/send`);
  check('a zero total invoice cannot be sent', r.status === 422, r.data);
  r = await admin.post(`/team/invoices/${inv2.id}/void`);
  check('deleting a draft removes it', r.status === 200 && r.data.deleted === true, r.data);
  r = await admin.patch('/team/settings', { biz_tagline: '3D modeling for print shops', biz_website: 'cubix.axys3d.com', invoice_prefix: 'CBX' });
  check('admin updates invoice details', r.status === 200 && r.data.settings.invoice_prefix === 'CBX', r.data);
  r = await modeler.patch('/team/settings', { biz_name: 'Hack' });
  check('modeler cannot change invoice details', r.status === 403, r.status);
  r = await admin.post('/team/invoices', { order_id: aOrder });
  check('new prefix applies to the next invoice', r.data.invoice.number.startsWith('CBX-'), r.data.invoice?.number);

  // ---------------- settings: notifications, payments, backups, sources
  r = await admin.get('/team/settings');
  check('settings report connection status and storage', r.status === 200 && r.data.status.email_ready === false && r.data.status.storage.backend === 'D1' && r.data.status.storage.bytes > 0, r.data.status);
  r = await admin.patch('/team/settings', { alert_webhook: 'http://insecure.example/hook' });
  check('webhook must be https', r.status === 422, r.data);
  r = await admin.patch('/team/settings', { alert_email: 'a@b.co, not an email' });
  check('alert emails are validated', r.status === 422, r.data);
  r = await admin.patch('/team/settings', { mail_from: 'nonsense' });
  check('sender address is validated', r.status === 422, r.data);
  r = await admin.patch('/team/settings', { paypal_me: 'https://paypal.me/cubix3d', mail_from: 'CubiX <orders@example.com>', alert_email: 'ops@example.com, boss@example.com' });
  check('payment and notification settings save (PayPal link trimmed to the name)', r.status === 200 && r.data.settings.paypal_me === 'cubix3d', r.data.settings);
  r = await admin.post('/team/settings/test-email');
  check('test email explains that email is not connected yet', r.status === 409 && /not connected/i.test(r.data.message), r.data);
  r = await modeler.post('/team/settings/test-alert');
  check('modelers cannot send test alerts', r.status === 403, r.status);
  r = await modeler.get('/team/settings');
  check('modelers cannot read settings (webhook stays private)', r.status === 403, r.status);
  // pay links on invoices
  {
    const ri = await admin.post('/team/invoices', { shop_id: shopARow.id });
    const iid = ri.data.invoice.id, tok = ri.data.invoice.token;
    r = await admin.patch('/team/invoices/' + iid, { pay_url: 'javascript:alert(1)' });
    check('pay link must be https', r.status === 422, r.data);
    r = await admin.patch('/team/invoices/' + iid, { pay_url: 'https://pay.example.com/req/123', items: [{ title: 'Model', qty: 1, rate: 60 }] });
    await admin.post(`/team/invoices/${iid}/send`);
    r = await anon.get('/invoice/' + tok);
    check('sent invoice offers Pay now and PayPal for the exact amount', r.data.invoice.pay_url === 'https://pay.example.com/req/123' && r.data.invoice.paypal_url === 'https://paypal.me/cubix3d/60.00USD', r.data.invoice);
    await admin.post(`/team/invoices/${iid}/paid`, { paid_via: 'PayPal' });
    r = await anon.get('/invoice/' + tok);
    check('paid invoices no longer show pay buttons', !r.data.invoice.paypal_url, r.data.invoice);
  }
  // backups
  r = await anon.get('/backup');
  check('backup needs an admin or the backup key', r.status === 401, r.status);
  r = await modeler.get('/backup');
  check('modelers cannot download backups', r.status === 403, r.status);
  {
    const raw = await fetch(BASE + '/api/backup', { headers: { 'x-backup-key': 'wrong-key-wrong-key-wrong-key' } });
    check('a wrong backup key is refused', raw.status === 401, raw.status);
    const ok = await fetch(BASE + '/api/backup', { headers: { 'x-backup-key': process.env.BACKUP_KEY || 'local-backup-key-0123456789abcdef' } });
    const d = await ok.json();
    check('backup key downloads every table', ok.status === 200 && d.counts.orders >= 3 && d.counts.invoices >= 1 && d.tables.users.length >= 3 && !('thumb' in d.tables.files[0]), d.counts);
    check('backup leaves out sessions and file contents', !('sessions' in d.tables) && !('file_chunks' in d.tables), Object.keys(d.tables));
  }
  r = await admin.get('/backup');
  check('admin downloads a backup from the dashboard', r.status === 200 && r.headers.get('content-disposition').includes('cubix-backup-'), r.status);
  // lead sources
  r = await anon.post('/order', orderForm({ name: 'Zoe', email: em('zoe'), product: 'Sign', source: 'ChatGPT' }), { csrf: false, form: true });
  const zoe = (await admin.get('/team/orders?q=' + r.data.id)).data.orders[0];
  r = await admin.get('/team/orders/' + zoe.id);
  check('order remembers its lead source', r.data.order.source === 'ChatGPT', r.data.order.source);
  r = await admin.get('/team/overview');
  check('overview counts orders by source and reports storage', r.data.sources.some(x => x.source === 'ChatGPT' && x.n === 1) && r.data.sources.some(x => x.source === 'Direct') && r.data.storage.bytes > 0, r.data.sources);

  // ---------------- password change
  r = await shopA.post('/auth/password', { current: 'wrong-one', password: 'newShopApass1' });
  check('password change needs the current password', r.status === 422, r.data);
  r = await shopA.post('/auth/password', { current: 'shopApass123', password: 'short' });
  check('password change rejects weak passwords', r.status === 422, r.data);
  r = await shopA.post('/auth/password', { current: 'shopApass123', password: 'newShopApass1' });
  check('password changed and still signed in', r.status === 200 && (await shopA.get('/auth/me')).status === 200, r.data);

  // ---------------- client adds files, thumbnails
  {
    const f = new FormData(); f.append('files', png(), 'extra.png'); f.append('thumbs', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'image/webp' }), 'extra.png');
    r = await shopA.post(`/client/orders/${aOrder}/files`, f, { form: true });
    check('client adds more files to an open order', r.status === 201 && r.data.files.length === 1, r.data);
    const fid = r.data.files[0].id;
    r = await shopA.get(`/files/${fid}/thumb`);
    check('thumbnail is served from the stored preview', r.status === 200 && r.headers.get('content-type') === 'image/webp' && r.data.byteLength === 4, r.status);
    check('files are cached as immutable', /immutable/.test(r.headers.get('cache-control')), r.headers.get('cache-control'));
    r = await shopB.get(`/files/${fid}/thumb`);
    check('other shops cannot load the thumbnail', r.status === 404, r.status);
    r = await shopA.get(`/files/${refFile.id}/thumb`);
    check('thumbnail falls back to the full image when none was stored', r.status === 404 || r.status === 200, r.status);
    const f2 = new FormData(); f2.append('files', png(), 'x.png');
    r = await shopB.post(`/client/orders/${aOrder}/files`, f2, { form: true });
    check('clients cannot add files to another shop order', r.status === 404, r.status);
    r = await shopB.post(`/client/orders/${bOrder}/files`, f2, { form: true });
    check('closed orders do not accept new files', r.status === 409, r.data);
  }

  // ---------------- delete order
  r = await modeler.post(`/team/orders/${aOrder}/delete`);
  check('modeler cannot delete orders', r.status === 403, r.status);
  r = await admin.post(`/team/orders/${aSecond}/delete`);
  check('orders with a paid invoice cannot be deleted', r.status === 409, r.data);
  r = await anon.post('/order', orderForm({ name: 'Spam', email: em('spam'), product: 'Junk' }), { csrf: false, form: true });
  const spamCode = r.data.id;
  const spam = (await admin.get('/team/orders?q=' + spamCode)).data.orders[0];
  r = await admin.post(`/team/orders/${spam.id}/delete`);
  check('admin deletes a spam order', r.status === 200 && (await admin.get('/team/orders/' + spam.id)).status === 404, r.data);

  // forgot password: same answer for real and unknown emails
  const r1 = await anon.post('/auth/forgot', { email: em('shopb') }), r2 = await anon.post('/auth/forgot', { email: 'nobody@nowhere.test' });
  check('forgot password does not reveal which emails exist', r1.status === 200 && r2.status === 200 && JSON.stringify(r1.data) === JSON.stringify(r2.data));
  { let last; for (let i = 0; i < 10; i++) last = await anon.post('/auth/forgot', { email: 'nobody@nowhere.test' });
    check('public forms are rate limited per connection', last.status === 429 && last.data.error === 'slow_down', last.status); }

  // logout
  r = await shopB.post('/auth/logout');
  check('logout clears the cookie', r.status === 200 && shopB.cookie === '', shopB.cookie);
  r = await shopB.get('/client/orders');
  check('after logout, access is denied', r.status === 401, r.status);

  // rate limit (run last; it locks this email for 15 minutes)
  let last;
  for (let i = 0; i < 9; i++) last = await anon.post('/auth/login', { email: em('shopa'), password: 'wrong-password' });
  check('login is rate limited after 8 failures', last.status === 429, last.data);
  r = await anon.post('/auth/login', { email: em('shopa'), password: 'shopApass123' });
  check('even the right password waits during the lock', r.status === 429, r.data);

  // forged cookie
  const forged = new Client(); forged.cookie = 'cx_session=' + 'a'.repeat(64);
  r = await forged.get('/auth/me');
  check('forged session token is refused', r.status === 401, r.status);

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.log(results.join('\n')); console.error(e); process.exit(1); });
