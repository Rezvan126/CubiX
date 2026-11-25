// CubiX API. One router for the public order form, the client portal (/app) and the team dashboard (/team).
import {
  STATUSES, OPEN_STATUSES, PLANS, TURNAROUND_HOURS, HttpError, json, now, addHours, uid, orderCode,
  hashPassword, verifyPassword, clean, validEmail, validPassword, createSession, clearCookie, getUser,
  destroySession, makeLinkToken, useLinkToken, siteUrl, logEvent, storeFiles,
  readBody, field, sha256, readFile, thumbMap, removeBlobs, attachUploads, uploadIds, CHUNK, MAX_UPLOAD,
} from '../_lib/core.js';
import { later, alertTeam, sendMail, emailHtml, emailReady, notifySettings } from '../_lib/notify.js';

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
      // changes read and write the main copy; plain reads may use the nearest copy, kept in step by the browser's bookmark
      ? env.DB.withSession(request.method !== 'GET' ? 'first-primary' : bookmark && bookmark.length < 200 && /^[\w-]+$/.test(bookmark) ? bookmark : 'first-unconstrained') : env.DB;
    context.env = env = { ...env, DB: db, __waitUntil: p => context.waitUntil(p) };
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
const escH = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const teamUrl = (site, orderId) => `${site}/team/#/orders?o=${orderId}`;
const portalUrl = (site, orderId) => `${site}/app/#/orders/${orderId}`;
// Email the shop owner of an order, in the background.
function mailClient(env, site, to, name, subject, { heading, intro, button, lines, outro }) {
  const text = `Hi ${name},\n\n${intro.replace(/<[^>]+>/g, '')}${lines ? '\n\n' + lines.map(([k, v]) => `${k}: ${v}`).join('\n') : ''}${button ? `\n\n${button.label}: ${button.url}` : ''}${outro ? '\n\n' + outro.replace(/<[^>]+>/g, '') : ''}\n\nCubiX`;
  return later(env, sendMail(env, to, subject, text, emailHtml(site, { heading, intro: `Hi ${escH(name)},<br><br>${intro}`, button, lines, outro })));
}
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

// The client never sees the internal QC step: "review" shows as "modeling" in the portal.
const clientStatus = st => st === 'review' ? 'modeling' : st;
// Leave "waiting on client": the clock restarts and the deadlines move by the time spent waiting.
function resumeStatements(env, o, userId, at) {
  if (o.status !== 'waiting') return [];
  const paused = Math.max(0, new Date(at) - new Date(o.paused_at || at));
  const shift = iso => iso ? new Date(new Date(iso).getTime() + paused).toISOString() : iso;
  const back = o.wait_from && !['waiting', 'new'].includes(o.wait_from) ? o.wait_from : 'modeling';
  return [
    env.DB.prepare('UPDATE orders SET status = ?, due_at = ?, handin_at = ?, paused_at = NULL, wait_from = NULL, updated_at = ? WHERE id = ?').bind(back, shift(o.due_at), shift(o.handin_at), at, o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, userId, 'status', `waiting to ${back}`, at),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, userId, 'resumed', `Clock resumed, deadline moved by ${Math.round(paused / 60000)} min`, at),
  ];
}
// Send previews that passed QC to the client.
async function releasePreview(env, request, o, userId, at) {
  const r = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(version) AS v FROM files WHERE order_id = ? AND kind = 'preview' AND released = 0").bind(o.id),
    env.DB.prepare("UPDATE files SET released = 1 WHERE order_id = ? AND kind = 'preview' AND released = 0").bind(o.id),
    env.DB.prepare("UPDATE orders SET status = 'preview', preview_seen_at = NULL, updated_at = ? WHERE id = ?").bind(at, o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, userId, 'qc', 'Passed QC, preview sent to the client', at),
    ...(o.status !== 'preview' ? [env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, userId, 'status', `${o.status} to preview`, at)] : []),
  ]);
  const version = r[0].results[0].v;
  const c = await one(env, 'SELECT email, name FROM users WHERE id = ?', o.created_by);
  if (c) mailClient(env, siteUrl(request, env), c.email, c.name, `Preview ready for ${o.code}`, { heading: 'Your preview is ready', intro: `Have a look at the preview for <b>${escH(o.title)}</b>. Approve it, or tell us what to change. You can rotate the 3D model and pin exactly what to change.`, lines: [['Order', o.code], ...(version ? [['Version', String(version)]] : [])], button: { label: 'Review the preview', url: portalUrl(siteUrl(request, env), o.id) } });
}
const hasFiles = (b, files) => files.some(f => typeof f === 'object' && f && f.size > 0) || uploadIds(b).length > 0;
const parsePins = raw => {
  let pins = raw; if (typeof pins === 'string') { try { pins = JSON.parse(pins || '[]'); } catch { throw new HttpError(422, 'invalid', 'Pins could not be read.'); } }
  if (!Array.isArray(pins)) return [];
  return pins.slice(0, 30).map((p, i) => {
    const pos = Array.isArray(p && p.p) ? p.p.slice(0, 3).map(Number) : null;
    if (!pos || pos.length !== 3 || pos.some(n => !isFinite(n))) throw new HttpError(422, 'invalid', 'A pin has no position on the model.');
    return { n: i + 1, p: pos.map(n => Math.round(n * 1000) / 1000), note: clean(p.note, 300) };
  });
};

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
    env.DB.prepare(`SELECT f.id, f.kind, f.version, f.name, f.size, f.type, f.created_at, f.released, f.request_id, (f.thumb IS NOT NULL) AS has_thumb FROM files f
      JOIN orders o ON o.id = f.order_id WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : 'AND f.released = 1'} ORDER BY f.created_at`).bind(id),
    env.DB.prepare(`SELECT m.id, m.body, m.internal, m.created_at, u.name AS author, u.role AS author_role FROM messages m
      JOIN orders o ON o.id = m.order_id LEFT JOIN users u ON u.id = m.user_id WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : 'AND m.internal = 0'} ORDER BY m.created_at`).bind(id),
    env.DB.prepare(`SELECT e.type, e.detail, e.created_at, u.name AS who FROM events e JOIN orders o ON o.id = e.order_id
      LEFT JOIN users u ON u.id = e.user_id WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : "AND e.type NOT IN ('assigned','note','price')"} ORDER BY e.id`).bind(id),
    env.DB.prepare(`SELECT i.id, i.number, i.token, i.status, i.total, i.currency, i.issued_at FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE (o.id = ?1 OR o.code = ?1) ${team ? '' : "AND i.status IN ('sent','paid')"} ORDER BY i.created_at`).bind(id),
    env.DB.prepare(`SELECT r.id, r.round, r.body, r.pins, r.model_file, r.created_at, u.name AS author FROM requests r JOIN orders o ON o.id = r.order_id
      LEFT JOIN users u ON u.id = r.created_by WHERE o.id = ?1 OR o.code = ?1 ORDER BY r.round, r.created_at`).bind(id),
    env.DB.prepare(`SELECT ru.id, ru.scope, ru.product, ru.title, ru.body, ru.updated_at FROM rules ru JOIN orders o ON (o.id = ?1 OR o.code = ?1)
      WHERE (ru.scope = 'shop' AND ru.shop_id = o.shop_id) OR (ru.scope = 'product' AND (lower(ru.product) = lower(o.product) OR lower(ru.product) = 'all'))
      ORDER BY ru.scope DESC, ru.title`).bind(id),
    env.DB.prepare(`SELECT s.id, s.code, s.item_no, s.status, s.assignee_id FROM orders s JOIN orders o ON (o.id = ?1 OR o.code = ?1)
      WHERE o.group_id IS NOT NULL AND s.group_id = o.group_id ORDER BY s.item_no`).bind(id),
    env.DB.prepare(`SELECT p.id, p.n, p.round, p.part, p.pos, p.body, p.model_file, p.status, p.created_at, p.resolved_at, u.name AS author, u.role AS author_role FROM pins p
      JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.created_by WHERE o.id = ?1 OR o.code = ?1 ORDER BY p.n`).bind(id),
    env.DB.prepare(`SELECT r.pin_id, r.body, r.created_at, u.name AS author, u.role AS author_role FROM pin_replies r JOIN pins p ON p.id = r.pin_id
      JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = r.user_id WHERE o.id = ?1 OR o.code = ?1 ORDER BY r.created_at`).bind(id),
  ]);
  const o = r[0].results[0];
  if (!o || (!team && o.shop_id !== user.shop_id)) throw new HttpError(404, 'not_found', 'Order not found.');
  const requests = r[5].results.map(x => ({ ...x, pins: JSON.parse(x.pins || '[]') }));
  const replies = r[9].results;
  const pins = r[8].results.map(p => ({ ...p, pos: JSON.parse(p.pos), replies: replies.filter(x => x.pin_id === p.id).map(({ pin_id, ...x }) => x) }));
  const out = { ...o, pins, files: r[1].results, messages: r[2].results, events: r[3].results, invoices: r[4].results, requests, round: (o.revisions || 0) + 1, siblings: r[7].results };
  if (team) out.rules = r[6].results;
  else {
    for (const k of ['assignee_id', 'assignee_name', 'handin_at', 'wait_from', 'team_seen_at', 'paused_at']) delete out[k];
    out.status = clientStatus(out.status); out.siblings = out.siblings.map(x => ({ id: x.id, code: x.code, item_no: x.item_no }));
    out.events = out.events.filter(e => !['qc', 'resumed'].includes(e.type));
  }
  return out;
}
function dueFor(priority, from = now()) { return addHours(from, priority === 'rush' ? 24 : TURNAROUND_HOURS); }

