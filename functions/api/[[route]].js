// CubiX API. One router for the public order form, the client portal (/app) and the team dashboard (/team).
import {
  STATUSES, OPEN_STATUSES, PLANS, TURNAROUND_HOURS, HttpError, json, now, addHours, uid, orderCode,
  hashPassword, verifyPassword, clean, validEmail, validPassword, createSession, clearCookie, getUser,
  destroySession, makeLinkToken, useLinkToken, siteUrl, sendEmail, notifyTeam, logEvent, storeFiles,
  readBody, field, sha256, readFile,
} from '../_lib/core.js';

const routes = [];
const on = (method, pattern, roles, handler) => {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, roles, handler });
};
const TEAM = ['admin', 'modeler'], ADMIN = ['admin'], CLIENT = ['client'], ANY = ['admin', 'modeler', 'client'], PUBLIC = null;

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (!env.DB) throw new HttpError(500, 'not_configured', 'Database is not configured.');
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    const route = routes.find(r => r.method === request.method && r.re.test(path));
    if (!route) throw new HttpError(404, 'not_found');
    // CSRF: browsers cannot send this header cross site without a CORS preflight, which we never allow.
    if (request.method !== 'GET' && path !== '/order' && request.headers.get('x-cubix') !== '1') throw new HttpError(403, 'csrf');
    const params = {}; const m = path.match(route.re); route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    let user = null;
    if (route.roles) {
      user = await getUser(request, env);
      if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
      if (!route.roles.includes(user.role)) throw new HttpError(403, 'forbidden', 'You do not have access to this.');
    }
    return await route.handler({ request, env, url, params, user });
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ ok: false, error: 'server_error', message: 'Something went wrong on our side. Please try again.' }, 500);
  }
}

