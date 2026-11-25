// CubiX API. One router for the public order form, the client portal (/app) and the team dashboard (/team).
import {
  STATUSES, OPEN_STATUSES, PLANS, TURNAROUND_HOURS, HttpError, json, now, addHours, uid, orderCode,
  hashPassword, verifyPassword, clean, validEmail, validPassword, createSession, clearCookie, getUser,
  destroySession, makeLinkToken, useLinkToken, siteUrl, sendEmail, notifyTeam, logEvent, storeFiles,
  readBody, field, sha256, readFile, thumbMap, removeBlobs,
} from '../_lib/core.js';

const routes = [];
const on = (method, pattern, roles, handler) => {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, roles, handler });
};
const TEAM = ['admin', 'modeler'], ADMIN = ['admin'], CLIENT = ['client'], ANY = ['admin', 'modeler', 'client'], PUBLIC = null;

export async function onRequest(context) {
  const { request } = context; let { env } = context;
  try {
    if (!env.DB) throw new HttpError(500, 'not_configured', 'Database is not configured.');
    const bookmark = request.headers.get('x-d1-bookmark');
    const db = typeof env.DB.withSession === 'function'
      ? env.DB.withSession(bookmark && bookmark.length < 200 && /^[\w-]+$/.test(bookmark) ? bookmark : 'first-unconstrained') : env.DB;
    context.env = env = { ...env, DB: db };
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
    const res = await route.handler({ request, env, url, params, user });
    if (typeof env.DB.getBookmark === 'function') { const bm = env.DB.getBookmark(); if (bm) { try { res.headers.set('x-d1-bookmark', bm); } catch {} } }
    return res;
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
// Simple limit per visitor for public forms, stored in login_attempts under a namespaced key.
async function rateLimit(env, request, what, max, minutes) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';
  const key = `${what}:${ip}`, since = addHours(now(), -minutes / 60);
  const r = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at > ?').bind(key, since),
    env.DB.prepare('INSERT INTO login_attempts (email, at) VALUES (?, ?)').bind(key, now()),
  ]);
  if (r[0].results[0].n >= max) throw new HttpError(429, 'slow_down', 'Too many requests from your connection. Please wait a little and try again, or email us.');
}

