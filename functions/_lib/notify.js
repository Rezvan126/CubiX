// Emails (Resend) and team alerts (Slack, Discord, Google Chat webhooks).
// Nothing here ever blocks or breaks a request: failures are logged and ignored.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Settings that control notifications live in the settings table, so admins can change them in the dashboard.
export async function notifySettings(env) {
  if (env.__notify) return env.__notify;
  let rows = [];
  try { rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('alert_webhook','alert_email','mail_from','biz_name')").all()).results; } catch {}
  const s = Object.fromEntries(rows.map(r => [r.key, r.value || '']));
  env.__notify = {
    webhook: s.alert_webhook || env.ORDER_WEBHOOK || '',
    alertEmail: s.alert_email || env.ALERT_EMAIL || '',
    from: env.MAIL_FROM || s.mail_from || '',
    brand: s.biz_name || 'CubiX',
  };
  return env.__notify;
}
export const emailReady = async env => !!(env.RESEND_API_KEY && (await notifySettings(env)).from);

// Run work after the response is sent, so emails never slow down a click.
export function later(env, promise) {
  const p = Promise.resolve(promise).catch(e => console.error('notify', e && e.message));
  if (env.__waitUntil) env.__waitUntil(p); else return p;
}

// Branded HTML email: logo, heading, short text, one clear button, optional detail lines.
export function emailHtml(site, { heading, intro, button, lines = [], outro }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f2f8;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#2f2d52">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f2f8;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="height:5px;background:linear-gradient(90deg,#8b5cf6,#06b6d4);background-color:#7c3aed"></td></tr>
<tr><td style="padding:26px 30px 6px"><img src="${site}/android-chrome-192x192.png" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px"> <span style="font-size:20px;font-weight:700;color:#17153a;vertical-align:middle;margin-left:8px">CubiX</span></td></tr>
<tr><td style="padding:14px 30px 4px"><h1 style="margin:0;font-size:22px;line-height:1.25;color:#17153a">${esc(heading)}</h1></td></tr>
<tr><td style="padding:10px 30px 4px;font-size:15px;line-height:1.6">${intro}</td></tr>
${lines.length ? `<tr><td style="padding:12px 30px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6fb;border-radius:12px">${lines.map(([k, v]) => `<tr><td style="padding:9px 14px;font-size:13px;color:#6b6a85;width:38%">${esc(k)}</td><td style="padding:9px 14px;font-size:13px;color:#17153a;font-weight:600">${esc(v)}</td></tr>`).join('')}</table></td></tr>` : ''}
${button ? `<tr><td style="padding:22px 30px 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#17153a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:11px">${esc(button.label)}</a></td></tr>` : ''}
${outro ? `<tr><td style="padding:14px 30px 0;font-size:13px;line-height:1.6;color:#6b6a85">${outro}</td></tr>` : ''}
<tr><td style="padding:24px 30px 26px;font-size:12px;color:#9a99b2">CubiX, custom 3D modeling for print shops. Delivered in 24 to 48 hours, every day.<br><a href="${site}" style="color:#9a99b2">${esc(site.replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
}

// Send one email. Returns true when Resend accepted it.
export async function sendMail(env, to, subject, text, html) {
  const n = await notifySettings(env);
  if (!env.RESEND_API_KEY || !n.from || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: n.from, to: Array.isArray(to) ? to : [to], subject, text, ...(html ? { html } : {}) }),
    });
    if (!r.ok) console.error('resend', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error('resend', e && e.message); return false; }
}

// Alert the team: webhook message plus an email to the alert address (or every admin when none is set).
export async function alertTeam(env, site, { title, text, url }) {
  const n = await notifySettings(env);
  const jobs = [];
  if (n.webhook) {
    const msg = `*${title}*\n${text}${url ? `\n${url}` : ''}`;
    jobs.push(fetch(n.webhook, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg, content: msg.replace(/\*/g, '**') }) }).catch(e => console.error('webhook', e && e.message)));
  }
  if (env.RESEND_API_KEY && n.from) {
    let to = n.alertEmail ? n.alertEmail.split(/[,\s]+/).filter(Boolean) : [];
    if (!to.length) { try { to = (await env.DB.prepare("SELECT email FROM users WHERE role = 'admin' AND active = 1").all()).results.map(r => r.email); } catch {} }
    if (to.length) jobs.push(sendMail(env, to, `[CubiX] ${title}`, `${text}${url ? `\n\n${url}` : ''}`,
      emailHtml(site, { heading: title, intro: esc(text).replace(/\n/g, '<br>'), button: url ? { label: 'Open in dashboard', url } : null })));
  }
  await Promise.all(jobs);
  return jobs.length > 0;
}
