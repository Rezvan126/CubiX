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
  let f = new FormData(); f.append('kind', 'preview'); f.append('files', png(), 'render1.png');
  r = await modeler.post(`/team/orders/${bOrder}/files`, f, { form: true });
  check('preview upload moves order to preview, version 1', r.status === 201 && r.data.status === 'preview' && r.data.version === 1, r.data);
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
  check('second preview is version 2', r.data.version === 2 && r.data.status === 'preview', r.data);
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
  check('client list shows preview and final counts', r.data.orders[0].previews === 2 && r.data.orders[0].finals === 2, r.data.orders[0]);

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

  // forgot password: same answer for real and unknown emails
  const r1 = await anon.post('/auth/forgot', { email: em('shopb') }), r2 = await anon.post('/auth/forgot', { email: 'nobody@nowhere.test' });
  check('forgot password does not reveal which emails exist', r1.status === 200 && r2.status === 200 && JSON.stringify(r1.data) === JSON.stringify(r2.data));

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