async function loadOrder(env, id, user) {
  const o = await one(env, `SELECT o.*, s.name AS shop_name, s.url AS shop_url, s.plan AS shop_plan, a.name AS assignee_name
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id WHERE o.id = ? OR o.code = ?`, id, id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  if (!isTeam(user) && o.shop_id !== user.shop_id) throw new HttpError(404, 'not_found', 'Order not found.');
  return o;
}
// Everything an order page needs, in a single database round trip.
async function orderBundle(env, id, user) {
  const team = isTeam(user);
  const r = await env.DB.batch([
    env.DB.prepare(`SELECT o.*, s.name AS shop_name, s.url AS shop_url, s.plan AS shop_plan, a.name AS assignee_name
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id WHERE o.id = ?1 OR o.code = ?1`).bind(id),
    env.DB.prepare(`SELECT f.id, f.kind, f.version, f.name, f.size, f.type, f.created_at, (f.thumb IS NOT NULL) AS has_thumb FROM files f
      JOIN orders o ON o.id = f.order_id WHERE o.id = ?1 OR o.code = ?1 ORDER BY f.created_at`).bind(id),
    env.DB.prepare(`SELECT m.id, m.body, m.internal, m.created_at, u.name AS author, u.role AS author_role FROM messages m
      JOIN orders o ON o.id = m.order_id LEFT JOIN users u ON u.id = m.user_id WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : 'AND m.internal = 0'} ORDER BY m.created_at`).bind(id),
    env.DB.prepare(`SELECT e.type, e.detail, e.created_at, u.name AS who FROM events e JOIN orders o ON o.id = e.order_id
      LEFT JOIN users u ON u.id = e.user_id WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : "AND e.type NOT IN ('assigned','note','price')"} ORDER BY e.id`).bind(id),
    env.DB.prepare(`SELECT i.id, i.number, i.token, i.status, i.total, i.currency, i.issued_at FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : "AND i.status IN ('sent','paid')"} ORDER BY i.created_at`).bind(id),
  ]);
  const o = r[0].results[0];
  if (!o || (!team && o.shop_id !== user.shop_id)) throw new HttpError(404, 'not_found', 'Order not found.');
  const out = { ...o, files: r[1].results, messages: r[2].results, events: r[3].results, invoices: r[4].results };
  if (!team) { delete out.assignee_id; delete out.assignee_name; }
  return out;
}
function dueFor(priority, from = now()) { return addHours(from, priority === 'rush' ? 24 : TURNAROUND_HOURS); }

async function createOrder(env, { shop, userId, body, files }) {
  const id = uid('o_'), at = now();
  const isFree = shop.free_used ? 0 : 1;
  const product = clean(field(body, 'product'), 80) || 'Custom model';
  const title = clean(field(body, 'title'), 120) || product;
  const formats = body instanceof FormData ? body.getAll('formats').map(x => clean(x, 40)).filter(Boolean).join(', ') : clean(field(body, 'formats'), 200);
  const priority = field(body, 'priority') === 'rush' ? 'rush' : 'normal';
  let code = orderCode();
  for (let attempt = 0; ; attempt++) {
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO orders (id, code, shop_id, created_by, title, product, size, printer, formats, notes, channel, status, priority, is_free, due_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`).bind(id, code, shop.id, userId, title, product, clean(field(body, 'size'), 120),
          clean(field(body, 'printer'), 120), formats, clean(field(body, 'notes'), 4000), clean(field(body, 'channel'), 40) || 'Direct', priority, isFree, dueFor(priority, at), at, at),
        env.DB.prepare('UPDATE shops SET free_used = 1 WHERE id = ?').bind(shop.id),
        env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, userId, 'created', isFree ? 'Free first model' : null, at),
      ]);
      break;
    } catch (e) { if (attempt < 3 && /UNIQUE/i.test(String(e && e.message))) { code = orderCode(); continue; } throw e; }
  }
  try { await storeFiles(env, id, files, 'reference', userId, thumbMap(body)); }
  catch (e) { await env.DB.batch([env.DB.prepare('DELETE FROM events WHERE order_id = ?').bind(id), env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id), env.DB.prepare('UPDATE shops SET free_used = ? WHERE id = ?').bind(shop.free_used, shop.id)]); throw e; }
  await notifyTeam(env, `New order ${code} from ${shop.name}${isFree ? ' (free first model)' : ''}: ${title}`);
  return { id, code, free: !!isFree };
}

// ---------------------------------------------------------------- auth
on('POST', '/auth/login', PUBLIC, async ({ request, env }) => {
  const b = await readBody(request);
  const email = clean(field(b, 'email'), 200).toLowerCase(), password = String(field(b, 'password') || '');
  const since = addHours(now(), -0.25);
  const [tr, ur] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at > ?').bind(email, since),
    env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email),
  ]);
  if (tr.results[0].n >= 8) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
  const u = ur.results[0];
  if (!u || !u.active || !(await verifyPassword(password, u.password_hash, u.password_salt))) {
    await env.DB.prepare('INSERT INTO login_attempts (email, at) VALUES (?, ?)').bind(email, now()).run();
    throw new HttpError(401, 'bad_credentials', 'Email or password is not correct.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE email = ? OR at < ?').bind(email, addHours(now(), -2)).run();
  const s = await createSession(env, u.id);
  return json({ ok: true, user: { id: u.id, name: u.name, email: u.email, role: u.role } }, 200, { 'set-cookie': s.cookie });
});
on('POST', '/auth/logout', PUBLIC, async ({ request, env }) => { await destroySession(request, env); return json({ ok: true }, 200, { 'set-cookie': clearCookie }); });
on('GET', '/auth/me', ANY, async ({ env, user }) => {
  const shop = user.shop_id ? { id: user.shop_id, name: user.shop_name, url: user.shop_url, plan: user.shop_plan, free_used: user.shop_free_used } : null;
  return json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role }, shop });
});
on('POST', '/auth/signup', PUBLIC, async ({ request, env }) => {
  await rateLimit(env, request, 'signup', env.SIGNUP_LIMIT ? Number(env.SIGNUP_LIMIT) : 10, 60);
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
  await rateLimit(env, request, 'forgot', 10, 60);
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
  const [, , ur] = await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(p.hash, p.salt, t.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(t.user_id),
    env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(t.user_id),
  ]);
  const u = ur.results[0];
  const s = await createSession(env, u.id);
  return json({ ok: true, role: u.role }, 200, { 'set-cookie': s.cookie });
});
// Change password while signed in. Signs out every other device.
on('POST', '/auth/password', ANY, async ({ request, env, user }) => {
  const b = await readBody(request), current = String(field(b, 'current') || ''), password = String(field(b, 'password') || '');
  const u = await one(env, 'SELECT password_hash, password_salt FROM users WHERE id = ?', user.id);
  if (!(await verifyPassword(current, u.password_hash, u.password_salt))) throw new HttpError(422, 'bad_credentials', 'Your current password is not correct.');
  validPassword(password);
  if (password === current) throw new HttpError(422, 'weak_password', 'Choose a password different from the current one.');
  const p = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(p.hash, p.salt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  const sess = await createSession(env, user.id);
  return json({ ok: true }, 200, { 'set-cookie': sess.cookie });
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
  await rateLimit(env, request, 'order', env.ORDER_LIMIT ? Number(env.ORDER_LIMIT) : 15, 60);
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
on('GET', '/client/orders/:id', CLIENT, async ({ env, params, user }) => json({ ok: true, order: await orderBundle(env, params.id, user) }));
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
on('POST', '/client/orders/:id/files', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (!(b instanceof FormData)) throw new HttpError(400, 'bad_form');
  if (['paid', 'cancelled'].includes(o.status)) throw new HttpError(409, 'bad_state', 'This order is closed. Start a new order for new work.');
  const files = b.getAll('files');
  if (!files.some(f => typeof f === 'object' && f.size > 0)) throw new HttpError(422, 'no_files', 'Choose at least one file.');
  const r = await storeFiles(env, o.id, files, 'reference', user.id, thumbMap(b));
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').bind(now(), o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'files', `Shop added ${r.files.length} file(s)`, now()),
  ]);
  await notifyTeam(env, `${o.shop_name} added ${r.files.length} file(s) to ${o.code}`);
  return json({ ok: true, files: r.files }, 201);
});
on('POST', '/client/orders/:id/approve', CLIENT, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  if (!['preview', 'delivered'].includes(o.status)) throw new HttpError(409, 'bad_state', 'There is nothing to approve yet.');
  const status = o.status === 'preview' ? 'approved' : 'delivered';
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET status = ?, approved_at = ?, updated_at = ? WHERE id = ?').bind(status, now(), now(), o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, NULL, ?)').bind(o.id, user.id, 'approved', now()),
  ]);
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
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'revision', body.slice(0, 200), at),
  ]);
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
    // a file never changes once uploaded (a new version gets a new id), so the browser may keep it
    'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
  } });
});
// Small preview made in the browser at upload time. Falls back to the full image for older files.
on('GET', '/files/:id/thumb', ANY, async ({ env, params, user }) => {
  const f = await one(env, 'SELECT f.id, f.name, f.type, f.size, f.r2_key, f.thumb, o.shop_id FROM files f JOIN orders o ON o.id = f.order_id WHERE f.id = ?', params.id);
  if (!f || (!isTeam(user) && f.shop_id !== user.shop_id) || !/^image\//.test(f.type || '')) throw new HttpError(404, 'not_found', 'File not found.');
  const headers = { 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' };
  if (f.thumb) return new Response(new Uint8Array(f.thumb), { headers: { ...headers, 'content-type': 'image/webp' } });
  const body = await readFile(env, f.r2_key);
  if (!body) throw new HttpError(404, 'not_found', 'File not found.');
  return new Response(body, { headers: { ...headers, 'content-type': f.type, 'content-length': String(f.size) } });
});

// ---------------------------------------------------------------- team dashboard
on('GET', '/team/overview', TEAM, async ({ env }) => {
  const t = now(), soon = addHours(t, 24), monthStart = t.slice(0, 7) + '-01T00:00:00.000Z';
  const open = OPEN_STATUSES.filter(s => s !== 'approved');
  const ph = open.map(() => '?').join(',');
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const r = await env.DB.batch([
    q('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
    q(`SELECT
        SUM(CASE WHEN status IN (${ph}) AND due_at < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN status IN (${ph}) AND due_at >= ? AND due_at < ? THEN 1 ELSE 0 END) AS due_soon,
        SUM(CASE WHEN status IN (${ph}) AND assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN status IN ('delivered','approved') AND paid = 0 AND is_free = 0 THEN 1 ELSE 0 END) AS awaiting_n,
        COALESCE(SUM(CASE WHEN status IN ('delivered','approved') AND paid = 0 AND is_free = 0 THEN price END), 0) AS awaiting_total,
        COALESCE(SUM(CASE WHEN paid = 1 AND updated_at >= ? THEN price END), 0) AS paid_total,
        SUM(CASE WHEN paid = 1 AND updated_at >= ? THEN 1 ELSE 0 END) AS paid_n
      FROM orders`, ...open, t, ...open, t, soon, ...open, monthStart, monthStart),
    q('SELECT COUNT(*) AS n, AVG((julianday(delivered_at) - julianday(created_at)) * 24) AS avg_h FROM orders WHERE delivered_at IS NOT NULL AND delivered_at >= ?', addHours(t, -24 * 30)),
    q(`SELECT u.id, u.name, u.role, u.capacity,
        (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.status IN (${ph})) AS open,
        (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.status IN (${ph}) AND o.due_at < ?) AS overdue,
        (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.delivered_at >= ?) AS delivered_7d
      FROM users u WHERE u.role IN ('admin','modeler') AND u.active = 1 ORDER BY u.name`, ...open, ...open, t, addHours(t, -24 * 7)),
    q('SELECT COUNT(*) AS n FROM shops WHERE created_at >= ?', monthStart),
    q(`SELECT o.id, o.code, o.title, o.status, o.due_at, o.priority, o.is_free, s.name AS shop_name, a.name AS assignee_name
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id
      WHERE o.status IN (${ph}) AND (o.due_at < ? OR o.assignee_id IS NULL OR o.status = 'revisions') ORDER BY o.due_at LIMIT 12`, ...open, soon),
  ]);
  const c = r[1].results[0], d = r[2].results[0], team = r[3].results;
  return json({ ok: true, byStatus: r[0].results, overdue: c.overdue || 0, dueSoon: c.due_soon || 0, unassigned: c.unassigned || 0,
    awaiting: { n: c.awaiting_n || 0, total: c.awaiting_total }, paidMonth: { n: c.paid_n || 0, total: c.paid_total },
    avgHours: d.n ? d.avg_h : null, deliveredLast30: d.n, team, capacity: team.reduce((a, m) => a + m.capacity, 0), load: team.reduce((a, m) => a + m.open, 0),
    newShops: r[4].results[0].n, attention: r[5].results });
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
on('GET', '/team/orders/:id', TEAM, async ({ env, params, user }) => json({ ok: true, order: await orderBundle(env, params.id, user) }));

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
  const at = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET ${set.join(', ')} WHERE id = ?`).bind(...vals, o.id),
    ...events.map(([t, d]) => env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, t, d ? String(d).slice(0, 500) : null, at)),
  ]);
  return json({ ok: true, order: await orderBundle(env, o.id, user) });
});