// ---------------------------------------------------------------- helpers
const one = (env, sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const all = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
const isTeam = u => u && (u.role === 'admin' || u.role === 'modeler');

async function loadOrder(env, id, user) {
  const o = await one(env, `SELECT o.*, s.name AS shop_name, s.url AS shop_url, s.plan AS shop_plan, a.name AS assignee_name
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id WHERE o.id = ? OR o.code = ?`, id, id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  if (!isTeam(user) && o.shop_id !== user.shop_id) throw new HttpError(404, 'not_found', 'Order not found.');
  return o;
}
async function orderDetail(env, o, user) {
  const team = isTeam(user);
  const files = await all(env, 'SELECT id, kind, version, name, size, type, created_at FROM files WHERE order_id = ? ORDER BY created_at', o.id);
  const messages = await all(env, `SELECT m.id, m.body, m.internal, m.created_at, u.name AS author, u.role AS author_role
      FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.order_id = ? ${team ? '' : 'AND m.internal = 0'} ORDER BY m.created_at`, o.id);
  const events = await all(env, `SELECT e.type, e.detail, e.created_at, u.name AS who FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.order_id = ? ${team ? '' : "AND e.type NOT IN ('assigned','note','price')"} ORDER BY e.id`, o.id);
  const out = { ...o, files, messages, events };
  if (!team) { delete out.assignee_id; delete out.assignee_name; }
  return out;
}
function dueFor(priority, from = now()) { return addHours(from, priority === 'rush' ? 24 : TURNAROUND_HOURS); }

async function createOrder(env, { shop, userId, body, files }) {
  const id = uid('o_'), at = now();
  let code = orderCode();
  for (let i = 0; i < 3 && await one(env, 'SELECT 1 FROM orders WHERE code = ?', code); i++) code = orderCode();
  const isFree = shop.free_used ? 0 : 1;
  const product = clean(field(body, 'product'), 80) || 'Custom model';
  const title = clean(field(body, 'title'), 120) || product;
  const formats = body instanceof FormData ? body.getAll('formats').map(x => clean(x, 40)).filter(Boolean).join(', ') : clean(field(body, 'formats'), 200);
  const priority = field(body, 'priority') === 'rush' ? 'rush' : 'normal';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO orders (id, code, shop_id, created_by, title, product, size, printer, formats, notes, channel, status, priority, is_free, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`).bind(id, code, shop.id, userId, title, product, clean(field(body, 'size'), 120),
      clean(field(body, 'printer'), 120), formats, clean(field(body, 'notes'), 4000), clean(field(body, 'channel'), 40) || 'Direct', priority, isFree, dueFor(priority, at), at, at),
    env.DB.prepare('UPDATE shops SET free_used = 1 WHERE id = ?').bind(shop.id),
  ]);
  try { await storeFiles(env, id, files, 'reference', userId); }
  catch (e) { await env.DB.batch([env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id), env.DB.prepare('UPDATE shops SET free_used = ? WHERE id = ?').bind(shop.free_used, shop.id)]); throw e; }
  await logEvent(env, id, userId, 'created', isFree ? 'Free first model' : null);
  await notifyTeam(env, `New order ${code} from ${shop.name}${isFree ? ' (free first model)' : ''}: ${title}`);
  return { id, code, free: !!isFree };
}

// ---------------------------------------------------------------- auth
on('POST', '/auth/login', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request);
  const email = clean(field(b, 'email'), 200).toLowerCase(), password = String(field(b, 'password') || '');
  const since = addHours(now(), -0.25);
  const tries = await one(env, 'SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at > ?', email, since);
  if (tries.n >= 8) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
  const u = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (!u || !u.active || !(await verifyPassword(password, u.password_hash, u.password_salt))) {
    await env.DB.prepare('INSERT INTO login_attempts (email, at) VALUES (?, ?)').bind(email, now()).run();
    throw new HttpError(401, 'bad_credentials', 'Email or password is not correct.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE email = ? OR at < ?').bind(email, since).run();
  const s = await createSession(env, u.id);
  return json({ ok: true, user: { id: u.id, name: u.name, email: u.email, role: u.role } }, 200, { 'set-cookie': s.cookie });
});
on('POST', '/auth/logout', PUBLIC, async ({ request, env }) => { await destroySession(request, env); return json({ ok: true }, 200, { 'set-cookie': clearCookie }); });
on('GET', '/auth/me', ANY, async ({ env, user }) => {
  const shop = user.shop_id ? await one(env, 'SELECT id, name, url, plan, free_used FROM shops WHERE id = ?', user.shop_id) : null;
  return json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role }, shop });
});
on('POST', '/auth/signup', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request);
  const name = clean(field(b, 'name'), 120), email = clean(field(b, 'email'), 200).toLowerCase(), password = String(field(b, 'password') || '');
  const shopName = clean(field(b, 'shop'), 120) || name, shopUrl = clean(field(b, 'url'), 300);
  if (!name) throw new HttpError(422, 'invalid', 'Add your name.');
  if (!validEmail(email)) throw new HttpError(422, 'invalid', 'Add a valid email address.');
  validPassword(password);
  if (await one(env, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'exists', 'An account with this email already exists. Sign in, or use "Forgot password".');
  const shopId = uid('s_'), userId = uid('u_'), at = now(), p = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shops (id, name, url, created_at) VALUES (?, ?, ?, ?)').bind(shopId, shopName, shopUrl, at),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, shop_id, password_hash, password_salt, created_at) VALUES (?, ?, ?, 'client', ?, ?, ?, ?)`).bind(userId, email, name, shopId, p.hash, p.salt, at),
  ]);
  const s = await createSession(env, userId);
  await notifyTeam(env, `New shop signed up: ${shopName} (${email})`);
  return json({ ok: true }, 201, { 'set-cookie': s.cookie });
});
on('POST', '/auth/forgot', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request); const email = clean(field(b, 'email'), 200).toLowerCase();
  const u = validEmail(email) && await one(env, 'SELECT id, name FROM users WHERE email = ? AND active = 1', email);
  if (u) {
    const t = await makeLinkToken(env, u.id, 'reset', 2);
    const link = `${siteUrl(request, env)}/app/#/setup/${t}`;
    await sendEmail(env, email, 'Reset your CubiX password', `Hi ${u.name},\n\nUse this link within 2 hours to set a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`);
  }
  return json({ ok: true }); // same answer either way, so emails cannot be probed
});
on('POST', '/auth/setup', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request); const password = String(field(b, 'password') || '');
  validPassword(password);
  const t = await useLinkToken(env, clean(field(b, 'token'), 100));
  const p = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(p.hash, p.salt, t.user_id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(t.user_id).run();
  const u = await one(env, 'SELECT id, role FROM users WHERE id = ?', t.user_id);
  const s = await createSession(env, u.id);
  return json({ ok: true, role: u.role }, 200, { 'set-cookie': s.cookie });
});
// First admin. Works only while no admin exists and only with the BOOTSTRAP_KEY secret.
on('POST', '/auth/bootstrap', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request);
  if (!env.BOOTSTRAP_KEY || field(b, 'key') !== env.BOOTSTRAP_KEY) throw new HttpError(403, 'forbidden');
  if (await one(env, "SELECT 1 FROM users WHERE role = 'admin'")) throw new HttpError(409, 'exists', 'An admin already exists.');
  const name = clean(field(b, 'name'), 120), email = clean(field(b, 'email'), 200).toLowerCase(), password = String(field(b, 'password') || '');
  if (!name || !validEmail(email)) throw new HttpError(422, 'invalid', 'Add a name and a valid email.');
  validPassword(password);
  const p = await hashPassword(password), id = uid('u_');
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash, password_salt, capacity, created_at) VALUES (?, ?, ?, 'admin', ?, ?, 6, ?)`).bind(id, email, name, p.hash, p.salt, now()).run();
  return json({ ok: true }, 201);
});

// ---------------------------------------------------------------- public order form (website "Get a free model")
on('POST', '/order', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request);
  if (!(b instanceof FormData)) throw new HttpError(400, 'bad_form');
  if (b.get('company_website')) return json({ ok: true, id: 'CX000000' }); // spam trap
  const name = clean(b.get('name'), 120), email = clean(b.get('email'), 200).toLowerCase();
  if (!name || !validEmail(email)) throw new HttpError(422, 'invalid', 'Add your name and a valid email address.');
  const files = b.getAll('files');
  if (!files.some(f => typeof f === 'object' && f.size > 0)) throw new HttpError(422, 'no_files', 'Add at least one photo or file.');
  let u = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (u && u.role !== 'client') throw new HttpError(422, 'invalid', 'Use a shop email address for orders.');
  let shop;
  if (u) shop = await one(env, 'SELECT * FROM shops WHERE id = ?', u.shop_id);
  else {
    shop = { id: uid('s_'), name: clean(b.get('shop'), 120) || name, url: clean(b.get('shop'), 300), free_used: 0 };
    u = { id: uid('u_') };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO shops (id, name, url, created_at) VALUES (?, ?, ?, ?)').bind(shop.id, shop.name, shop.url, now()),
      env.DB.prepare(`INSERT INTO users (id, email, name, role, shop_id, created_at) VALUES (?, ?, ?, 'client', ?, ?)`).bind(u.id, email, name, shop.id, now()),
    ]);
  }
  const r = await createOrder(env, { shop, userId: u.id, body: b, files });
  return json({ ok: true, id: r.code, free: r.free }, 201);
});

// ---------------------------------------------------------------- client portal
on('GET', '/client/orders', CLIENT, async ({ env, user }) => {
  const orders = await all(env, `SELECT o.id, o.code, o.title, o.product, o.status, o.is_free, o.price, o.paid, o.due_at, o.created_at, o.updated_at,
      (SELECT COUNT(*) FROM files f WHERE f.order_id = o.id AND f.kind = 'preview') AS previews,
      (SELECT COUNT(*) FROM files f WHERE f.order_id = o.id AND f.kind = 'final') AS finals,
      (SELECT f.id FROM files f WHERE f.order_id = o.id AND f.kind IN ('preview','reference') AND f.type LIKE 'image/%' ORDER BY (f.kind = 'preview') DESC, f.created_at DESC LIMIT 1) AS thumb
      FROM orders o WHERE o.shop_id = ? ORDER BY o.created_at DESC`, user.shop_id);
  return json({ ok: true, orders });
});
on('POST', '/client/orders', CLIENT, async ({ request, env, user }) => {
  const b = await readBody(request);
  if (!(b instanceof FormData)) throw new HttpError(400, 'bad_form');
  const files = b.getAll('files');
  if (!files.some(f => typeof f === 'object' && f.size > 0)) throw new HttpError(422, 'no_files', 'Add at least one photo or file.');
  const shop = await one(env, 'SELECT * FROM shops WHERE id = ?', user.shop_id);
  const r = await createOrder(env, { shop, userId: user.id, body: b, files });
  return json({ ok: true, ...r }, 201);
});
on('GET', '/client/orders/:id', CLIENT, async ({ env, params, user }) => json({ ok: true, order: await orderDetail(env, await loadOrder(env, params.id, user), user) }));
on('POST', '/client/orders/:id/messages', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  const body = clean(field(b, 'body'), 4000); if (!body) throw new HttpError(422, 'invalid', 'Write a message first.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(uid('m_'), o.id, user.id, body, now()),
    env.DB.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').bind(now(), o.id),
  ]);
  await notifyTeam(env, `Message on ${o.code} from ${o.shop_name}: ${body.slice(0, 200)}`);
  return json({ ok: true }, 201);
});
on('POST', '/client/orders/:id/approve', CLIENT, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  if (!['preview', 'delivered'].includes(o.status)) throw new HttpError(409, 'bad_state', 'There is nothing to approve yet.');
  const status = o.status === 'preview' ? 'approved' : 'delivered';
  await env.DB.prepare('UPDATE orders SET status = ?, approved_at = ?, updated_at = ? WHERE id = ?').bind(status, now(), now(), o.id).run();
  await logEvent(env, o.id, user.id, 'approved');
  await notifyTeam(env, `${o.code} approved by ${o.shop_name}`);
  return json({ ok: true, status });
});
on('POST', '/client/orders/:id/revision', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (!['preview', 'delivered', 'approved'].includes(o.status)) throw new HttpError(409, 'bad_state', 'Revisions can be asked once a preview is ready.');
  const body = clean(field(b, 'body'), 4000); if (!body) throw new HttpError(422, 'invalid', 'Tell us what to change.');
  const at = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = 'revisions', revisions = revisions + 1, approved_at = NULL, due_at = ?, updated_at = ? WHERE id = ?`).bind(addHours(at, 24), at, o.id),
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(uid('m_'), o.id, user.id, 'Revision request: ' + body, at),
  ]);
  await logEvent(env, o.id, user.id, 'revision', body.slice(0, 200));
  await notifyTeam(env, `Revision requested on ${o.code}: ${body.slice(0, 200)}`);
  return json({ ok: true });
});

