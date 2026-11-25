// End to end test of the team dashboard and client portal in a real browser.
// Needs `npm run dev` running on a FRESH local DB (npm run db:reset). Screenshots go to tests/shots/.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8788';
const KEY = process.env.BOOTSTRAP_KEY || 'local-bootstrap-key';
const SHOTS = new URL('./shots/', import.meta.url).pathname; fs.mkdirSync(SHOTS, { recursive: true });
const SAMPLE = new URL('../public/assets/img/work/03-photo.webp', import.meta.url).pathname;
const RENDER = new URL('../public/assets/img/work/03-a.webp', import.meta.url).pathname;
const RENDER2 = new URL('../public/assets/img/work/03-b.webp', import.meta.url).pathname;

let passed = 0, failed = 0; const out = [];
const check = (n, c, x) => { if (c) { passed++; out.push('  ok   ' + n); } else { failed++; out.push('  FAIL ' + n + (x !== undefined ? '  ->  ' + String(x).slice(0, 300) : '')); } };

const problems = [];
function watch(page, label) {
  page.on('pageerror', e => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) problems.push(`${label} console: ${m.text()}`); });
  page.on('response', r => { const u = r.url(); if (r.status() >= 400 && !(r.status() === 401 && /\/api\/auth\/(me|login)$/.test(u)) && !u.includes('fonts.g') && !(label === 'olivia' && r.status() === 404 && u.includes('/api/client/orders/'))) problems.push(`${label} ${r.status()} ${u}`); });
}
async function audit(page, name) {
  const r = await page.evaluate(() => {
    const t = document.body.innerText;
    return { over: document.documentElement.scrollWidth - window.innerWidth, dash: (t.match(/.{0,30}(\s[-–—]\s|[–—]).{0,30}/) || [''])[0] };
  });
  check(`${name}: no horizontal overflow`, r.over <= 1, r.over);
  check(`${name}: no dashes in visible text`, !r.dash, r.dash);
}
// click the real "Send preview" / "Deliver final files" button and answer the file chooser
async function sendFiles(page, kind, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(`.drawer [data-up=${kind}]`)]);
  await chooser.setFiles(files);
}
const shot = (page, n) => page.screenshot({ path: SHOTS + n + '.png', fullPage: false });