on('POST', '/team/orders/:id/delete', ADMIN, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  const inv = await one(env, "SELECT COUNT(*) AS n FROM invoices WHERE order_id = ? AND status IN ('sent','paid')", o.id);
  if (inv.n) throw new HttpError(409, 'bad_state', 'This order has a sent or paid invoice. Void the invoice instead of deleting the order.');
  const files = await all(env, 'SELECT r2_key FROM files WHERE order_id = ?', o.id);
  await removeBlobs(env, files.map(f => f.r2_key));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invoices WHERE order_id = ?').bind(o.id),
    env.DB.prepare('DELETE FROM files WHERE order_id = ?').bind(o.id),
    env.DB.prepare('DELETE FROM messages WHERE order_id = ?').bind(o.id),
    env.DB.prepare('DELETE FROM events WHERE order_id = ?').bind(o.id),
    env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(o.id),
  ]);
  return json({ ok: true });
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
  const r = await storeFiles(env, o.id, files, kind, user.id, thumbMap(b));
  const at = now(); let status = o.status;
  if (kind === 'preview' && ['new', 'confirmed', 'modeling', 'revisions'].includes(o.status)) status = 'preview';
  if (kind === 'final' && o.status !== 'cancelled') status = o.paid ? 'paid' : 'delivered';
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ?, delivered_at = CASE WHEN ? = 'final' AND delivered_at IS NULL THEN ? ELSE delivered_at END WHERE id = ?`).bind(status, at, kind, at, o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, kind === 'final' ? 'delivered' : 'preview', `Version ${r.version}, ${r.files.length} file(s)`, at),
    ...(status !== o.status ? [env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'status', `${o.status} to ${status}`, at)] : []),
  ]);
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
// Invite a new shop: creates the shop and its owner's portal account, and returns a one time login link.
on('POST', '/team/shops', ADMIN, async ({ request, env }) => {
  const b = await readBody(request);
  const name = clean(field(b, 'name'), 120), contact = clean(field(b, 'contact'), 120), email = clean(field(b, 'email'), 200).toLowerCase();
  const url = clean(field(b, 'url'), 300), plan = PLANS.includes(field(b, 'plan')) ? field(b, 'plan') : 'pay_per_model';
  if (!name) throw new HttpError(422, 'invalid', 'Add the shop name.');
  if (!validEmail(email)) throw new HttpError(422, 'invalid', 'Add a valid email address.');
  const existing = await one(env, 'SELECT id, role, shop_id FROM users WHERE email = ?', email);
  if (existing) throw new HttpError(409, 'exists', existing.role === 'client' ? 'This email already has a portal account. Open the shop and use Login link instead.' : 'This email belongs to a team member.');
  const shopId = uid('s_'), userId = uid('u_'), at = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shops (id, name, url, plan, created_at) VALUES (?, ?, ?, ?, ?)').bind(shopId, name, url, plan, at),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, shop_id, created_at) VALUES (?, ?, ?, 'client', ?, ?)`).bind(userId, email, contact || name, shopId, at),
  ]);
  const t = await makeLinkToken(env, userId, 'setup', 24 * 7);
  const link = `${siteUrl(request, env)}/app/#/setup/${t}`;
  const emailed = await sendEmail(env, email, 'Your CubiX client portal', `Hi ${contact || name},\n\nYour CubiX portal is ready. Set your password here (valid for 7 days):\n${link}\n\nYour first model is free.`);
  return json({ ok: true, id: shopId, link, emailed }, 201);
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