// Team deadline: the client due time minus room for the QC check (6 hours, or a quarter of a short window).
function handinFor(due, from) {
  const win = new Date(due) - new Date(from);
  return new Date(new Date(due).getTime() - Math.min(6 * 3600e3, Math.max(0, win) / 4)).toISOString();
}
function parseDay(v) {
  const t = clean(v, 40); if (!t) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? t + 'T23:59:00.000Z' : t);
  if (isNaN(d)) throw new HttpError(422, 'invalid', 'Pick a valid ship by date.');
  return d.toISOString();
}

async function createOrder(env, { shop, userId, body, files, site, orderer, ownerId = null }) {
  const at = now();
  const product = clean(field(body, 'product'), 80) || 'Custom model';
  const baseTitle = clean(field(body, 'title'), 120) || product;
  const formats = body instanceof FormData ? body.getAll('formats').map(x => clean(x, 40)).filter(Boolean).join(', ') : clean(field(body, 'formats'), 200);
  const priority = field(body, 'priority') === 'rush' ? 'rush' : 'normal';
  const source = clean(field(body, 'source'), 120) || null;
  const shipBy = parseDay(field(body, 'ship_by'));
  const count = Math.max(1, Math.min(10, parseInt(field(body, 'items'), 10) || 1));
  const due = dueFor(priority, at), handin = handinFor(due, at);
  const groupId = count > 1 ? uid('g_') : null;
  const items = Array.from({ length: count }, (_, i) => ({ id: uid('o_'), no: i + 1, free: i === 0 && !shop.free_used ? 1 : 0 }));
  const codes = items.map(() => orderCode());
  for (let attempt = 0; ; attempt++) {
    try {
      await env.DB.batch([
        ...items.map((it, i) => env.DB.prepare(`INSERT INTO orders (id, code, shop_id, created_by, title, product, size, printer, formats, notes, channel, status, priority, is_free, due_at, handin_at, ship_by, group_id, item_no, item_count, created_at, updated_at, source, customer_notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(it.id, codes[i], shop.id, userId, count > 1 ? `${baseTitle} (${it.no} of ${count})` : baseTitle, product,
          clean(field(body, 'size'), 120), clean(field(body, 'printer'), 120), formats, clean(field(body, 'notes'), 4000), clean(field(body, 'channel'), 40) || 'Direct',
          priority, it.free, due, handin, shipBy, groupId, count > 1 ? it.no : null, count > 1 ? count : null, at, at, source, clean(field(body, 'customer_notes'), 4000) || null)),
        env.DB.prepare('UPDATE shops SET free_used = 1 WHERE id = ?').bind(shop.id),
        ...items.map(it => env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(it.id, userId, 'created', it.free ? 'Free first model' : (count > 1 ? `Model ${it.no} of ${count}` : null), at)),
      ]);
      break;
    } catch (e) { if (attempt < 3 && /UNIQUE/i.test(String(e && e.message))) { for (let i = 0; i < codes.length; i++) codes[i] = orderCode(); continue; } throw e; }
  }
  const ids = items.map(it => it.id);
  try {
    if (uploadIds(body).length) await attachUploads(env, ids[0], uploadIds(body), 'reference', userId, ownerId);
    else await storeFiles(env, ids[0], files, 'reference', userId, thumbMap(body));
    // the same photos belong to every model of the order: share the stored contents instead of copying them
    if (ids.length > 1) await env.DB.batch(ids.slice(1).map(oid => env.DB.prepare(`INSERT INTO files (id, order_id, kind, version, r2_key, name, size, type, uploaded_by, created_at, thumb, released)
      SELECT 'f_' || lower(hex(randomblob(12))), ?, kind, version, r2_key, name, size, type, uploaded_by, created_at, thumb, released FROM files WHERE order_id = ?`).bind(oid, ids[0])));
  } catch (e) {
    await env.DB.batch([
      ...ids.map(oid => env.DB.prepare('DELETE FROM files WHERE order_id = ?').bind(oid)),
      ...ids.map(oid => env.DB.prepare('DELETE FROM events WHERE order_id = ?').bind(oid)),
      ...ids.map(oid => env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(oid)),
      env.DB.prepare('UPDATE shops SET free_used = ? WHERE id = ?').bind(shop.free_used, shop.id)]);
    throw e;
  }
  const isFree = items[0].free, code = codes[0], title = baseTitle;
  later(env, alertTeam(env, site, { title: `New order ${codes.join(', ')}${isFree ? ' (free first model)' : ''}`, text: `${shop.name}: ${title}${count > 1 ? ` (${count} models)` : ''}${priority === 'rush' ? ' (rush)' : ''}${shipBy ? `\nShips by ${shipBy.slice(0, 10)}` : ''}${source ? `\nSource: ${source}` : ''}`, url: teamUrl(site, ids[0]) }));
  if (orderer && orderer.email) {
    let button = { label: 'Track your order', url: portalUrl(site, ids[0]) };
    if (orderer.needsLogin) { const t = await makeLinkToken(env, orderer.id, 'setup', 24 * 7); button = { label: 'Set a password and track your order', url: `${site}/app/#/setup/${t}` }; }
    mailClient(env, site, orderer.email, orderer.name, `We received your order ${code}`, {
      heading: `Order ${code} received`,
      intro: `Thank you. Your order is in the queue and a modeler will pick it up shortly. You get a preview by ${new Date(due).toUTCString().slice(0, 22)} UTC at the latest.${isFree ? '<br><br><b>Your first model is free.</b>' : ''}`,
      lines: [['Order', codes.join(', ')], ['What', count > 1 ? `${title}, ${count} models` : title], ['Turnaround', priority === 'rush' ? 'Rush, within 24 hours' : 'Within 48 hours'], ...(shipBy ? [['Your ship by date', shipBy.slice(0, 10)]] : [])],
      button, outro: 'Reply to this email or write in your portal if you want to add anything.',
    });
  }
  return { id: ids[0], code, codes, free: !!isFree };
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
  later(env, alertTeam(env, siteUrl(request, env), { title: 'New shop signed up', text: `${shopName} (${email})`, url: `${siteUrl(request, env)}/team/#/shops` }));
  return json({ ok: true }, 201, { 'set-cookie': s.cookie });
});
on('POST', '/auth/forgot', PUBLIC, async ({ request, env }) => {
  await rateLimit(env, request, 'forgot', 10, 60);
  const b = await readBody(request); const email = clean(field(b, 'email'), 200).toLowerCase();
  const u = validEmail(email) && await one(env, 'SELECT id, name FROM users WHERE email = ? AND active = 1', email);
  if (u) {
    const t = await makeLinkToken(env, u.id, 'reset', 2);
    const link = `${siteUrl(request, env)}/app/#/setup/${t}`;
    mailClient(env, siteUrl(request, env), email, u.name, 'Reset your CubiX password', { heading: 'Reset your password', intro: 'Use the button below within 2 hours to choose a new password.', button: { label: 'Set a new password', url: link }, outro: 'If you did not ask for this, ignore this email. Your password stays the same.' });
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
  const g = k => field(b, k);
  if (g('company_website')) return json({ ok: true, id: 'CX000000' }); // spam trap
  const name = clean(g('name'), 120), email = clean(g('email'), 200).toLowerCase();
  if (!name || !validEmail(email)) throw new HttpError(422, 'invalid', 'Add your name and a valid email address.');
  const files = b instanceof FormData ? b.getAll('files') : [];
  if (!hasFiles(b, files)) throw new HttpError(422, 'no_files', 'Add at least one photo or file.');
  let u = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (u && u.role !== 'client') throw new HttpError(422, 'invalid', 'Use a shop email address for orders.');
  let shop;
  if (u) shop = await one(env, 'SELECT * FROM shops WHERE id = ?', u.shop_id);
  else {
    shop = { id: uid('s_'), name: clean(g('shop'), 120) || name, url: clean(g('shop'), 300), free_used: 0 };
    u = { id: uid('u_') };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO shops (id, name, url, created_at) VALUES (?, ?, ?, ?)').bind(shop.id, shop.name, shop.url, now()),
      env.DB.prepare(`INSERT INTO users (id, email, name, role, shop_id, created_at) VALUES (?, ?, ?, 'client', ?, ?)`).bind(u.id, email, name, shop.id, now()),
    ]);
  }
  const r = await createOrder(env, { shop, userId: u.id, body: b, files, site: siteUrl(request, env), orderer: { id: u.id, email, name: u.name || name, needsLogin: !u.password_hash } });
  return json({ ok: true, id: r.code, free: r.free }, 201);
});

// ---------------------------------------------------------------- client portal
on('GET', '/client/orders', CLIENT, async ({ env, user }) => {
  const orders = await all(env, `SELECT o.id, o.code, o.title, o.product, o.status, o.is_free, o.price, o.paid, o.due_at, o.ship_by, o.item_no, o.item_count, o.created_at, o.updated_at,
      (SELECT COUNT(*) FROM files f WHERE f.order_id = o.id AND f.kind = 'preview' AND f.released = 1) AS previews,
      (SELECT COUNT(*) FROM files f WHERE f.order_id = o.id AND f.kind = 'final') AS finals,
      (SELECT f.id FROM files f WHERE f.order_id = o.id AND f.kind IN ('preview','reference') AND f.released = 1 AND f.type LIKE 'image/%' ORDER BY (f.kind = 'preview') DESC, f.created_at DESC LIMIT 1) AS thumb
      FROM orders o WHERE o.shop_id = ? ORDER BY o.created_at DESC`, user.shop_id);
  return json({ ok: true, orders: orders.map(o => ({ ...o, status: clientStatus(o.status) })) });
});
on('POST', '/client/orders', CLIENT, async ({ request, env, user }) => {
  const b = await readBody(request);
  const files = b instanceof FormData ? b.getAll('files') : [];
  if (!hasFiles(b, files)) throw new HttpError(422, 'no_files', 'Add at least one photo or file.');
  const shop = await one(env, 'SELECT * FROM shops WHERE id = ?', user.shop_id);
  const r = await createOrder(env, { shop, userId: user.id, body: b, files, site: siteUrl(request, env), orderer: { id: user.id, email: user.email, name: user.name }, ownerId: user.id });
  return json({ ok: true, ...r }, 201);
});
on('GET', '/client/orders/:id', CLIENT, async ({ env, params, user }) => json({ ok: true, order: await orderBundle(env, params.id, user) }));
on('POST', '/client/orders/:id/messages', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  const body = clean(field(b, 'body'), 4000); if (!body) throw new HttpError(422, 'invalid', 'Write a message first.');
  const at = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(uid('m_'), o.id, user.id, body, at),
    env.DB.prepare('UPDATE orders SET updated_at = ?, client_msg_at = ? WHERE id = ?').bind(at, at, o.id),
    ...resumeStatements(env, o, user.id, at),
  ]);
  later(env, alertTeam(env, siteUrl(request, env), { title: o.status === 'waiting' ? `${o.code}: the client answered, clock running again` : `Message on ${o.code}`, text: `${o.shop_name}: ${body.slice(0, 400)}`, url: teamUrl(siteUrl(request, env), o.id) }));
  return json({ ok: true }, 201);
});
on('POST', '/client/orders/:id/files', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (['paid', 'cancelled'].includes(o.status)) throw new HttpError(409, 'bad_state', 'This order is closed. Start a new order for new work.');
  const files = b instanceof FormData ? b.getAll('files') : [];
  if (!hasFiles(b, files)) throw new HttpError(422, 'no_files', 'Choose at least one file.');
  const r = uploadIds(b).length ? await attachUploads(env, o.id, uploadIds(b), 'reference', user.id, user.id) : await storeFiles(env, o.id, files, 'reference', user.id, thumbMap(b));
  const at = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET updated_at = ?, client_msg_at = ? WHERE id = ?').bind(at, at, o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'files', `Shop added ${r.files.length} file(s)`, at),
    ...resumeStatements(env, o, user.id, at),
  ]);
  later(env, alertTeam(env, siteUrl(request, env), { title: `New files on ${o.code}`, text: `${o.shop_name} added ${r.files.length} file(s).`, url: teamUrl(siteUrl(request, env), o.id) }));
  return json({ ok: true, files: r.files }, 201);
});
on('POST', '/client/orders/:id/approve', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  if (!['preview', 'delivered'].includes(o.status)) throw new HttpError(409, 'bad_state', 'There is nothing to approve yet.');
  const status = o.status === 'preview' ? 'approved' : 'delivered';
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET status = ?, approved_at = ?, updated_at = ?, client_msg_at = ? WHERE id = ?').bind(status, now(), now(), now(), o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, NULL, ?)').bind(o.id, user.id, 'approved', now()),
  ]);
  later(env, alertTeam(env, siteUrl(request, env), { title: `${o.code} approved`, text: `${o.shop_name} approved the ${status === 'approved' ? 'preview. Prepare the final files.' : 'delivered files.'}`, url: teamUrl(siteUrl(request, env), o.id) }));
  return json({ ok: true, status });
});
on('POST', '/client/orders/:id/revision', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (!['preview', 'delivered', 'approved'].includes(o.status)) throw new HttpError(409, 'bad_state', 'Revisions can be asked once a preview is ready.');
  const openPins = await one(env, "SELECT COUNT(*) AS n FROM pins WHERE order_id = ? AND status = 'open'", o.id);
  let body = clean(field(b, 'body'), 4000);
  if (!body && openPins.n) body = `Please see the ${openPins.n} open comment${openPins.n > 1 ? 's' : ''} on the model.`;
  if (!body) throw new HttpError(422, 'invalid', 'Tell us what to change, or comment on the model.');
  const pins = parsePins(field(b, 'pins'));
  const modelFile = clean(field(b, 'model_file'), 40) || null;
  const at = now(), round = (o.revisions || 0) + 2, rid = uid('r_');
  const due = addHours(at, 24);
  if (uploadIds(b).length) await attachUploads(env, o.id, uploadIds(b), 'reference', user.id, user.id, { requestId: rid });
  else if (b instanceof FormData) {
    const photos = b.getAll('files');
    if (photos.some(f => typeof f === 'object' && f.size > 0)) await storeFiles(env, o.id, photos, 'reference', user.id, thumbMap(b), { requestId: rid });
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = 'revisions', revisions = revisions + 1, approved_at = NULL, due_at = ?, handin_at = ?, updated_at = ?, client_msg_at = ? WHERE id = ?`).bind(due, handinFor(due, at), at, at, o.id),
    env.DB.prepare('INSERT INTO requests (id, order_id, round, body, pins, model_file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(rid, o.id, round, body, JSON.stringify(pins), modelFile, user.id, at),
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(uid('m_'), o.id, user.id, `Revision request for round ${round}: ${body}${pins.length ? `\n(${pins.length} pin${pins.length > 1 ? 's' : ''} on the model)` : ''}`, at),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'revision', `Round ${round}: ${body.slice(0, 160)}`, at),
  ]);
  later(env, alertTeam(env, siteUrl(request, env), { title: `Changes requested on ${o.code} (round ${round})`, text: `${o.shop_name}: ${body.slice(0, 400)}${pins.length ? `\n${pins.length} pin(s) on the model` : ''}`, url: teamUrl(siteUrl(request, env), o.id) }));
  return json({ ok: true, round });
});
on('POST', '/client/orders/:id/seen', CLIENT, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  if (o.status === 'preview' && !o.preview_seen_at) await env.DB.prepare('UPDATE orders SET preview_seen_at = ? WHERE id = ?').bind(now(), o.id).run();
  return json({ ok: true });
});

// ---------------------------------------------------------------- chunked uploads (files up to 100 MB on the free plan)
// 1. POST /uploads {name, size, type}  2. PUT /uploads/:id/:n with each 1.5 MB part  3. optional PUT /uploads/:id/thumb
// 4. POST /uploads/:id/finish  5. send upload_ids with the order, message or hand in.
on('POST', '/uploads', PUBLIC, async ({ request, env }) => {
  const user = await getUser(request, env);
  if (!user) await rateLimit(env, request, 'upload', 120, 60);
  const b = await readBody(request);
  const name = clean(field(b, 'name'), 200) || 'file', size = Number(field(b, 'size')), type = clean(field(b, 'type'), 100) || null;
  if (!(size > 0)) throw new HttpError(422, 'invalid', `${name} is empty.`);
  if (size > MAX_UPLOAD) throw new HttpError(413, 'file_too_large', `${name} is over 100 MB. Please share a download link in the notes instead.`);
  const id = 'up_' + uid('').slice(0, 24), parts = Math.ceil(size / CHUNK), at = now();
  // housekeeping: forget uploads that were never used within a day
  const stale = (await env.DB.prepare("SELECT id FROM uploads WHERE status <> 'attached' AND created_at < ? LIMIT 20").bind(addHours(at, -24)).all()).results;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO uploads (id, owner_id, name, size, type, parts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, user ? user.id : null, name, size, type, parts, 'open', at),
    ...stale.flatMap(x => [env.DB.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(x.id), env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(x.id)]),
  ]);
  return json({ ok: true, id, part_size: CHUNK, parts }, 201);
});
async function loadUpload(env, request, id) {
  if (!/^up_[a-f0-9]{24}$/.test(id)) throw new HttpError(404, 'not_found');
  const u = await one(env, 'SELECT id, owner_id, size, parts, status FROM uploads WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'not_found', 'This upload expired. Please add the file again.');
  if (u.owner_id) { const me = await getUser(request, env); if (!me || me.id !== u.owner_id) throw new HttpError(403, 'forbidden'); }
  if (u.status !== 'open') throw new HttpError(409, 'bad_state', 'This upload is already finished.');
  return u;
}
on('PUT', '/uploads/:id/thumb', PUBLIC, async ({ request, env, params }) => {
  const u = await loadUpload(env, request, params.id);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length || buf.length > 300 * 1024) throw new HttpError(413, 'too_large', 'Preview too large.');
  await env.DB.prepare('UPDATE uploads SET thumb = ? WHERE id = ?').bind(buf, u.id).run();
  return json({ ok: true });
});
on('PUT', '/uploads/:id/:n', PUBLIC, async ({ request, env, params }) => {
  const u = await loadUpload(env, request, params.id);
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 0 || n >= u.parts) throw new HttpError(422, 'invalid', 'Bad part number.');
  const expect = n === u.parts - 1 ? u.size - CHUNK * (u.parts - 1) : CHUNK;
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length !== expect) throw new HttpError(422, 'invalid', `Part ${n + 1} arrived incomplete. Please try again.`);
  await env.DB.prepare('INSERT OR REPLACE INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(u.id, n, buf).run();
  return json({ ok: true });
});
on('POST', '/uploads/:id/finish', PUBLIC, async ({ request, env, params }) => {
  const u = await loadUpload(env, request, params.id);
  const c = await one(env, 'SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM file_chunks WHERE file_id = ?', u.id);
  if (c.n !== u.parts || c.bytes !== u.size) throw new HttpError(422, 'incomplete', `The upload is incomplete (${c.n} of ${u.parts} parts). Please try again.`);
  await env.DB.prepare("UPDATE uploads SET status = 'done' WHERE id = ?").bind(u.id).run();
  return json({ ok: true, id: u.id });
});

// ---------------------------------------------------------------- comments pinned on the 3D model
async function loadPin(env, id, user) {
  const pin = await one(env, 'SELECT p.*, o.shop_id, o.code, o.created_by AS order_owner, o.status AS order_status FROM pins p JOIN orders o ON o.id = p.order_id WHERE p.id = ?', id);
  if (!pin || (!isTeam(user) && pin.shop_id !== user.shop_id)) throw new HttpError(404, 'not_found', 'Comment not found.');
  return pin;
}
async function addPin(env, request, o, user) {
  const b = await readBody(request);
  const body = clean(field(b, 'body'), 2000); if (!body) throw new HttpError(422, 'invalid', 'Write the comment first.');
  let pos = field(b, 'pos'); if (typeof pos === 'string') { try { pos = JSON.parse(pos); } catch { pos = null; } }
  if (!Array.isArray(pos) || pos.length !== 3 || pos.some(v => !isFinite(Number(v)))) throw new HttpError(422, 'invalid', 'Click a spot on the model first.');
  const at = now(), id = uid('p_');
  const nrow = await one(env, 'SELECT COALESCE(MAX(n), 0) + 1 AS n FROM pins WHERE order_id = ?', o.id);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO pins (id, order_id, n, round, part, pos, body, model_file, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, o.id, nrow.n, (o.revisions || 0) + 1, clean(field(b, 'part'), 120) || null, JSON.stringify(pos.map(v => Math.round(Number(v) * 1000) / 1000)), body, clean(field(b, 'model_file'), 40) || null, 'open', user.id, at),
    isTeam(user) ? env.DB.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').bind(at, o.id) : env.DB.prepare('UPDATE orders SET updated_at = ?, client_msg_at = ? WHERE id = ?').bind(at, at, o.id),
  ]);
  return { id, n: nrow.n };
}
on('POST', '/client/orders/:id/pins', CLIENT, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  if (!['preview', 'delivered', 'approved', 'revisions'].includes(o.status)) throw new HttpError(409, 'bad_state', 'Comments open once a preview is ready.');
  const r = await addPin(env, request, o, user);
  later(env, alertTeam(env, siteUrl(request, env), { title: `New comment ${r.n} on ${o.code}`, text: `${o.shop_name} commented on the model.`, url: teamUrl(siteUrl(request, env), o.id) }));
  return json({ ok: true, ...r }, 201);
});
on('POST', '/team/orders/:id/pins', TEAM, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  return json({ ok: true, ...(await addPin(env, request, o, user)) }, 201);
});
on('POST', '/pins/:id/replies', ANY, async ({ request, env, params, user }) => {
  const pin = await loadPin(env, params.id, user); const b = await readBody(request);
  const body = clean(field(b, 'body'), 2000); if (!body) throw new HttpError(422, 'invalid', 'Write a reply first.');
  const at = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO pin_replies (id, pin_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(uid('pr_'), pin.id, user.id, body, at),
    isTeam(user) ? env.DB.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').bind(at, pin.order_id) : env.DB.prepare('UPDATE orders SET updated_at = ?, client_msg_at = ? WHERE id = ?').bind(at, at, pin.order_id),
  ]);
  const site = siteUrl(request, env);
  if (isTeam(user)) { const c = await one(env, 'SELECT email, name FROM users WHERE id = ?', pin.order_owner); if (c) mailClient(env, site, c.email, c.name, `Reply on comment ${pin.n}, order ${pin.code}`, { heading: `Reply on comment ${pin.n}`, intro: `<i>${escH(pin.body)}</i><br><br>${escH(body).replace(/\n/g, '<br>')}`, button: { label: 'Open the model', url: portalUrl(site, pin.order_id) } }); }
  else later(env, alertTeam(env, site, { title: `Reply on comment ${pin.n}, ${pin.code}`, text: body.slice(0, 400), url: teamUrl(site, pin.order_id) }));
  return json({ ok: true }, 201);
});
on('POST', '/pins/:id/resolve', ANY, async ({ request, env, params, user }) => {
  const pin = await loadPin(env, params.id, user); const b = await readBody(request);
  const resolved = field(b, 'resolved') !== false && field(b, 'resolved') !== 'false';
  if (resolved && !isTeam(user)) throw new HttpError(403, 'forbidden', 'The team marks comments as done. You can reopen one if it is not fixed.');
  await env.DB.prepare('UPDATE pins SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').bind(resolved ? 'resolved' : 'open', resolved ? user.id : null, resolved ? now() : null, pin.id).run();
  return json({ ok: true, status: resolved ? 'resolved' : 'open' });
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
  const open = OPEN_STATUSES.filter(s => !['approved', 'waiting', 'preview'].includes(s)); // the clock runs only while we are building
  const ph = open.map(() => '?').join(',');
  const held = OPEN_STATUSES.filter(s => s !== 'approved'), hph = held.map(() => '?').join(',');
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const r = await env.DB.batch([
    q('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
    q(`SELECT
        SUM(CASE WHEN status IN (${ph}) AND due_at < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN status IN (${ph}) AND due_at >= ? AND due_at < ? THEN 1 ELSE 0 END) AS due_soon,
        SUM(CASE WHEN status IN ('new','confirmed') AND assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS in_review,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status IN ('delivered','approved') AND paid = 0 AND is_free = 0 THEN 1 ELSE 0 END) AS awaiting_n,
        COALESCE(SUM(CASE WHEN status IN ('delivered','approved') AND paid = 0 AND is_free = 0 THEN price END), 0) AS awaiting_total,
        COALESCE(SUM(CASE WHEN paid = 1 AND updated_at >= ? THEN price END), 0) AS paid_total,
        SUM(CASE WHEN paid = 1 AND updated_at >= ? THEN 1 ELSE 0 END) AS paid_n
      FROM orders`, ...open, t, ...open, t, soon, monthStart, monthStart),
    q('SELECT COUNT(*) AS n, AVG((julianday(delivered_at) - julianday(created_at)) * 24) AS avg_h FROM orders WHERE delivered_at IS NOT NULL AND delivered_at >= ?', addHours(t, -24 * 30)),
    q(`SELECT u.id, u.name, u.role, u.capacity,
        (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.status IN (${hph})) AS open,
        (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.status IN (${ph}) AND o.due_at < ?) AS overdue,
        (SELECT COUNT(*) FROM orders o WHERE o.assignee_id = u.id AND o.delivered_at >= ?) AS delivered_7d
      FROM users u WHERE u.role IN ('admin','modeler') AND u.active = 1 ORDER BY u.name`, ...held, ...open, t, addHours(t, -24 * 7)),
    q('SELECT COUNT(*) AS n FROM shops WHERE created_at >= ?', monthStart),
    q("SELECT COALESCE(NULLIF(source, ''), 'Direct') AS source, COUNT(*) AS n FROM orders WHERE created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 8", addHours(t, -24 * 30)),
    q('SELECT COALESCE(SUM(size), 0) AS bytes FROM files'),
    q(`SELECT o.id, o.code, o.title, o.status, o.due_at, o.priority, o.is_free, s.name AS shop_name, a.name AS assignee_name
      FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN users a ON a.id = o.assignee_id
      WHERE o.status IN (${hph}) AND ((o.status IN (${ph}) AND o.due_at < ?) OR (o.assignee_id IS NULL AND o.status IN ('new','confirmed')) OR o.status IN ('revisions','review')
        OR (o.client_msg_at IS NOT NULL AND o.client_msg_at > COALESCE(o.team_seen_at, ''))) ORDER BY CASE o.status WHEN 'review' THEN 0 ELSE 1 END, o.due_at LIMIT 15`, ...held, ...open, soon),
  ]);
  const c = r[1].results[0], d = r[2].results[0], team = r[3].results;
  return json({ ok: true, byStatus: r[0].results, overdue: c.overdue || 0, dueSoon: c.due_soon || 0, unassigned: c.unassigned || 0, inReview: c.in_review || 0, waiting: c.waiting || 0,
    awaiting: { n: c.awaiting_n || 0, total: c.awaiting_total }, paidMonth: { n: c.paid_n || 0, total: c.paid_total },
    avgHours: d.n ? d.avg_h : null, deliveredLast30: d.n, team, capacity: team.reduce((a, m) => a + m.capacity, 0), load: team.reduce((a, m) => a + m.open, 0),
    newShops: r[4].results[0].n, attention: r[7].results, sources: r[5].results,
    storage: { bytes: r[6].results[0].bytes, limit: env.FILES ? null : STORAGE_LIMIT } });
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
  const running = OPEN_STATUSES.filter(s => !['approved', 'waiting', 'preview'].includes(s));
  if (q.get('due') === 'overdue') { where.push(`o.due_at < ? AND o.status IN (${running.map(() => '?').join(',')})`); b.push(now(), ...running); }
  if (q.get('unpaid') === '1') where.push("o.paid = 0 AND o.is_free = 0 AND o.status IN ('delivered','approved')");
  const term = clean(q.get('q'), 80);
  if (term) { where.push('(o.code LIKE ? OR o.title LIKE ? OR s.name LIKE ?)'); b.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  const sort = q.get('sort') === 'new' ? 'o.created_at DESC' : "CASE o.priority WHEN 'rush' THEN 0 ELSE 1 END, o.due_at";
  const orders = await all(env, `SELECT o.id, o.code, o.title, o.product, o.status, o.priority, o.is_free, o.price, o.paid, o.paid_via, o.due_at, o.created_at, o.updated_at, o.revisions,
      o.handin_at, o.ship_by, o.item_no, o.item_count, o.group_id, o.preview_seen_at, o.paused_at,
      (o.client_msg_at IS NOT NULL AND o.client_msg_at > COALESCE(o.team_seen_at, '')) AS unread,
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
    if (b.status === 'waiting' && o.status !== 'waiting') throw new HttpError(422, 'invalid', 'Use "Ask the client" so they know what you need.');
    if (b.status === 'preview' && o.status !== 'preview') {
      const held = await one(env, "SELECT COUNT(*) AS n FROM files WHERE order_id = ? AND kind = 'preview' AND released = 0", o.id);
      if (held.n) {
        if (!admin) throw new HttpError(403, 'forbidden', 'An admin checks previews before they go to the client.');
        await releasePreview(env, request, o, user.id, now());
        return json({ ok: true, order: await orderBundle(env, o.id, user) });
      }
    }
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
  if (b.ship_by !== undefined) { set.push('ship_by = ?'); vals.push(parseDay(b.ship_by)); events.push(['ship_by', `Ship by ${b.ship_by || 'none'}`]); }
  if (b.handin_at !== undefined) {
    if (!admin) throw new HttpError(403, 'forbidden', 'Only an admin can move the hand in time.');
    if (isNaN(Date.parse(b.handin_at))) throw new HttpError(422, 'invalid', 'Pick a valid hand in time.');
    set.push('handin_at = ?'); vals.push(new Date(b.handin_at).toISOString()); events.push(['handin', `Hand in by ${new Date(b.handin_at).toISOString()}`]);
  }
  for (const [k, adminOnly] of [['priority', false], ['due_at', false], ['price', true], ['paid', true], ['paid_via', true], ['title', false]]) {
    if (b[k] === undefined) continue;
    if (adminOnly && !admin) throw new HttpError(403, 'forbidden', 'Only an admin can change pricing and payments.');
    let v = b[k];
    if (k === 'priority') { if (!['normal', 'rush'].includes(v)) throw new HttpError(422, 'invalid'); }
    if (k === 'due_at') {
      if (isNaN(Date.parse(v))) throw new HttpError(422, 'invalid', 'Pick a valid due date.'); v = new Date(v).toISOString();
      if (b.handin_at === undefined) { set.push('handin_at = ?'); vals.push(handinFor(v, o.created_at > v ? now() : o.created_at)); }
    }
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

// QC: pass the handed in preview to the client, or send it back to the modeler with a note.
on('POST', '/team/orders/:id/qc', ADMIN, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (o.status !== 'review') throw new HttpError(409, 'bad_state', 'This order is not waiting for a QC check.');
  const at = now();
  if (field(b, 'action') === 'pass') { await releasePreview(env, request, o, user.id, at); return json({ ok: true, order: await orderBundle(env, o.id, user) }); }
  if (field(b, 'action') !== 'back') throw new HttpError(422, 'invalid', 'Choose pass or send back.');
  const note = clean(field(b, 'note'), 2000); if (!note) throw new HttpError(422, 'invalid', 'Tell the modeler what to fix.');
  const back = o.revisions ? 'revisions' : 'modeling';
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind(back, at, o.id),
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(uid('m_'), o.id, user.id, `QC sent this back: ${note}`, at),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'qc', `Sent back to the modeler: ${note.slice(0, 200)}`, at),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'status', `review to ${back}`, at),
  ]);
  if (o.assignee_id) { const m = await one(env, 'SELECT email, name FROM users WHERE id = ?', o.assignee_id); if (m) later(env, sendMail(env, m.email, `QC sent ${o.code} back`, `${note}\n\n${teamUrl(siteUrl(request, env), o.id)}`, emailHtml(siteUrl(request, env), { heading: `${o.code} needs another pass`, intro: escH(note).replace(/\n/g, '<br>'), button: { label: 'Open the order', url: teamUrl(siteUrl(request, env), o.id) } }))); }
  return json({ ok: true, order: await orderBundle(env, o.id, user) });
});

