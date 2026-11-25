// Shared helpers for the CubiX API: responses, ids, password hashing, sessions, email.

export const STATUSES = ['new', 'confirmed', 'modeling', 'waiting', 'review', 'preview', 'revisions', 'approved', 'delivered', 'paid', 'cancelled'];
export const OPEN_STATUSES = ['new', 'confirmed', 'modeling', 'waiting', 'review', 'preview', 'revisions', 'approved'];
export const PLANS = ['pay_per_model', 'starter', 'growth', 'studio'];
export const TURNAROUND_HOURS = 48;
export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_FILES = 20;
const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000;

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const now = () => new Date().toISOString();
export const addHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600e3).toISOString();

export function uid(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function orderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(6));
  return 'CX' + [...b].map(x => alphabet[x % alphabet.length]).join('');
}
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }

export async function hashPassword(password, saltHex) {
  const salt = saltHex || randomToken().slice(0, 32);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER }, key, 256);
  return { hash: hex(bits), salt };
}
export async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const r = await hashPassword(password, salt);
  if (r.hash.length !== hash.length) return false;
  let diff = 0; for (let i = 0; i < hash.length; i++) diff |= r.hash.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export const clean = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
export const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
export function validPassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new HttpError(422, 'weak_password', 'Use at least 8 characters.');
  if (p.length > 200) throw new HttpError(422, 'weak_password', 'Password is too long.');
}

// ---------- sessions ----------
export function readCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return null;
}
export async function createSession(env, userId) {
  const token = randomToken();
  const expires = addHours(now(), SESSION_DAYS * 24);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), userId, expires, now()),
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), userId),
    // housekeeping: drop expired sessions and old one time links
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
    env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?').bind(addHours(now(), -24 * 30)),
  ]);
  return { token, cookie: `cx_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` };
}
export const clearCookie = 'cx_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
export async function getUser(request, env) {
  const token = readCookie(request, 'cx_session');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.role, u.shop_id, u.capacity, u.active, s.expires_at,
      sh.name AS shop_name, sh.url AS shop_url, sh.plan AS shop_plan, sh.free_used AS shop_free_used
      FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN shops sh ON sh.id = u.shop_id WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!row || !row.active || row.expires_at < now()) return null;
  return row;
}
export async function destroySession(request, env) {
  const token = readCookie(request, 'cx_session');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

// ---------- one time links (password setup / reset) ----------
export async function makeLinkToken(env, userId, purpose, hours = 72) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), userId, purpose, addHours(now(), hours)).run();
  return token;
}
export async function useLinkToken(env, token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new HttpError(400, 'bad_token', 'This link is not valid.');
  const h = await sha256(token);
  const row = await env.DB.prepare('SELECT * FROM tokens WHERE token_hash = ?').bind(h).first();
  if (!row || row.used || row.expires_at < now()) throw new HttpError(400, 'bad_token', 'This link has expired or was already used. Ask us for a new one.');
  await env.DB.prepare('UPDATE tokens SET used = 1 WHERE token_hash = ?').bind(h).run();
  return row;
}
export function siteUrl(request, env) { return (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, ''); }

// ---------- email (optional: Resend). Without a key, nothing is sent and callers return the link instead ----------
export async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }),
    });
    return r.ok;
  } catch { return false; }
}
export async function notifyTeam(env, text) {
  if (!env.ORDER_WEBHOOK) return;
  try { await fetch(env.ORDER_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) }); } catch {}
}