// ---------------------------------------------------------------- invoices
// Business details shown on invoices. Admins edit them under Invoices, Settings.
const SETTING_DEFAULTS = {
  biz_name: 'CubiX',
  biz_tagline: '3D modeling for print shops',
  biz_email: '',
  biz_website: 'cubix.axys3d.com',
  biz_address: '',
  invoice_prefix: 'CX',
  terms: 'Due on receipt',
  payment_note: 'Pay through Upwork, Fiverr, Payoneer or direct bank transfer. We send the account details with this invoice. Please quote the invoice number with your payment. Transfer fees charged by the sending bank are payable by the sender.',
  notes: 'All reference material and delivered files remain confidential. Nothing is published, added to a portfolio or shared outside the project team without written approval.',
};
async function getSettings(env) {
  const rows = await all(env, 'SELECT key, value FROM settings');
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS && r.value !== null) out[r.key] = r.value;
  return out;
}
const money2 = n => Math.round((Number(n) || 0) * 100) / 100;
function normItems(items) {
  if (!Array.isArray(items)) throw new HttpError(422, 'invalid', 'Add at least one line item.');
  const out = items.slice(0, 30).map(it => ({
    title: clean(it && it.title, 160),
    description: clean(it && it.description, 1000),
    bullets: (Array.isArray(it && it.bullets) ? it.bullets : String((it && it.bullets) || '').split('\n')).map(b => clean(b, 120)).filter(Boolean).slice(0, 12),
    qty: Math.max(0, Math.min(100000, Number(it && it.qty) || 0)),
    rate: Math.max(0, Math.min(1000000, money2(it && it.rate))),
  })).filter(it => it.title || it.description || it.rate);
  if (!out.length) throw new HttpError(422, 'invalid', 'Add at least one line item.');
  for (const it of out) { if (!it.title) throw new HttpError(422, 'invalid', 'Every line needs a title.'); it.amount = money2(it.qty * it.rate); }
  return out;
}
function totals(items, taxRate) {
  const subtotal = money2(items.reduce((s, it) => s + it.amount, 0));
  const tax = money2(subtotal * (Number(taxRate) || 0) / 100);
  return { subtotal, tax, total: money2(subtotal + tax) };
}
async function loadInvoice(env, id) {
  const inv = await one(env, `SELECT i.*, s.name AS shop_name, o.code AS order_code, o.status AS order_status FROM invoices i
      JOIN shops s ON s.id = i.shop_id LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ? OR i.number = ?`, id, id);
  if (!inv) throw new HttpError(404, 'not_found', 'Invoice not found.');
  inv.items = JSON.parse(inv.items || '[]');
  return inv;
}
const invoiceLink = (request, env, inv) => `${siteUrl(request, env)}/invoice/#${inv.token}`;