// Ask the client for something (a photo, a detail). The clock pauses until they answer.
on('POST', '/team/orders/:id/ask', TEAM, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  if (!['new', 'confirmed', 'modeling', 'revisions'].includes(o.status)) throw new HttpError(409, 'bad_state', 'You can pause only while the model is being built.');
  const body = clean(field(b, 'body'), 2000); if (!body) throw new HttpError(422, 'invalid', 'Tell the client what you need.');
  const at = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = 'waiting', wait_from = ?, paused_at = ?, updated_at = ? WHERE id = ?").bind(o.status === 'new' ? 'confirmed' : o.status, at, at, o.id),
    env.DB.prepare('INSERT INTO messages (id, order_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(uid('m_'), o.id, user.id, body, at),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'status', `${o.status} to waiting`, at),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'waiting', `Asked the client: ${body.slice(0, 200)}`, at),
  ]);
  const c = await one(env, 'SELECT email, name FROM users WHERE id = ?', o.created_by);
  if (c) mailClient(env, siteUrl(request, env), c.email, c.name, `We need something for ${o.code}`, { heading: 'We need one thing from you', intro: `${escH(body).replace(/\n/g, '<br>')}<br><br>Your turnaround clock is paused until you answer, so you lose no time.`, button: { label: 'Answer in your portal', url: portalUrl(siteUrl(request, env), o.id) } });
  return json({ ok: true, order: await orderBundle(env, o.id, user) });
});
on('POST', '/team/orders/:id/resume', TEAM, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  if (o.status !== 'waiting') throw new HttpError(409, 'bad_state', 'This order is not paused.');
  await env.DB.batch(resumeStatements(env, o, user.id, now()));
  return json({ ok: true, order: await orderBundle(env, o.id, user) });
});
// "Got it": the team has read the client's latest message or change.
on('POST', '/team/orders/:id/seen', TEAM, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  await env.DB.prepare('UPDATE orders SET team_seen_at = ? WHERE id = ?').bind(now(), o.id).run();
  return json({ ok: true });
});