// ---------------------------------------------------------------- files (shared, access checked)
on('GET', '/files/:id', ANY, async ({ env, params, user, url }) => {
  const f = await one(env, 'SELECT f.*, o.shop_id FROM files f JOIN orders o ON o.id = f.order_id WHERE f.id = ?', params.id);
  if (!f || (!isTeam(user) && f.shop_id !== user.shop_id)) throw new HttpError(404, 'not_found', 'File not found.');
  const body = await readFile(env, f.r2_key);
  if (!body) throw new HttpError(404, 'not_found', 'File not found.');
  const inline = url.searchParams.get('inline') === '1' && /^image\//.test(f.type || '');
  return new Response(body, { headers: {
    'content-length': String(f.size),
    'content-type': inline ? f.type : (f.type || 'application/octet-stream'),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/["\\\r\n]/g, '_')}"`,
    'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff',
  } });
});

// ---------------------------------------------------------------- team dashboard
on('GET', '/team/overview', TEAM, async ({ env }) => {
  const t = now(), soon = addHours(t, 24), monthStart = t.slice(0, 7) + '-01T00:00:00.000Z';
  const open = OPEN_STATUSES.filter(s => s !== 'approved');
  const ph = open.map(() => '?').join(',');
  const byStatus = await all(env, 'SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const overdue = await one(env, `SELECT COUNT(*) AS n FROM orders WHERE status IN (${ph}) AND due_at < ?`, ...open, t);
  const dueSoon = await one(env, `SELECT COUNT(*) AS n FROM orders WHERE status IN (${ph}) AND due_at >= ? AND due_at < ?`, ...open, t, soon);
  const unassigned = await one(env, `SELECT COUNT(*) AS n FROM orders WHERE status IN (${ph}) AND assignee_id IS NULL`, ...open);
  const awaiting = await one(env, `SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS total FROM orders WHERE status IN ('delivered','approved') AND paid = 0 AND is_free = 0`);
  const paidMonth = await one(env, 'SELECT COALESCE(SUM(price), 0) AS total, COUNT(*) AS n FROM orders WHERE paid = 1 AND updated_at >= ?', monthStart);
  const delivered30 = await all(env, 'SELECT created_at, delivered_at FROM orders WHERE delivered_at IS NOT NULL AND delivered_at >= ?', addHours(t, -24 * 30));
  const avgHours = delivered30.length ? delivered30.reduce((s, o) => s + (new Date(o.delivered_at) - new Date(o.created_at)) / 3600e3, 0) / delivered30.length : null;
  const team = await all(env, `SELECT u.id, u.name, u.role, u.capacity,
      (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.status IN (${ph})) AS open,
      (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.status IN (${ph}) AND o.due_at < ?) AS overdue,
      (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.delivered_at >= ?) AS delivered_7d
      FROM users u WHERE u.role IN ('admin','modeler') AND u.active = 1 ORDER BY u.name`, ...open, ...open, t, addHours(t, -24 * 7));
  const capacity = team.reduce((s, m) => s + m.capacity, 0), load = team.reduce((s, m) => s + m.open, 0);
  const newShops = await one(env, 'SELECT COUNT(*) AS n FROM shops WHERE created_at >= ?', monthStart);
  const attention = await all(env, `SELECT o.id, o.code, o.title, o.status, o.due_at, o.priority, o.is_free, s.name AS shop_name, a.name AS assignee_name
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id
      WHERE o.status IN (${ph}) AND (o.due_at < ? OR o.assignee_id IS NULL OR o.status = 'revisions') ORDER BY o.due_at LIMIT 12`, ...open, soon);
  return json({ ok: true, byStatus, overdue: overdue.n, dueSoon: dueSoon.n, unassigned: unassigned.n, awaiting, paidMonth, avgHours, deliveredLast30: delivered30.length, team, capacity, load, newShops: newShops.n, attention });
});

on('GET', '/team/orders', TEAM, async ({ env, url, user }) => {
  const q = url.searchParams, where = [], b = [];
  const status = q.get('status');
  if (status === 'open') { where.push(`o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); b.push(...OPEN_STATUSES); }
  else if (status && STATUSES.includes(status)) { where.push('o.status = ?'); b.push(status); }
  const assignee = q.get('assignee');
  if (assignee === 'me') { where.push('o.assignee_id = ?'); b.push(user.id); }
  else if (assignee === 'none') where.push('o.assignee_id IS NULL');
  else if (assignee) { where.push('o.assignee_id = ?'); b.push(assignee); }
  if (q.get('shop')) { where.push('o.shop_id = ?'); b.push(q.get('shop')); }
  if (q.get('due') === 'overdue') { where.push(`o.due_at < ? AND o.status IN (${OPEN_STATUSES.filter(s => s !== 'approved').map(() => '?').join(',')})`); b.push(now(), ...OPEN_STATUSES.filter(s => s !== 'approved')); }
  if (q.get('unpaid') === '1') where.push("o.paid = 0 AND o.is_free = 0 AND o.status IN ('delivered','approved')");
  const term = clean(q.get('q'), 80);
  if (term) { where.push('(o.code LIKE ? OR o.title LIKE ? OR s.name LIKE ?)'); b.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  const sort = q.get('sort') === 'new' ? 'o.created_at DESC' : "CASE o.priority WHEN 'rush' THEN 0 ELSE 1 END, o.due_at";
  const orders = await all(env, `SELECT o.id, o.code, o.title, o.product, o.status, o.priority, o.is_free, o.price, o.paid, o.paid_via, o.due_at, o.created_at, o.updated_at, o.revisions,
      o.assignee_id, a.name AS assignee_name, s.id AS shop_id, s.name AS shop_name, s.plan AS shop_plan,
      (SELECT COUNT(*) FROM files f WHERE f.order_id = o.id) AS file_count,
      (SELECT COUNT(*) FROM messages m WHERE m.order_id = o.id) AS message_count,
      (SELECT f.id FROM files f WHERE f.order_id = o.id AND f.type LIKE 'image/%' ORDER BY (f.kind = 'preview') DESC, f.created_at DESC LIMIT 1) AS thumb
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT 300`, ...b);
  return json({ ok: true, orders });
});
on('GET', '/team/orders/:id', TEAM, async ({ env, params, user }) => json({ ok: true, order: await orderDetail(env, await loadOrder(env, params.id, user), user) }));

on('PATCH', '/team/orders/:id', TEAM, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  const set = [], vals = [], events = [];
  const admin = user.role === 'admin';
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw new HttpError(422, 'invalid', 'Unknown status.');
    if (b.status === 'paid' && !admin) throw new HttpError(403, 'forbidden', 'Only an admin can mark orders as paid.');
    if (b.status !== o.status) {
      set.push('status = ?'); vals.push(b.status); events.push(['status', `${o.status} to ${b.status}`]);
      if (b.status === 'delivered' && !o.delivered_at) { set.push('delivered_at = ?'); vals.push(now()); }
      if (b.status === 'paid' && b.paid === undefined) { set.push('paid = 1'); }
    }
  }
  if (b.assignee_id !== undefined) {
    const target = b.assignee_id || null;
    if (!admin && target && target !== user.id) throw new HttpError(403, 'forbidden', 'Modelers can only assign orders to themselves.');
    if (!admin && !target && o.assignee_id && o.assignee_id !== user.id) throw new HttpError(403, 'forbidden', 'This order belongs to someone else.');
    if (target) {
      const m = await one(env, "SELECT name FROM users WHERE id = ? AND role IN ('admin','modeler') AND active = 1", target);
      if (!m) throw new HttpError(422, 'invalid', 'Pick an active team member.');
      events.push(['assigned', m.name]);
      if (o.status === 'new') { set.push('status = ?'); vals.push('confirmed'); events.push(['status', 'new to confirmed']); }
    } else events.push(['assigned', 'Unassigned']);
    set.push('assignee_id = ?'); vals.push(target);
  }
  for (const [k, adminOnly] of [['priority', false], ['due_at', false], ['price', true], ['paid', true], ['paid_via', true], ['title', false]]) {
    if (b[k] === undefined) continue;
    if (adminOnly && !admin) throw new HttpError(403, 'forbidden', 'Only an admin can change pricing and payments.');
    let v = b[k];
    if (k === 'priority') { if (!['normal', 'rush'].includes(v)) throw new HttpError(422, 'invalid'); }
    if (k === 'due_at') { if (isNaN(Date.parse(v))) throw new HttpError(422, 'invalid', 'Pick a valid due date.'); v = new Date(v).toISOString(); }
    if (k === 'price') { v = v === '' || v === null ? null : Number(v); if (v !== null && (!isFinite(v) || v < 0 || v > 100000)) throw new HttpError(422, 'invalid', 'Enter a valid price.'); }
    if (k === 'paid') {
      v = v ? 1 : 0; const st = b.status || o.status;
      if (v && !['approved', 'delivered', 'paid'].includes(st)) throw new HttpError(409, 'bad_state', 'Payment comes after the client approves the model.');
      // Paid and delivered closes the order. Paid while still approved keeps it in production until the final files go out.
      if (v && st === 'delivered') { set.push('status = ?'); vals.push('paid'); events.push(['status', `${o.status} to paid`]); }
      if (!v && st === 'paid' && b.status === undefined) { set.push('status = ?'); vals.push('delivered'); events.push(['status', 'paid to delivered']); }
    }
    if (k === 'paid_via') { v = clean(v, 40) || null; }
    if (k === 'title') { v = clean(v, 120); if (!v) throw new HttpError(422, 'invalid'); }
    set.push(`${k} = ?`); vals.push(v); events.push([k === 'price' || k === 'paid' || k === 'paid_via' ? 'price' : k, `${k}: ${v ?? 'none'}`]);
  }
  if (!set.length) return json({ ok: true, unchanged: true });
  set.push('updated_at = ?'); vals.push(now());
  await env.DB.prepare(`UPDATE orders SET ${set.join(', ')} WHERE id = ?`).bind(...vals, o.id).run();
  for (const [t, d] of events) await logEvent(env, o.id, user.id, t, d);
  return json({ ok: true, order: await orderDetail(env, await loadOrder(env, o.id, user), user) });
});

on('POST', '/team/orders/:id/messages', TEAM, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  const body = clean(field(b, 'body'), 4000); if (!body) throw new HttpError(422, 'invalid', 'Write a message first.');
  const internal = field(b, 'internal') ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(uid('m_'), o.id, user.id, body, internal, now()),
    env.DB.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').bind(now(), o.id),
  ]);
  if (!internal) {
    const c = await one(env, 'SELECT email, name FROM users WHERE id = ?', o.created_by);
    if (c) await sendEmail(env, c.email, `New message on order ${o.code}`, `Hi ${c.name},\n\n${body}\n\nReply in your CubiX portal: ${siteUrl(request, env)}/app/#/orders/${o.id}`);
  }
  return json({ ok: true }, 201);
});