on('GET', '/team/invoices', ADMIN, async ({ env, url }) => {
  const st = url.searchParams.get('status'), where = [], b = [];
  if (['draft', 'sent', 'paid', 'void'].includes(st)) { where.push('i.status = ?'); b.push(st); }
  if (url.searchParams.get('order')) { where.push('i.order_id = ?'); b.push(url.searchParams.get('order')); }
  const invoices = await all(env, `SELECT i.id, i.number, i.token, i.status, i.bill_name, i.project_title, i.total, i.currency, i.issued_at, i.sent_at, i.paid_at, i.order_id,
      s.name AS shop_name, o.code AS order_code FROM invoices i JOIN shops s ON s.id = i.shop_id LEFT JOIN orders o ON o.id = i.order_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.created_at DESC LIMIT 500`, ...b);
  const sums = await one(env, `SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN total END), 0) AS outstanding, SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS outstanding_n,
      COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ? THEN total END), 0) AS paid_month FROM invoices`, now().slice(0, 7) + '-01T00:00:00.000Z');
  return json({ ok: true, invoices, sums });
});

on('POST', '/team/invoices', ADMIN, async ({ request, env, user }) => {
  const b = await readBody(request), st = await getSettings(env), at = now();
  let shop, order = null;
  if (field(b, 'order_id')) {
    order = await one(env, 'SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?', field(b, 'order_id'));
    if (!order) throw new HttpError(404, 'not_found', 'Order not found.');
  }
  const shopId = order ? order.shop_id : field(b, 'shop_id');
  shop = shopId && await one(env, `SELECT s.*, (SELECT email FROM users u WHERE u.shop_id = s.id ORDER BY created_at LIMIT 1) AS email FROM shops s WHERE s.id = ?`, shopId);
  if (!shop) throw new HttpError(422, 'invalid', 'Pick a shop to bill.');
  const items = order ? [{
    title: order.product && order.product !== order.title ? `${order.product}, print ready` : 'Custom 3D model, print ready',
    description: (() => { const p = [order.title !== order.product ? order.title : '', order.size ? `built to ${order.size}` : '', order.printer ? `for ${order.printer}` : ''].filter(Boolean).join(', '); return p ? p.charAt(0).toUpperCase() + p.slice(1) + '.' : ''; })(),
    bullets: ['Watertight, print ready mesh', order.formats ? `Delivered as ${order.formats}` : 'Delivered as STL and 3MF', 'Revisions until approved'],
    qty: 1, rate: order.is_free ? 0 : (order.price || 0),
  }] : [{ title: 'Custom 3D model, print ready', description: '', bullets: [], qty: 1, rate: 0 }];
  items.forEach(it => { it.amount = money2(it.qty * it.rate); });
  const t = totals(items, 0), year = at.slice(0, 4), prefix = clean(st.invoice_prefix, 10).replace(/[^A-Za-z0-9]/g, '') || 'CX';
  const id = uid('i_'), token = (await sha256(uid('t_') + Math.random())).slice(0, 40);
  for (let attempt = 0; ; attempt++) {
    const n = await one(env, 'SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?', `${prefix}-${year}-%`);
    const number = `${prefix}-${year}-${String(n.n + 1 + attempt).padStart(3, '0')}`;
    try {
      await env.DB.prepare(`INSERT INTO invoices (id, number, token, shop_id, order_id, status, bill_name, bill_email, project_title, project_ref, items, tax_rate, subtotal, tax, total, terms, payment_note, notes, issued_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, number, token, shop.id, order ? order.id : null, shop.name, shop.email || null,
        order ? order.title : '', order ? `Order ${order.code}` : '', JSON.stringify(items), t.subtotal, t.tax, t.total, st.terms, st.payment_note, st.notes, at, user.id, at, at).run();
      break;
    } catch (e) { if (attempt < 5 && /UNIQUE/i.test(String(e && e.message))) continue; throw e; }
  }
  return json({ ok: true, invoice: await loadInvoice(env, id) }, 201);
});

on('GET', '/team/invoices/:id', ADMIN, async ({ request, env, params }) => {
  const inv = await loadInvoice(env, params.id);
  return json({ ok: true, invoice: inv, settings: await getSettings(env), link: invoiceLink(request, env, inv) });
});

on('PATCH', '/team/invoices/:id', ADMIN, async ({ request, env, params }) => {
  const inv = await loadInvoice(env, params.id), b = await readBody(request);
  if (!['draft', 'sent'].includes(inv.status)) throw new HttpError(409, 'bad_state', 'Paid or void invoices cannot be edited.');
  const set = [], vals = [];
  for (const [k, max] of [['bill_name', 160], ['bill_email', 200], ['bill_extra', 500], ['project_title', 160], ['project_ref', 160], ['terms', 120], ['payment_note', 1500], ['notes', 1500]]) {
    if (b[k] === undefined) continue;
    const v = clean(b[k], max);
    if (k === 'bill_name' && !v) throw new HttpError(422, 'invalid', 'Add who the invoice is billed to.');
    if (k === 'bill_email' && v && !validEmail(v)) throw new HttpError(422, 'invalid', 'The billing email is not valid.');
    set.push(`${k} = ?`); vals.push(v || null);
  }
  if (b.issued_at !== undefined) { if (isNaN(Date.parse(b.issued_at))) throw new HttpError(422, 'invalid', 'Pick a valid issue date.'); set.push('issued_at = ?'); vals.push(new Date(b.issued_at).toISOString()); }
  if (b.currency !== undefined) { const c = clean(b.currency, 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) throw new HttpError(422, 'invalid', 'Currency must be a 3 letter code like USD.'); set.push('currency = ?'); vals.push(c); }
  let items = inv.items, taxRate = inv.tax_rate;
  if (b.items !== undefined) { items = normItems(b.items); set.push('items = ?'); vals.push(JSON.stringify(items)); }
  if (b.tax_rate !== undefined) { taxRate = Number(b.tax_rate); if (!(taxRate >= 0 && taxRate <= 100)) throw new HttpError(422, 'invalid', 'Tax must be between 0 and 100 percent.'); set.push('tax_rate = ?'); vals.push(taxRate); }
  if (b.items !== undefined || b.tax_rate !== undefined) { const t = totals(items, taxRate); set.push('subtotal = ?', 'tax = ?', 'total = ?'); vals.push(t.subtotal, t.tax, t.total); }
  if (!set.length) return json({ ok: true, invoice: inv });
  set.push('updated_at = ?'); vals.push(now());
  await env.DB.prepare(`UPDATE invoices SET ${set.join(', ')} WHERE id = ?`).bind(...vals, inv.id).run();
  return json({ ok: true, invoice: await loadInvoice(env, inv.id) });
});

on('POST', '/team/invoices/:id/send', ADMIN, async ({ request, env, params, user }) => {
  const inv = await loadInvoice(env, params.id);
  if (!['draft', 'sent'].includes(inv.status)) throw new HttpError(409, 'bad_state', 'This invoice is already closed.');
  if (!(inv.total > 0)) throw new HttpError(422, 'invalid', 'The invoice total is zero. Add a price before sending.');
  const at = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE invoices SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?`).bind(at, at, inv.id),
    ...(inv.order_id ? [env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(inv.order_id, user.id, 'invoice', `Invoice ${inv.number} sent`, at)] : []),
  ]);
  const link = invoiceLink(request, env, inv), st = await getSettings(env);
  const emailed = inv.bill_email ? await sendEmail(env, inv.bill_email, `Invoice ${inv.number} from ${st.biz_name}`,
    `Hi ${inv.bill_name},\n\nPlease find invoice ${inv.number} for ${inv.currency} ${inv.total.toFixed(2)} here:\n${link}\n\n${st.payment_note}\n\nThank you.`) : false;
  return json({ ok: true, link, emailed, invoice: await loadInvoice(env, inv.id) });
});