export async function logEvent(env, orderId, userId, type, detail = null) {
  await env.DB.prepare('INSERT INTO events (order_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(orderId, userId, type, detail ? String(detail).slice(0, 500) : null, now()).run();
}

// ---------- files ----------
export function safeName(name, i) { return (String(name || '').replace(/[^\w.\-() ]/g, '_').slice(0, 120)) || `file${i}`; }
// thumbs: optional Map of file name -> small preview image made in the browser
export async function storeFiles(env, orderId, list, kind, userId, thumbs, opts = {}) {
  const files = list.filter(f => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
  if (files.length > MAX_FILES) throw new HttpError(413, 'too_many_files', `Up to ${MAX_FILES} files per upload.`);
  for (const f of files) if (f.size > MAX_FILE) throw new HttpError(413, 'file_too_large', `${f.name} is over 25 MB.`);
  let version = 1;
  if (kind !== 'reference') {
    const row = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM files WHERE order_id = ? AND kind = ?').bind(orderId, kind).first();
    version = (row.v || 0) + 1;
  }
  const rows = [], chunks = [], out = [], written = [];
  try {
    for (const [i, f] of files.entries()) {
      const id = uid('f_');
      let key = `orders/${orderId}/${kind}/v${version}/${id}_${safeName(f.name, i)}`;
      if (env.FILES) { await env.FILES.put(key, f.stream(), { httpMetadata: { contentType: f.type || 'application/octet-stream' } }); written.push(key); }
      else { chunks.push(...await chunkStatements(env, id, f)); key = 'd1:' + id; written.push(key); }
      let thumb = null;
      const t = thumbs && thumbs.get(f.name);
      if (t && t.size > 0 && t.size < 300 * 1024 && /^image\//.test(f.type || '')) thumb = new Uint8Array(await t.arrayBuffer());
      rows.push(env.DB.prepare('INSERT INTO files (id, order_id, kind, version, r2_key, name, size, type, uploaded_by, created_at, thumb, released, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, orderId, kind, version, key, String(f.name || `file${i}`).slice(0, 200), f.size, f.type || null, userId, now(), thumb, opts.released === false ? 0 : 1, opts.requestId || null));
      out.push({ id, name: f.name, size: f.size });
    }
    // write chunk rows in batches of about 6 MB, then all file rows in one batch
    let group = [], bytes = 0;
    for (const c of chunks) {
      group.push(c.stmt); bytes += c.size;
      if (bytes > 6 * 1024 * 1024) { await env.DB.batch(group); group = []; bytes = 0; }
    }
    if (group.length) await env.DB.batch(group);
    if (rows.length) await env.DB.batch(rows);
  } catch (e) { await removeBlobs(env, written); throw e; }
  return { files: out, version };
}

// Browser side thumbnails arrive as "thumbs" form parts named after the original file.
export function thumbMap(form) {
  const m = new Map();
  if (form instanceof FormData) for (const t of form.getAll('thumbs')) if (t && typeof t === 'object' && t.name) m.set(t.name, t);
  return m;
}

export async function readBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { return await request.json(); } catch { throw new HttpError(400, 'bad_json'); } }
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) return await request.formData();
  return {};
}
export const field = (body, k) => (body instanceof FormData ? body.get(k) : body?.[k]);

// ---------- file contents: R2 when bound, otherwise chunked into D1 (free plan) ----------
const CHUNK = 1500 * 1024;
async function chunkStatements(env, fileId, f) {
  const buf = new Uint8Array(await f.arrayBuffer()), out = [];
  for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++) {
    const part = buf.subarray(i, i + CHUNK);
    out.push({ size: part.length, stmt: env.DB.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(fileId, n, part) });
  }
  return out;
}
export async function removeBlobs(env, keys) {
  const d1 = keys.filter(k => k.startsWith('d1:')).map(k => env.DB.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(k.slice(3)));
  try { if (d1.length) await env.DB.batch(d1); } catch {}
  if (env.FILES) for (const k of keys.filter(k => !k.startsWith('d1:'))) { try { await env.FILES.delete(k); } catch {} }
}
// Returns a ReadableStream of the file, or null if it is missing. Chunks are read one at a time as the browser downloads.
export async function readFile(env, key) {
  if (!key.startsWith('d1:')) { const obj = env.FILES ? await env.FILES.get(key) : null; return obj ? obj.body : null; }
  const id = key.slice(3);
  const first = await env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? AND idx = 0').bind(id).first();
  if (!first) return null;
  let idx = 1, sent = false;
  return new ReadableStream({
    async pull(ctrl) {
      if (!sent) { sent = true; return ctrl.enqueue(new Uint8Array(first.data)); }
      const row = await env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?').bind(id, idx++).first();
      if (!row) return ctrl.close();
      ctrl.enqueue(new Uint8Array(row.data));
    },
  });
}