on('POST', '/team/orders/:id/files', TEAM, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (!(b instanceof FormData)) throw new HttpError(400, 'bad_form');
  const kind = b.get('kind');
  if (!['preview', 'final', 'reference'].includes(kind)) throw new HttpError(422, 'invalid', 'Pick preview or final files.');
  const files = b.getAll('files');
  if (!files.some(f => typeof f === 'object' && f.size > 0)) throw new HttpError(422, 'no_files', 'Choose at least one file.');
  const r = await storeFiles(env, o.id, files, kind, user.id);
  const at = now(); let status = o.status;
  if (kind === 'preview' && ['new', 'confirmed', 'modeling', 'revisions'].includes(o.status)) status = 'preview';
  if (kind === 'final' && o.status !== 'cancelled') status = o.paid ? 'paid' : 'delivered';
  await env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ?, delivered_at = CASE WHEN ? = 'final' AND delivered_at IS NULL THEN ? ELSE delivered_at END WHERE id = ?`).bind(status, at, kind, at, o.id).run();
  await logEvent(env, o.id, user.id, kind === 'final' ? 'delivered' : 'preview', `Version ${r.version}, ${r.files.length} file(s)`);
  if (status !== o.status) await logEvent(env, o.id, user.id, 'status', `${o.status} to ${status}`);
  const c = await one(env, 'SELECT email, name FROM users WHERE id = ?', o.created_by);
  if (c) await sendEmail(env, c.email, kind === 'final' ? `Your files for ${o.code} are ready` : `Preview ready for ${o.code}`,
    `Hi ${c.name},\n\n${kind === 'final' ? 'Your print ready files are ready to download.' : 'A preview of your model is ready. Approve it or ask for changes.'}\n\n${siteUrl(request, env)}/app/#/orders/${o.id}`);
  return json({ ok: true, version: r.version, status }, 201);
});