on('POST', '/team/invoices/:id/paid', ADMIN, async ({ request, env, params, user }) => {
  const inv = await loadInvoice(env, params.id), b = await readBody(request);
  if (inv.status === 'void') throw new HttpError(409, 'bad_state', 'This invoice is void.');
  if (inv.status === 'paid') return json({ ok: true, invoice: inv });
  const via = clean(field(b, 'paid_via'), 40) || null, at = now();
  const stmts = [env.DB.prepare(`UPDATE invoices SET status = 'paid', paid_at = ?, paid_via = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?`).bind(at, via, at, at, inv.id)];
  if (inv.order_id) {
    const o = await one(env, 'SELECT status, paid, price FROM orders WHERE id = ?', inv.order_id);
    if (o && ['approved', 'delivered', 'paid'].includes(o.status) && !o.paid) {
      const next = o.status === 'delivered' ? 'paid' : o.status;
      stmts.push(env.DB.prepare('UPDATE orders SET paid = 1, paid_via = ?, price = COALESCE(price, ?), status = ?, updated_at = ? WHERE id = ?').bind(via, inv.total, next, at, inv.order_id));
      if (next !== o.status) stmts.push(env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(inv.order_id, user.id, 'status', `${o.status} to ${next}`, at));
    }
    stmts.push(env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(inv.order_id, user.id, 'invoice', `Invoice ${inv.number} paid${via ? ' via ' + via : ''}`, at));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, invoice: await loadInvoice(env, inv.id) });
});