// Job Bank: hand the modeler the most urgent unassigned order, within their capacity.
on('POST', '/team/jobs/next', TEAM, async ({ env, user }) => {
  const running = OPEN_STATUSES.filter(s => s !== 'approved');
  const ph = running.map(() => '?').join(',');
  const [held] = (await env.DB.batch([env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE assignee_id = ? AND status IN (${ph})`).bind(user.id, ...running)])).map(r => r.results[0]);
  if (held.n >= user.capacity) throw new HttpError(409, 'at_capacity', `You hold ${held.n} of ${user.capacity}. Hand in or finish one first.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await one(env, `SELECT id, code, status FROM orders WHERE assignee_id IS NULL AND status IN ('new','confirmed')
      ORDER BY CASE priority WHEN 'rush' THEN 0 ELSE 1 END, COALESCE(handin_at, due_at), created_at LIMIT 1`);
    if (!next) return json({ ok: true, order: null, held: held.n, capacity: user.capacity });
    const at = now();
    const r = await env.DB.prepare(`UPDATE orders SET assignee_id = ?, status = CASE WHEN status = 'new' THEN 'confirmed' ELSE status END, updated_at = ? WHERE id = ? AND assignee_id IS NULL`).bind(user.id, at, next.id).run();
    if (!r.meta.changes) continue; // someone else took it a moment earlier
    await env.DB.batch([
      env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(next.id, user.id, 'assigned', `${user.name} (Job Bank)`, at),
      ...(next.status === 'new' ? [env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(next.id, user.id, 'status', 'new to confirmed', at)] : []),
    ]);
    return json({ ok: true, order: { id: next.id, code: next.code }, held: held.n + 1, capacity: user.capacity });
  }
  throw new HttpError(409, 'busy', 'Another modeler took that job. Try again.');
});

// ---------------------------------------------------------------- build rules (handbook per product, rules per shop)
on('GET', '/team/rules', TEAM, async ({ env, url }) => {
  const shop = url.searchParams.get('shop');
  const rules = await all(env, `SELECT ru.*, u.name AS updated_by_name FROM rules ru LEFT JOIN users u ON u.id = ru.updated_by
    WHERE ${shop ? "ru.scope = 'shop' AND ru.shop_id = ?" : "ru.scope = 'product'"} ORDER BY lower(ru.product), ru.title`, ...(shop ? [shop] : []));
  const products = (await all(env, "SELECT DISTINCT product FROM orders WHERE product IS NOT NULL AND product <> '' ORDER BY product LIMIT 50")).map(r => r.product);
  return json({ ok: true, rules, products });
});
on('POST', '/team/rules', ADMIN, async ({ request, env, user }) => {
  const b = await readBody(request);
  const scope = b.scope === 'shop' ? 'shop' : 'product';
  const title = clean(b.title, 120), body = clean(b.body, 3000), product = clean(b.product, 80) || 'All';
  if (!title || !body) throw new HttpError(422, 'invalid', 'Add a title and the rule.');
  if (scope === 'shop' && !(b.shop_id && await one(env, 'SELECT 1 FROM shops WHERE id = ?', b.shop_id))) throw new HttpError(422, 'invalid', 'Pick the shop.');
  const id = uid('ru_'), at = now();
  await env.DB.prepare('INSERT INTO rules (id, scope, product, shop_id, title, body, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, scope, scope === 'product' ? product : null, scope === 'shop' ? b.shop_id : null, title, body, user.id, at, at).run();
  return json({ ok: true, id }, 201);
});
on('PATCH', '/team/rules/:id', ADMIN, async ({ request, env, params, user }) => {
  const b = await readBody(request);
  const ru = await one(env, 'SELECT * FROM rules WHERE id = ?', params.id); if (!ru) throw new HttpError(404, 'not_found');
  const title = b.title !== undefined ? clean(b.title, 120) : ru.title, body = b.body !== undefined ? clean(b.body, 3000) : ru.body;
  const product = ru.scope === 'product' && b.product !== undefined ? (clean(b.product, 80) || 'All') : ru.product;
  if (!title || !body) throw new HttpError(422, 'invalid', 'Add a title and the rule.');
  await env.DB.prepare('UPDATE rules SET title = ?, body = ?, product = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(title, body, product, user.id, now(), ru.id).run();
  return json({ ok: true });
});
on('POST', '/team/rules/:id/delete', ADMIN, async ({ env, params }) => {
  await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(params.id).run();
  return json({ ok: true });
});

on('POST', '/team/orders/:id/delete', ADMIN, async ({ env, params, user }) => {
  const o = await loadOrder(env, params.id, user);
  const inv = await one(env, "SELECT COUNT(*) AS n FROM invoices WHERE order_id = ? AND status IN ('sent','paid')", o.id);
  if (inv.n) throw new HttpError(409, 'bad_state', 'This order has a sent or paid invoice. Void the invoice instead of deleting the order.');
  const files = await all(env, 'SELECT DISTINCT f.r2_key FROM files f WHERE f.order_id = ? AND NOT EXISTS (SELECT 1 FROM files g WHERE g.r2_key = f.r2_key AND g.order_id <> f.order_id)', o.id);
  await removeBlobs(env, files.map(f => f.r2_key));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invoices WHERE order_id = ?').bind(o.id),
    env.DB.prepare('DELETE FROM requests WHERE order_id = ?').bind(o.id),
    env.DB.prepare('DELETE FROM pin_replies WHERE pin_id IN (SELECT id FROM pins WHERE order_id = ?)').bind(o.id),
    env.DB.prepare('DELETE FROM pins WHERE order_id = ?').bind(o.id),
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
    if (c) mailClient(env, siteUrl(request, env), c.email, c.name, `New message on order ${o.code}`, { heading: `New message on ${o.code}`, intro: escH(body).replace(/\n/g, '<br>'), button: { label: 'Reply in your portal', url: portalUrl(siteUrl(request, env), o.id) } });
  }
  return json({ ok: true }, 201);
});

on('POST', '/team/orders/:id/files', TEAM, async ({ request, env, params, user }) => {
  const o = await loadOrder(env, params.id, user); const b = await readBody(request);
  const kind = field(b, 'kind');
  if (!['preview', 'final', 'reference'].includes(kind)) throw new HttpError(422, 'invalid', 'Pick preview or final files.');
  const files = b instanceof FormData ? b.getAll('files') : [];
  if (!hasFiles(b, files)) throw new HttpError(422, 'no_files', 'Choose at least one file.');
  const st = await getSettings(env);
  const qc = kind === 'preview' && st.qc_enabled === '1' && user.role !== 'admin'; // admins are the QC, their previews go straight out
  const r = uploadIds(b).length ? await attachUploads(env, o.id, uploadIds(b), kind, user.id, user.id, { released: !qc })
    : await storeFiles(env, o.id, files, kind, user.id, thumbMap(b), { released: !qc });
  const at = now(); let status = o.status;
  if (kind === 'preview' && ['new', 'confirmed', 'modeling', 'revisions', 'waiting', 'review', 'preview'].includes(o.status)) status = qc ? 'review' : 'preview';
  if (kind === 'final' && o.status !== 'cancelled') status = o.paid ? 'paid' : 'delivered';
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ?, paused_at = NULL, wait_from = NULL, delivered_at = CASE WHEN ? = 'final' AND delivered_at IS NULL THEN ? ELSE delivered_at END,
      preview_seen_at = CASE WHEN ? = 'preview' THEN NULL ELSE preview_seen_at END WHERE id = ?`).bind(status, at, kind, at, status, o.id),
    env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, kind === 'final' ? 'delivered' : 'preview', `Version ${r.version}, ${r.files.length} file(s)`, at),
    ...(status !== o.status ? [env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(o.id, user.id, 'status', `${o.status} to ${status}`, at)] : []),
  ]);
  const c = await one(env, 'SELECT email, name FROM users WHERE id = ?', o.created_by);
  if (qc) later(env, alertTeam(env, siteUrl(request, env), { title: `${o.code} is ready for QC`, text: `${user.name} handed in version ${r.version} of ${o.title}. Check it and send it to the client.`, url: teamUrl(siteUrl(request, env), o.id) }));
  if (c && kind !== 'reference' && !qc) mailClient(env, siteUrl(request, env), c.email, c.name, kind === 'final' ? `Your files for ${o.code} are ready` : `Preview ready for ${o.code}`, kind === 'final'
    ? { heading: 'Your print ready files are ready', intro: `The final files for <b>${escH(o.title)}</b> are ready to download.`, lines: [['Order', o.code], ['Files', `${r.files.length} file(s), version ${r.version}`]], button: { label: 'Download your files', url: portalUrl(siteUrl(request, env), o.id) }, outro: 'Something not printing right? Reply in the portal and we fix it.' }
    : { heading: 'Your preview is ready', intro: `Have a look at the preview for <b>${escH(o.title)}</b>. Approve it, or tell us what to change. You can rotate the 3D model and pin exactly what to change.`, lines: [['Order', o.code], ['Version', String(r.version)]], button: { label: 'Review the preview', url: portalUrl(siteUrl(request, env), o.id) } });
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
  const emailed = await sendMail(env, email, 'Your CubiX client portal', `Hi ${contact || name},\n\nYour CubiX client portal is ready. Set a password with the button below (the link works for 7 days). Your first model is free.\n${link}`,
    emailHtml(siteUrl(request, env), { heading: 'Your CubiX portal is ready', intro: `Hi ${escH(contact || name)},<br><br>Your CubiX client portal is ready. Set a password with the button below (the link works for 7 days). Your first model is free.`, button: { label: 'Set my password', url: link } }));
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
  const emailed = await sendMail(env, u.email, 'Your CubiX login', `Hi ${u.name},\n\nSet your password with the button below. The link works once, for 3 days.\n${link}`,
    emailHtml(siteUrl(request, env), { heading: 'Your CubiX login', intro: `Hi ${escH(u.name)},<br><br>Set your password with the button below. The link works once, for 3 days.`, button: { label: 'Set my password', url: link } }));
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
  const emailed = await sendMail(env, email, 'You are invited to the CubiX team', `Hi ${name},\n\nYou have been invited to the CubiX production dashboard. Set your password with the button below (valid for 3 days).\n${link}`,
    emailHtml(siteUrl(request, env), { heading: 'Welcome to the CubiX team', intro: `Hi ${escH(name)},<br><br>You have been invited to the CubiX production dashboard. Set your password with the button below (valid for 3 days).`, button: { label: 'Join the team', url: link } }));
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
  // notifications and payments
  alert_webhook: '',
  alert_email: '',
  mail_from: '',
  paypal_me: '',
  qc_enabled: '0',
};
const STORAGE_LIMIT = 5 * 1024 * 1024 * 1024; // D1 free plan
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
  if (b.pay_url !== undefined) { const u2 = clean(b.pay_url, 500); if (u2 && !/^https:\/\/[^\s]+$/.test(u2)) throw new HttpError(422, 'invalid', 'The payment link must start with https://'); set.push('pay_url = ?'); vals.push(u2 || null); }
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
  const emailed = inv.bill_email ? await sendMail(env, inv.bill_email, `Invoice ${inv.number} from ${st.biz_name}`,
    `Hi ${inv.bill_name},\n\nPlease find invoice ${inv.number} for ${inv.currency} ${inv.total.toFixed(2)} here:\n${link}\n\n${st.payment_note}\n\nThank you.`,
    emailHtml(siteUrl(request, env), { heading: `Invoice ${inv.number}`, intro: `Hi ${escH(inv.bill_name)},<br><br>Here is your invoice from ${escH(st.biz_name)}. You can view it online and save it as a PDF.`,
      lines: [['Invoice', inv.number], ['Amount', `${inv.currency} ${inv.total.toFixed(2)}`], ['Terms', inv.terms || 'Due on receipt']], button: { label: 'View invoice', url: link }, outro: escH(st.payment_note) })) : false;
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

async function settingsStatus(env) {
  env.__notify = null;
  const st = await one(env, 'SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM files');
  return { email_ready: await emailReady(env), resend_key: !!env.RESEND_API_KEY, webhook: !!(await notifySettings(env)).webhook,
    storage: { bytes: st.bytes, files: st.n, limit: env.FILES ? null : STORAGE_LIMIT, backend: env.FILES ? 'R2' : 'D1' }, backup_key: !!env.BACKUP_KEY };
}
on('GET', '/team/settings', ADMIN, async ({ env }) => json({ ok: true, settings: await getSettings(env), status: await settingsStatus(env) }));
on('POST', '/team/settings/test-alert', ADMIN, async ({ request, env, user }) => {
  const n = await notifySettings(env);
  if (!n.webhook && !(env.RESEND_API_KEY && n.from)) throw new HttpError(409, 'not_configured', 'Add a webhook link or connect email first.');
  await alertTeam(env, siteUrl(request, env), { title: 'Test alert', text: `${user.name} sent a test from the CubiX dashboard. Alerts are working.`, url: `${siteUrl(request, env)}/team/` });
  return json({ ok: true });
});
on('POST', '/team/settings/test-email', ADMIN, async ({ request, env, user }) => {
  if (!(await emailReady(env))) throw new HttpError(409, 'not_configured', env.RESEND_API_KEY ? 'Add the sender address (for example CubiX <orders@axys3d.com>) first.' : 'Email is not connected yet. Add the Resend key in Cloudflare first.');
  const ok = await sendMail(env, user.email, 'CubiX test email', `Hi ${user.name},\n\nEmail from the CubiX dashboard is working.`,
    emailHtml(siteUrl(request, env), { heading: 'Email is working', intro: `Hi ${escH(user.name)},<br><br>This test came from the CubiX dashboard. Clients and your team will now get emails automatically.`, button: { label: 'Open dashboard', url: `${siteUrl(request, env)}/team/` } }));
  if (!ok) throw new HttpError(502, 'send_failed', 'Resend did not accept the email. Check the key and that the sender domain is verified in Resend.');
  return json({ ok: true, to: user.email });
});

// Data backup as JSON: every table except file contents, sessions and one time links.
// Admins download it from Settings; the weekly GitHub Action uses the BACKUP_KEY secret.
on('GET', '/backup', PUBLIC, async ({ request, env }) => {
  const key = request.headers.get('x-backup-key');
  if (!(env.BACKUP_KEY && env.BACKUP_KEY.length >= 24 && key && key === env.BACKUP_KEY)) {
    const u = await getUser(request, env);
    if (!u) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    if (u.role !== 'admin') throw new HttpError(403, 'forbidden');
  }
  const tables = ['shops', 'users', 'orders', 'files', 'messages', 'events', 'invoices', 'settings', 'requests', 'rules', 'pins', 'pin_replies'];
  const cols = { files: 'id, order_id, kind, version, r2_key, name, size, type, uploaded_by, created_at, released, request_id' };
  const r = await env.DB.batch(tables.map(t => env.DB.prepare(`SELECT ${cols[t] || '*'} FROM ${t}`)));
  const data = Object.fromEntries(tables.map((t, i) => [t, r[i].results]));
  const at = now();
  return new Response(JSON.stringify({ app: 'cubix', version: 1, exported_at: at, counts: Object.fromEntries(tables.map(t => [t, data[t].length])), tables: data }), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="cubix-backup-${at.slice(0, 10)}.json"`, 'cache-control': 'no-store' } });
});
on('PATCH', '/team/settings', ADMIN, async ({ request, env }) => {
  const b = await readBody(request), stmts = [];
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (b[k] === undefined) continue;
    let v = clean(b[k], k.endsWith('note') || k === 'notes' ? 1500 : k === 'alert_webhook' ? 500 : 200);
    if (k === 'qc_enabled') v = v === '0' || v === 'false' ? '0' : '1';
    if (k === 'paypal_me') v = v.replace(/^https?:\/\/(www\.)?paypal\.me\//, '').replace(/\/.*$/, '');
    if (k === 'biz_email' && v && !validEmail(v)) throw new HttpError(422, 'invalid', 'The business email is not valid.');
    if (k === 'biz_name' && !v) throw new HttpError(422, 'invalid', 'Add the business name.');
    if (k === 'alert_webhook' && v && !/^https:\/\/[^\s]+$/.test(v)) throw new HttpError(422, 'invalid', 'The webhook must be an https link from Slack, Discord or Google Chat.');
    if (k === 'alert_email' && v && !v.split(/[,\s]+/).filter(Boolean).every(validEmail)) throw new HttpError(422, 'invalid', 'Alert emails must be valid addresses, separated by commas.');
    if (k === 'mail_from' && v && !/^([^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v)) throw new HttpError(422, 'invalid', 'Sender must look like CubiX <orders@yourdomain.com>.');
    if (k === 'paypal_me' && v && !/^[A-Za-z0-9._-]{2,40}$/.test(v.replace(/^https?:\/\/(www\.)?paypal\.me\//, ''))) throw new HttpError(422, 'invalid', 'Enter your PayPal.me name, for example cubix3d.');
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
  const pick = ['number', 'status', 'pay_url', 'bill_name', 'bill_email', 'bill_extra', 'project_title', 'project_ref', 'currency', 'tax_rate', 'subtotal', 'tax', 'total', 'terms', 'payment_note', 'notes', 'issued_at', 'sent_at', 'paid_at', 'paid_via'];
  const out = Object.fromEntries(pick.map(k => [k, inv[k]])); out.items = JSON.parse(inv.items || '[]');
  if (inv.status === 'sent' && st.paypal_me) out.paypal_url = `https://paypal.me/${encodeURIComponent(st.paypal_me)}/${inv.total.toFixed(2)}${inv.currency}`;
  return json({ ok: true, invoice: out, business: { name: st.biz_name, tagline: st.biz_tagline, email: st.biz_email, website: st.biz_website, address: st.biz_address } },
    200, { 'x-robots-tag': 'noindex' });
});