on('GET', '/team/shops', TEAM, async ({ env }) => {
  const shops = await all(env, `SELECT s.*, (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) AS orders,
      (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id AND o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})) AS open_orders,
      (SELECT COALESCE(SUM(price), 0) FROM orders o WHERE o.shop_id = s.id AND o.paid = 1) AS revenue,
      (SELECT MAX(created_at) FROM orders o WHERE o.shop_id = s.id) AS last_order,
      (SELECT email FROM users u WHERE u.shop_id = s.id ORDER BY created_at LIMIT 1) AS email,
      (SELECT COUNT(*) FROM users u WHERE u.shop_id = s.id AND u.password_hash IS NOT NULL) AS active_logins
      FROM shops s ORDER BY last_order DESC NULLS LAST, s.created_at DESC`, ...OPEN_STATUSES);
  return json({ ok: true, shops });
});
on('GET', '/team/shops/:id', TEAM, async ({ env, params }) => {
  const shop = await one(env, 'SELECT * FROM shops WHERE id = ?', params.id);
  if (!shop) throw new HttpError(404, 'not_found');
  const users = await all(env, 'SELECT id, name, email, (password_hash IS NOT NULL) AS has_login, last_login_at, created_at FROM users WHERE shop_id = ?', shop.id);
  const orders = await all(env, 'SELECT id, code, title, status, price, paid, is_free, created_at FROM orders WHERE shop_id = ? ORDER BY created_at DESC', shop.id);
  return json({ ok: true, shop, users, orders });
});
on('PATCH', '/team/shops/:id', ADMIN, async ({ request, env, params }) => {
  const b = await readBody(request), set = [], vals = [];
  if (b.plan !== undefined) { if (!PLANS.includes(b.plan)) throw new HttpError(422, 'invalid', 'Unknown plan.'); set.push('plan = ?'); vals.push(b.plan); }
  if (b.notes !== undefined) { set.push('notes = ?'); vals.push(clean(b.notes, 2000)); }
  if (b.name !== undefined) { const n = clean(b.name, 120); if (!n) throw new HttpError(422, 'invalid'); set.push('name = ?'); vals.push(n); }
  if (!set.length) return json({ ok: true });
  const r = await env.DB.prepare(`UPDATE shops SET ${set.join(', ')} WHERE id = ?`).bind(...vals, params.id).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  return json({ ok: true });
});
// A setup link the team can send to a shop user (for accounts created by the public order form).
on('POST', '/team/users/:id/link', ADMIN, async ({ request, env, params }) => {
  const u = await one(env, 'SELECT id, email, name, role FROM users WHERE id = ? AND active = 1', params.id);
  if (!u) throw new HttpError(404, 'not_found');
  const t = await makeLinkToken(env, u.id, 'setup', 72);
  const link = `${siteUrl(request, env)}/${u.role === 'client' ? 'app' : 'team'}/#/setup/${t}`;
  const emailed = await sendEmail(env, u.email, 'Your CubiX login', `Hi ${u.name},\n\nSet your password here (valid for 3 days):\n${link}`);
  return json({ ok: true, link, emailed });
});