on('POST', '/team/invoices/:id/void', ADMIN, async ({ env, params }) => {
  const inv = await loadInvoice(env, params.id);
  if (inv.status === 'paid') throw new HttpError(409, 'bad_state', 'A paid invoice cannot be voided.');
  if (inv.status === 'draft') { await env.DB.prepare('DELETE FROM invoices WHERE id = ?').bind(inv.id).run(); return json({ ok: true, deleted: true }); }
  await env.DB.prepare(`UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ?`).bind(now(), inv.id).run();
  return json({ ok: true, invoice: await loadInvoice(env, inv.id) });
});

on('GET', '/team/settings', ADMIN, async ({ env }) => json({ ok: true, settings: await getSettings(env) }));
on('PATCH', '/team/settings', ADMIN, async ({ request, env }) => {
  const b = await readBody(request), stmts = [];
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (b[k] === undefined) continue;
    const v = clean(b[k], k.endsWith('note') || k === 'notes' ? 1500 : 200);
    if (k === 'biz_email' && v && !validEmail(v)) throw new HttpError(422, 'invalid', 'The business email is not valid.');
    if (k === 'biz_name' && !v) throw new HttpError(422, 'invalid', 'Add the business name.');
    stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, settings: await getSettings(env) });
});

on('GET', '/client/invoices', CLIENT, async ({ env, user }) => {
  const invoices = await all(env, `SELECT i.number, i.token, i.status, i.project_title, i.total, i.currency, i.issued_at, i.paid_at, o.id AS order_id, o.code AS order_code
      FROM invoices i LEFT JOIN orders o ON o.id = i.order_id WHERE i.shop_id = ? AND i.status IN ('sent','paid') ORDER BY i.issued_at DESC`, user.shop_id);
  return json({ ok: true, invoices });
});