async function api(path, body) {
  const r = await fetch(BASE + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cubix': '1' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}

const browser = await chromium.launch();
try {
  const b = await api('/auth/bootstrap', { key: KEY, name: 'Rizwan Khan', email: 'admin@cubix.test', password: 'adminpass123' });
  check('bootstrap admin', b.status === 201, JSON.stringify(b.data));
  if (b.status !== 201) throw new Error('Reset the DB first: npm run db:reset');

  // seed a few website orders so the dashboard has real volume
  for (const [name, shop, product, title] of [['Olivia', 'Cozy Home Minis', 'House replica', ''], ['Liam', 'Pawprint Studio', 'Pet figurine', ''], ['Ava', 'Signcraft Co', 'Sign or logo', '']]) {
    const f = new FormData(); f.append('name', name); f.append('email', `${name.toLowerCase()}@shop.test`); f.append('shop', shop); f.append('product', product);
    f.append('files', new Blob([fs.readFileSync(SAMPLE)], { type: 'image/webp' }), 'photo.webp');
    const r = await fetch(BASE + '/api/order', { method: 'POST', body: f });
    check(`website order from ${shop}`, r.status === 201);
  }

  // ---------------------------------------------------------------- team: login + overview (desktop)
  const tctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const team = await tctx.newPage(); watch(team, 'team'); globalThis.__last = team;
  await team.goto(BASE + '/team/');
  await team.waitForSelector('h1:text("Sign in")');
  await shot(team, '01-team-login'); await audit(team, 'team login');
  await team.fill('input[name=email]', 'admin@cubix.test'); await team.fill('input[name=password]', 'wrongpass1'); await team.click('button[type=submit]');
  await team.waitForSelector('.form-msg.err');
  check('wrong password shows an error', (await team.textContent('.form-msg')).includes('not correct'));
  await team.fill('input[name=password]', 'adminpass123'); await team.click('button[type=submit]');
  await team.waitForSelector('.kpis');
  check('overview loads after login', await team.isVisible('text=Needs attention'));
  check('overview shows 3 unassigned', (await team.textContent('a.kpi:has-text("Unassigned") .k-val')).trim() === '3');
  await shot(team, '02-team-overview'); await audit(team, 'team overview');

  // add a modeler through the UI
  await team.click('.nav a[data-v="team"]'); await team.waitForSelector('#addM');
  await team.click('#addM'); await team.fill('.modal input[name=name]', 'Ali Raza'); await team.fill('.modal input[name=email]', 'ali@cubix.test');
  await team.click('.modal button[type=submit]'); await team.waitForSelector('.modal .copybox');
  const modLink = (await team.textContent('.modal .copybox span')).trim();
  check('invite link shown for new modeler', /\/team\/#\/setup\/[a-f0-9]{64}$/.test(modLink), modLink);
  await shot(team, '03-team-invite'); await team.click('.modal [data-close]');
  await team.waitForSelector('td:has-text("Ali Raza")');
  check('new member listed with pending invite', await team.isVisible('text=Invite pending'));
  await audit(team, 'team members');

  // ---------------------------------------------------------------- client: signup and order (desktop)
  const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const client = await cctx.newPage(); watch(client, 'client');
  await client.goto(BASE + '/app/');
  await client.waitForSelector('h1:text("Welcome back")'); await shot(client, '04-client-login'); await audit(client, 'client login');
  await client.click('[data-go=signup]');
  await client.fill('input[name=name]', 'Emma Wilson'); await client.fill('input[name=email]', 'emma@minis.test'); await client.fill('input[name=shop]', 'Emma Minis');
  await client.fill('input[name=url]', 'etsy.com/shop/EmmaMinis'); await client.fill('input[name=password]', 'emmapass123');
  await client.click('button[type=submit]');
  await client.waitForSelector('h1:text("New order")');
  check('signup lands on new order with free offer', (await client.textContent('button[type=submit]')).includes('free'));
  await client.fill('input[name=title]', 'Blue farmhouse with porch');
  await client.click('label:has-text("House replica")'); await client.fill('input[name=size]', '15 cm'); await client.fill('input[name=printer]', 'Bambu Lab X1C');
  await client.fill('textarea[name=notes]', 'Keep the white fence and the red door.');
  await client.click('button[type=submit]');
  await client.waitForSelector('.form-msg.err'); check('order needs a file', (await client.textContent('.form-msg')).includes('photo'));
  await client.setInputFiles('#dz input[type=file]', [SAMPLE]);
  await client.waitForSelector('.filelist img'); await shot(client, '05-client-new-order'); await audit(client, 'client new order');
  await client.click('button[type=submit]');
  await client.waitForSelector('.steps');
  check('order created and detail opens', (await client.textContent('h1')).includes('Blue farmhouse'));
  check('order is marked free', await client.isVisible('.tag-free'));
  const orderUrl = client.url(); const orderId = orderUrl.split('/').pop();
  await client.fill('#compose textarea', 'Can you add a small chimney too?'); await client.click('#compose button[type=submit]');
  await client.waitForSelector('.msg.mine:has-text("chimney")');
  await shot(client, '06-client-order-received'); await audit(client, 'client order detail');
  await client.click('a.back'); await client.waitForSelector('.oitem');
  check('order list shows the order', (await client.textContent('.oitem .ttl')).includes('Blue farmhouse'));
  check('free banner gone after first order', !(await client.isVisible('text=Your first model is free.')));
  await shot(client, '07-client-orders'); await audit(client, 'client orders');

  // ---------------------------------------------------------------- team: board, drawer, claim, preview
  await team.click('.nav a[data-v="board"]'); await team.waitForSelector('.board');
  check('board shows 4 new orders', (await team.$$('.col[data-status=new] .ocard')).length === 4);
  check('rush or free tags render on board', (await team.$$('.ocard .tag-free')).length === 4);
  await shot(team, '08-team-board'); await audit(team, 'team board');
  // drag a seeded order to Confirmed
  const seeded = team.locator('.col[data-status=new] .ocard').filter({ hasText: 'Pawprint' });
  await seeded.dragTo(team.locator('.col[data-status=confirmed]'));
  await team.waitForSelector('.col[data-status=confirmed] .ocard:has-text("Pawprint")');
  check('drag and drop moves an order', true);

  await team.click(`.ocard[data-id="${orderId}"]`);
  await team.waitForSelector('.drawer h2:text("Blue farmhouse with porch")');
  check('drawer shows client message', await team.isVisible('.drawer .msg:has-text("chimney")'));
  check('admin sees price fields', await team.isVisible('.drawer [data-set=price]'));
  await shot(team, '09-team-drawer'); await audit(team, 'team drawer');
  await team.click('.drawer [data-act=claim]'); await team.waitForSelector('.drawer .pill.st-confirmed');
  check('claim assigns to me and confirms', (await team.inputValue('.drawer [data-set=assignee_id]')).length > 0);
  await team.click('.drawer [data-act=modeling]'); await team.waitForSelector('.drawer .pill.st-modeling');
  await team.fill('.drawer #compose textarea', 'Check the chimney side with the client photo'); await team.check('.drawer #compose input[name=internal]');
  await team.click('.drawer #compose button[type=submit]'); await team.waitForSelector('.drawer .msg.internal');
  await team.fill('.drawer #compose textarea', 'Sure, adding the chimney. Preview soon.'); await team.click('.drawer #compose button[type=submit]');
  await team.waitForSelector('.drawer .msg:has-text("Preview soon")');
  await sendFiles(team, 'preview', [RENDER, RENDER2]);
  await team.waitForSelector('.drawer .pill.st-preview');
  check('preview upload moves to Preview sent', true);
  check('preview files listed', (await team.$$('.drawer .fgroup:has(h4:has-text("Previews")) .file')).length === 2);
  await team.keyboard.press('Escape'); await team.waitForSelector('.drawer', { state: 'detached' });
  check('Escape closes the drawer', true);

  // ---------------------------------------------------------------- client: review, revise, approve
  await client.goto(orderUrl); await client.waitForSelector('.actionbox');
  check('client sees preview action', await client.isVisible('text=Your preview is ready'));
  check('client does not see the internal note', !(await client.isVisible('text=Check the chimney side')));
  check('client sees the team reply', await client.isVisible('text=Preview soon'));
  check('preview gallery shows 2 images', (await client.$$('.gallery img')).length === 2);
  await shot(client, '10-client-preview'); await audit(client, 'client preview');
  await client.click('#changes'); await client.fill('.modal textarea', 'Make the roof a bit darker please.'); await client.click('.modal button[type=submit]');
  await client.waitForSelector('text=We are making your changes');
  check('revision request accepted', true);
  // team sends v2
  await team.goto(BASE + '/team/#/board?o=' + orderId); await team.waitForSelector('.drawer .pill.st-revisions');
  await sendFiles(team, 'preview', [RENDER]);
  await team.waitForSelector('.drawer .pill.st-preview');
  check('second preview is version 2', await team.isVisible('.drawer >> text=Version 2 (latest)'));
  await client.reload(); await client.waitForSelector('#approve');
  check('client sees preview version 2', await client.isVisible('text=Preview, version 2'));
  await client.click('#approve'); await client.click('.modal [data-ok]');
  await client.waitForSelector('text=Approved. Preparing your files.');
  check('client approves', true);

  // ---------------------------------------------------------------- team: deliver, price, paid
  await team.reload(); await team.waitForSelector('.drawer .pill.st-approved');
  await team.fill('.drawer [data-set=price]', '0'); await team.press('.drawer [data-set=price]', 'Tab');
  await team.waitForSelector('.toast:has-text("Saved")');
  await sendFiles(team, 'final', [new URL('../public/assets/models/' + (fs.readdirSync(new URL('../public/assets/models/', import.meta.url)).find(f => f.endsWith('.glb')) || 'x.glb'), import.meta.url).pathname]);
  await team.waitForSelector('.drawer .pill.st-delivered');
  check('final upload delivers', true);
  await team.click('.drawer [data-act=paid]'); await team.waitForSelector('.drawer .pill.st-paid');
  check('admin marks paid, order closes', true);
  await team.selectOption('.drawer [data-set=paid_via]', 'Free first model'); await team.waitForSelector('.toast:has-text("Saved")');
  check('history shows the full timeline', (await team.$$('.drawer .timeline li')).length >= 8);
  await shot(team, '11-team-drawer-closed');
  await team.keyboard.press('Escape');

  await client.reload(); await client.waitForSelector('text=Your files are ready');
  const dl = await client.$('.actionbox a.btn-ok');
  check('client gets a download button', !!dl);
  const [download] = await Promise.all([client.waitForEvent('download'), dl.click()]);
  check('download works', (await download.path()) && fs.statSync(await download.path()).size > 1000);
  check('payment shows free', await client.isVisible('text=Your first model is on us.'));
  await shot(client, '12-client-files-ready'); await audit(client, 'client files ready');

  // ---------------------------------------------------------------- orders list, shops, filters
  await team.click('.nav a[data-v="orders"]'); await team.waitForSelector('table.t');
  check('orders table lists 4 orders', (await team.$$('table.t tbody tr')).length === 4);
  await team.fill('#q', 'Signcraft'); await team.waitForFunction(() => document.querySelectorAll('table.t tbody tr').length === 1);
  check('search filters orders', true);
  await shot(team, '13-team-orders'); await audit(team, 'team orders');
  await team.click('.nav a[data-v="shops"]'); await team.waitForSelector('tr[data-s]');
  check('shops lists 4 shops', (await team.$$('tr[data-s]')).length === 4);
  await team.click('tr[data-s]:has-text("Cozy Home Minis")'); await team.waitForSelector('.modal [data-link]');
  await team.click('.modal [data-link]'); await team.waitForSelector('.modal .copybox');
  const shopLink = (await team.textContent('.modal .copybox span')).trim();
  check('admin creates a client login link', shopLink.includes('/app/#/setup/'), shopLink);
  await team.click('.modal [data-close]');
  await shot(team, '14-team-shops'); await audit(team, 'team shops');
  // invite a brand new shop from the dashboard
  await team.click('#inviteShop'); await team.fill('.modal input[name=name]', 'Linden Prints'); await team.fill('.modal input[name=contact]', 'Mia');
  await team.fill('.modal input[name=email]', 'mia@linden.test'); await team.selectOption('.modal select[name=plan]', 'starter');
  await team.click('.modal button[type=submit]'); await team.waitForSelector('.modal h2:text("Invite ready")');
  const invLink = (await team.textContent('.modal .copybox span')).trim();
  check('invite a shop shows a portal link and a ready message', invLink.includes('/app/#/setup/') && (await team.inputValue('.modal textarea')).includes('Hi Mia'), invLink);
  await shot(team, '15-team-invite-shop'); await audit(team, 'team invite shop');
  await team.click('.modal [data-close]'); await team.waitForSelector('tr[data-s]:has-text("Linden Prints")');
  check('invited shop appears in the list', true);
  { const ictx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const ip = await ictx.newPage(); watch(ip, 'invited');
    await ip.goto(invLink); await ip.fill('input[name=password]', 'lindenpass1'); await ip.fill('input[name=confirm]', 'lindenpass1'); await ip.click('button[type=submit]');
    await ip.waitForSelector('text=Your first model is free.');
    check('invited owner lands in the portal with the free model offer', (await ip.textContent('h1')).includes('My orders'));
    await ictx.close(); }

  // shop owner from the website form activates their login
  const octx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const olivia = await octx.newPage(); watch(olivia, 'olivia');
  await olivia.goto(shopLink); await olivia.waitForSelector('h1:text("Set your password")');
  await olivia.fill('input[name=password]', 'oliviapass1'); await olivia.fill('input[name=confirm]', 'oliviapass2'); await olivia.click('button[type=submit]');
  await olivia.waitForSelector('.form-msg.err'); check('password mismatch is caught', (await olivia.textContent('.form-msg')).includes('match'));
  await olivia.fill('input[name=confirm]', 'oliviapass1'); await olivia.click('button[type=submit]');
  await olivia.waitForSelector('.oitem'); check('website customer sees their order after setting a password', (await olivia.$$('.oitem')).length === 1);
  check('website customer cannot see Emma order', !(await olivia.isVisible('text=Blue farmhouse')));
  await olivia.goto(orderUrl.replace(/#.*/, '#/orders/' + orderId)); await olivia.waitForSelector('text=We could not find that order');
  check('direct link to another shop order is refused', true);

  // ---------------------------------------------------------------- modeler view
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const mod = await mctx.newPage(); watch(mod, 'modeler');
  await mod.goto(modLink); await mod.fill('input[name=password]', 'alipass1234'); await mod.fill('input[name=confirm]', 'alipass1234'); await mod.click('button[type=submit]');
  await mod.waitForSelector('.kpis'); check('modeler lands on overview', true);
  await mod.goto(BASE + '/team/#/board'); await mod.waitForSelector('.ocard');
  await mod.click('.ocard:has-text("Signcraft")'); await mod.waitForSelector('.drawer [data-act=claim]');
  check('modeler does not see price fields', !(await mod.isVisible('.drawer [data-set=price]')));
  check('modeler can only assign self', (await mod.$$('.drawer [data-set=assignee_id] option')).length === 2);
  await mod.click('.drawer [data-act=claim]'); await mod.waitForSelector('.drawer .pill.st-confirmed');
  check('modeler claims an order', true);
  await mod.keyboard.press('Escape');
  await mod.goto(BASE + '/team/#/team'); await mod.waitForSelector('table.t');
  check('modeler cannot add members', !(await mod.isVisible('#addM')));
  check('client cannot open the team app', await (async () => { const p = await cctx.newPage(); await p.goto(BASE + '/team/'); await p.waitForURL(/\/app\//); const ok = p.url().includes('/app/'); await p.close(); return ok; })());

  // ---------------------------------------------------------------- phone widths
  for (const [label, ctx0] of [['team', tctx], ['client', cctx]]) {
    const st = await ctx0.storageState();
    const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: st });
    const p = await ph.newPage(); watch(p, label + '-phone');
    if (label === 'team') {
      for (const [h, n] of [['#/', 'overview'], ['#/board', 'board'], ['#/orders', 'orders'], ['#/shops', 'shops'], ['#/team', 'members']]) {
        await p.goto(BASE + '/team/' + h); await p.waitForSelector('.main h1'); await p.waitForTimeout(150);
        await p.screenshot({ path: SHOTS + `p-team-${n}.png` }); await audit(p, `phone team ${n}`);
      }
      check('phone tab bar visible', await p.isVisible('.tabbar'));
      await p.goto(BASE + '/team/#/orders?o=' + orderId); await p.waitForSelector('.drawer h2'); await p.waitForTimeout(300);
      await p.screenshot({ path: SHOTS + 'p-team-drawer.png' }); await audit(p, 'phone team drawer');
    } else {
      await p.goto(BASE + '/app/'); await p.waitForSelector('.oitem'); await p.screenshot({ path: SHOTS + 'p-client-orders.png' }); await audit(p, 'phone client orders');
      await p.goto(orderUrl); await p.waitForSelector('.steps'); await p.screenshot({ path: SHOTS + 'p-client-order.png', fullPage: true }); await audit(p, 'phone client order');
      await p.goto(BASE + '/app/#/new'); await p.waitForSelector('#nf'); await p.screenshot({ path: SHOTS + 'p-client-new.png', fullPage: true }); await audit(p, 'phone client new');
    }
    await ph.close();
  }
  const lp = await browser.newPage({ viewport: { width: 390, height: 844 } }); watch(lp, 'phone-login');
  await lp.goto(BASE + '/app/'); await lp.waitForSelector('h1'); await audit(lp, 'phone client login'); await lp.screenshot({ path: SHOTS + 'p-client-login.png' });

  // ---------------------------------------------------------------- logout
  await client.click('#mBtn'); await client.click('#logout'); await client.waitForSelector('h1:text("Welcome back")');
  check('client logout returns to sign in', true);
  await client.goto(BASE + '/app/#/orders/' + orderId); await client.waitForSelector('h1:text("Welcome back")');
  check('after logout, order page asks to sign in', true);

  // ---------------------------------------------------------------- website order form still works
  const site = await browser.newPage({ viewport: { width: 1440, height: 900 } }); watch(site, 'site');
  await site.goto(BASE + '/start.html');
  await site.fill('#f-name', 'Mia'); await site.fill('#f-email', 'mia@shop.test'); await site.fill('#f-shop', 'etsy.com/shop/MiaMakes');
  await site.setInputFiles('#f-files', [SAMPLE]);
  await site.click('#orderBtn'); await site.waitForFunction(() => /CX[A-Z0-9]{6}/.test(document.querySelector('#formMsg')?.textContent || document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  const siteText = await site.textContent('body');
  check('website order form creates an order', /CX[A-Z0-9]{6}/.test(siteText), (await site.textContent('#formMsg').catch(() => '')));
  check('website header has client login', await site.isVisible('a.hdr-login'));
} catch (e) {
  failed++; out.push('  FAIL exception: ' + e.message.split('\n').slice(0, 3).join(' / '));
  if (globalThis.__last) await globalThis.__last.screenshot({ path: SHOTS + 'fail.png' }).catch(() => {});
} finally {
  await browser.close();
}
const unique = [...new Set(problems)];
check('no page errors, console errors or failed requests', unique.length === 0, unique.join(' | '));
console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