on('GET', '/team/members', TEAM, async ({ env }) => {
  const members = await all(env, `SELECT id, name, email, role, capacity, active, (password_hash IS NOT NULL) AS has_login, last_login_at, created_at FROM users WHERE role IN ('admin','modeler') ORDER BY active DESC, name`);
  return json({ ok: true, members });
});
on('POST', '/team/members', ADMIN, async ({ request, env }) => {
  const b = await readBody(request);
  const name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase(), role = b.role === 'admin' ? 'admin' : 'modeler';
  const capacity = Math.max(1, Math.min(50, parseInt(b.capacity, 10) || 4));
  if (!name || !validEmail(email)) throw new HttpError(422, 'invalid', 'Add a name and a valid email.');
  if (await one(env, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'exists', 'Someone already uses this email.');
  const id = uid('u_');
  await env.DB.prepare('INSERT INTO users (id, email, name, role, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, email, name, role, capacity, now()).run();
  const t = await makeLinkToken(env, id, 'setup', 72);
  const link = `${siteUrl(request, env)}/team/#/setup/${t}`;
  const emailed = await sendEmail(env, email, 'You are invited to the CubiX team', `Hi ${name},\n\nSet your password here (valid for 3 days):\n${link}`);
  return json({ ok: true, id, link, emailed }, 201);
});
on('PATCH', '/team/members/:id', ADMIN, async ({ request, env, params, user }) => {
  const b = await readBody(request), set = [], vals = [];
  const m = await one(env, "SELECT * FROM users WHERE id = ? AND role IN ('admin','modeler')", params.id);
  if (!m) throw new HttpError(404, 'not_found');
  if (b.capacity !== undefined) { const c = parseInt(b.capacity, 10); if (!(c >= 1 && c <= 50)) throw new HttpError(422, 'invalid', 'Capacity must be between 1 and 50.'); set.push('capacity = ?'); vals.push(c); }
  if (b.role !== undefined) { if (!['admin', 'modeler'].includes(b.role)) throw new HttpError(422, 'invalid'); if (m.id === user.id && b.role !== 'admin') throw new HttpError(409, 'bad_state', 'You cannot remove your own admin role.'); set.push('role = ?'); vals.push(b.role); }
  if (b.active !== undefined) { if (m.id === user.id && !b.active) throw new HttpError(409, 'bad_state', 'You cannot deactivate yourself.'); set.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (b.name !== undefined) { const n = clean(b.name, 120); if (!n) throw new HttpError(422, 'invalid'); set.push('name = ?'); vals.push(n); }
  if (!set.length) return json({ ok: true });
  await env.DB.prepare(`UPDATE users SET ${set.join(', ')} WHERE id = ?`).bind(...vals, m.id).run();
  if (b.active === false || b.active === 0) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(m.id).run();
  return json({ ok: true });
});