// Public invoice page data. The token is a long random secret shared only with the client.
// Drafts are visible to the team only, so an admin can preview before sending.
on('GET', '/invoice/:token', PUBLIC, async ({ request, env, params }) => {
  if (!/^[a-f0-9]{40}$/.test(params.token)) throw new HttpError(404, 'not_found', 'Invoice not found.');
  const inv = await one(env, 'SELECT * FROM invoices WHERE token = ?', params.token);
  if (!inv) throw new HttpError(404, 'not_found', 'Invoice not found.');
  if (inv.status === 'draft') { const u = await getUser(request, env); if (!isTeam(u)) throw new HttpError(404, 'not_found', 'Invoice not found.'); }
  const st = await getSettings(env);
  const pick = ['number', 'status', 'bill_name', 'bill_email', 'bill_extra', 'project_title', 'project_ref', 'currency', 'tax_rate', 'subtotal', 'tax', 'total', 'terms', 'payment_note', 'notes', 'issued_at', 'sent_at', 'paid_at', 'paid_via'];
  const out = Object.fromEntries(pick.map(k => [k, inv[k]])); out.items = JSON.parse(inv.items || '[]');
  return json({ ok: true, invoice: out, business: { name: st.biz_name, tagline: st.biz_tagline, email: st.biz_email, website: st.biz_website, address: st.biz_address } },
    200, { 'x-robots-tag': 'noindex' });
});
