(() => {
  'use strict';
  const CONFIG = { email: 'rizwan@coraxys.com' };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const pad = n => String(n).padStart(2, '0');
  const IMG = 'assets/img/work/';
  const A = p => (window.__ASSETS && window.__ASSETS[p]) || p;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mail = (subject = 'CubiX enquiry', body = '') =>
    `mailto:${CONFIG.email}?subject=${encodeURIComponent(subject)}${body ? '&body=' + encodeURIComponent(body) : ''}`;

  /* ---------- email links, copy ---------- */
  $$('[data-mail]').forEach(a => { a.href = mail(a.dataset.mail || 'CubiX enquiry'); });
  $$('[data-mail-text]').forEach(a => { a.textContent = CONFIG.email; });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const old = b.textContent;
    try { await navigator.clipboard.writeText(CONFIG.email); b.textContent = 'Copied'; }
    catch {
      const t = b.parentElement.querySelector('[data-mail-text]');
      if (t) { const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      b.textContent = 'Selected';
    }
    setTimeout(() => { b.textContent = old; }, 1600);
  });
  $$('[data-year]').forEach(e => { e.textContent = new Date().getFullYear(); });

  /* ---------- header, drawer, mobile CTA ---------- */
  const hdr = $('#hdr'), mcta = $('#mcta');
  const onScroll = () => {
    hdr && hdr.classList.toggle('scrolled', scrollY > 10);
    mcta && mcta.classList.toggle('show', scrollY > 500);
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- modals (drawer, lightbox, popup) ---------- */
  let lastFocus = null;
  const openModal = m => { lastFocus = document.activeElement; m.hidden = false; document.body.style.overflow = 'hidden'; const f = $('[data-close]', m); f && f.focus(); };
  const closeModal = m => { m.hidden = true; if (!$$('.modal:not([hidden]),.drawer:not([hidden])').length) document.body.style.overflow = ''; lastFocus && lastFocus.focus && lastFocus.focus(); };
  $$('.modal,.drawer').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) closeModal(m); }));
  addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal:not([hidden]),.drawer:not([hidden])').forEach(closeModal); });
  const drawer = $('#drawer'), burger = $('#burger');
  burger && burger.addEventListener('click', () => { openModal(drawer); burger.setAttribute('aria-expanded', 'true'); });
  drawer && drawer.addEventListener('click', e => { if (e.target.closest('a')) closeModal(drawer); });

  /* ---------- Upwork / Fiverr popup ---------- */
  const pop = $('#pop');
  const POPS = {
    upwork: { logo: 'Upwork', t: 'Work with us on Upwork', p: 'Email us and we reply within minutes with the direct link to our Upwork profile. You hire us there and release the payment after approval.', s: 'Upwork profile link', b: 'Hi, please send me your Upwork profile link.\n\nMy shop: ' },
    fiverr: { logo: 'fiverr.', t: 'Work with us on Fiverr', p: 'Email us and we reply within minutes with the direct link to our Fiverr gig. You order there and accept the delivery once you are happy.', s: 'Fiverr gig link', b: 'Hi, please send me your Fiverr gig link.\n\nMy shop: ' },
  };
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-pop]'); if (!t || !pop) return;
    e.preventDefault();
    const c = POPS[t.dataset.pop];
    $('#popLogo').textContent = c.logo; $('#popTitle').textContent = c.t; $('#popText').textContent = c.p; $('#popMail').href = mail(c.s, c.b);
    openModal(pop);
  });

  /* ---------- compare sliders ---------- */
  function bindCompare(root) {
    const input = $('input', root);
    const set = v => root.style.setProperty('--x', v + '%');
    input.addEventListener('input', () => set(input.value));
    set(input.value);
    return { reset(v = 50) { input.value = v; set(v); } };
  }
  $$('[data-compare]').forEach(root => {
    if (root.id === 'lbCmp') return;
    bindCompare(root);
    if (root.hasAttribute('data-sweep') && !reduce) {
      const io = new IntersectionObserver(([en]) => {
        if (!en.isIntersecting) return; io.disconnect();
        const input = $('input', root), t0 = performance.now();
        const step = t => {
          const k = Math.min(1, (t - t0) / 2200);
          const v = 50 + Math.sin(k * Math.PI * 2) * 30 * (1 - k * .6) * (k < 1 ? 1 : 0);
          root.style.setProperty('--x', v + '%'); input.value = v;
          if (k < 1) requestAnimationFrame(step); else { root.style.setProperty('--x', '50%'); input.value = 50; }
        };
        setTimeout(() => requestAnimationFrame(step), 500);
      }, { threshold: .5 });
      io.observe(root);
    }
  });

  /* ---------- range fill ---------- */
  const fill = r => r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
  $$('input.rng').forEach(r => { fill(r); r.addEventListener('input', () => fill(r)); });

  /* ---------- portfolio data ---------- */
  // [id, has customer photo, title, detail, categories]
  const WORK = [
    [1, 1, 'Brick Georgian colonial', 'Dormers, quoins and a curved stone entry', 'home'],
    [2, 1, 'Colonial keepsake', 'Deck, ramp and porch at 127 mm', 'lantern home'],
    [3, 1, 'Stone French country lantern', 'LED lantern at 229 mm, cut through windows', 'lantern home'],
    [4, 1, 'Plantation home with double porch', 'LED lantern at 229 mm', 'lantern home landmark'],
    [5, 1, 'Modern two storey', 'Mixed cladding and glass garage doors', 'home'],
    [6, 1, 'Ivy covered brick colonial', 'Shutters, bay window and chimneys', 'home'],
    [7, 1, 'Gothic stone church', 'Patterned stonework and bell tower', 'landmark'],
    [8, 1, 'Ranch with attached garage', 'Single storey with front steps', 'home'],
    [9, 1, 'Lowcountry raised house', 'Full width porches and dormers', 'home'],
    [10, 1, 'Farmhouse with wraparound porch', 'Built from photos at several angles', 'home'],
    [11, 1, 'Lakeside contemporary', 'Decks and stairs on a sloped lot', 'home'],
    [12, 1, 'Gambrel roof family home', 'LED lantern at 127 mm', 'lantern home'],
    [13, 1, 'Georgian country estate', 'Large estate with chimney stacks', 'landmark'],
    [14, 1, 'Midcentury split level', 'Hollow print shell', 'home'],
    [15, 1, 'Three storey shingle home', 'Balconies and columned porch', 'home'],
    [16, 1, 'Coastal modern villa', 'Round window and pool terrace', 'home'],
    [17, 1, 'Shingle style estate', 'From architect drawings, 178 mm lantern', 'drawing lantern'],
    [18, 0, 'Montauk contemporary', 'From architect elevations', 'drawing home'],
    [19, 0, 'Large brick estate', 'LED lantern', 'lantern landmark'],
    [20, 0, 'Village house', 'LED lantern', 'lantern home'],
    [21, 0, 'Cottage with front porch', 'Classic gable and chimney', 'home'],
    [22, 0, 'Two storey family home', 'Porch and side deck', 'home'],
    [23, 0, 'Mediterranean villa', 'Tile roof and arched garage', 'home'],
    [24, 0, 'Italianate townhouse block', 'Commercial building', 'landmark'],
  ];
  const CAT = { home: 'Home', lantern: 'Lantern', landmark: 'Landmark', drawing: 'From drawings' };
  const touch = matchMedia('(hover: none)').matches;
  const card = w => {
    const [n, ph, t, d, c] = w;
    return `<button class="pcard${ph ? ' has-photo' : ''} rv" data-id="${n}" data-c="${c}" aria-label="${t}. Open project">
      <div class="pimg">
        <img class="md" src="${A(`${IMG}${pad(n)}-a.webp`)}" alt="${t}, 3D model" loading="lazy" decoding="async" width="1200" height="900">
        ${ph ? `<img class="ph" src="${A(`${IMG}${pad(n)}-photo.webp`)}" alt="" loading="lazy" decoding="async">` : ''}
        <span class="reg tl"></span><span class="reg br"></span>
        <span class="hint"><svg class="icon"><use href="#i-${ph ? 'eye' : 'cube'}"/></svg>${ph ? (touch ? 'Tap to compare' : 'Hover for the photo') : '4 views'}</span>
      </div>
      <div class="pbody"><div><h3>${t}</h3><p>${d}</p></div><span class="badge">${CAT[c.split(' ')[0]]}</span></div>
    </button>`;
  };

  let current = [];
  $$('[data-portfolio]').forEach(grid => {
    const ids = grid.dataset.ids ? grid.dataset.ids.split(',').map(Number) : null;
    const list = ids ? ids.map(i => WORK[i - 1]) : WORK;
    grid.innerHTML = list.map(card).join('');
    grid.addEventListener('click', e => {
      const b = e.target.closest('.pcard'); if (!b) return;
      current = $$('.pcard', grid).filter(x => !x.hidden).map(x => +x.dataset.id);
      openProject(+b.dataset.id);
    });
    if (grid.hasAttribute('data-filterable')) {
      const btns = $$('.filters button');
      const count = f => WORK.filter(w => f === 'all' || w[4].split(' ').includes(f)).length;
      btns.forEach(b => { const n = $('[data-n]', b); if (n) n.textContent = count(b.dataset.f); });
      const apply = f => {
        btns.forEach(x => x.classList.toggle('on', x.dataset.f === f));
        $$('.pcard', grid).forEach(c => { c.hidden = !(f === 'all' || c.dataset.c.split(' ').includes(f)); });
      };
      btns.forEach(b => b.addEventListener('click', () => apply(b.dataset.f)));
      if (location.hash === '#lanterns') { apply('lantern'); $('#all') && $('#all').scrollIntoView(); }
    }
  });

  /* ---------- lightbox ---------- */
  const lb = $('#lb');
  let lbCtl = null, lbId = 0;
  function openProject(id) {
    if (!lb) return;
    lbCtl = lbCtl || bindCompare($('#lbCmp'));
    lbId = id;
    const [n, ph, t, d, c] = WORK[id - 1];
    const views = ['a', 'b', 'c', 'd'].map(s => A(`${IMG}${pad(n)}-${s}.webp`));
    const photo = ph ? A(`${IMG}${pad(n)}-photo.webp`) : null;
    const items = (ph ? [{ cmp: true }] : []).concat(views.map(src => ({ src })));
    const th = $('#lbThumbs');
    th.innerHTML = items.map((it, k) => it.cmp
      ? `<button class="split" data-k="${k}" aria-label="Photo and model"><img src="${views[0]}" alt=""><img src="${photo}" alt=""></button>`
      : `<button data-k="${k}" aria-label="Model view ${k}"><img src="${it.src}" alt=""></button>`).join('');
    const cmp = $('#lbCmp'), view = $('.lb-view', lb);
    const show = k => {
      $$('button', th).forEach(b => b.classList.toggle('on', +b.dataset.k === k));
      const it = items[k];
      if (it.cmp) { $('.c-model', cmp).src = views[0]; $('.c-photo', cmp).src = photo; lbCtl.reset(); cmp.hidden = false; view.hidden = true; }
      else { view.src = it.src; view.alt = t; cmp.hidden = true; view.hidden = false; }
    };
    th.onclick = e => { const b = e.target.closest('button'); b && show(+b.dataset.k); };
    $('#lbTitle').textContent = t; $('#lbSub').textContent = d; $('#lbCat').textContent = CAT[c.split(' ')[0]];
    show(0);
    if (lb.hidden) openModal(lb);
  }
  const step = dir => { if (!current.length) return; const i = current.indexOf(lbId); openProject(current[(i + dir + current.length) % current.length]); };
  $('#lbPrev') && $('#lbPrev').addEventListener('click', () => step(-1));
  $('#lbNext') && $('#lbNext').addEventListener('click', () => step(1));
  addEventListener('keydown', e => { if (lb && !lb.hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.type !== 'range') step(e.key === 'ArrowRight' ? 1 : -1); });

  /* ---------- savings calculator ---------- */
  const calc = $('[data-calc]');
  if (calc) {
    const o = $('#c-orders'), h = $('#c-hours'), r = $('#c-rate');
    const money = v => '$' + Math.round(v).toLocaleString('en-US');
    const run = () => {
      const orders = +o.value, hours = +h.value, rate = +r.value, saved = orders * hours;
      $('#o-orders').textContent = orders; $('#o-hours').textContent = hours + ' h'; $('#o-rate').textContent = '$' + rate;
      $('#r-hours').textContent = saved.toLocaleString('en-US');
      $('#r-value').textContent = money(saved * rate);
      $('#r-extra').textContent = Math.floor(saved / 2).toLocaleString('en-US');
      $('#r-cost').textContent = `${money(orders * 50)} to ${money(orders * 150)}`;
    };
    [o, h, r].forEach(x => x.addEventListener('input', run)); run();
  }

  /* ---------- price estimator ---------- */
  const est = $('[data-estimator]');
  if (est) {
    const run = () => {
      const v = n => +((est.querySelector(`input[name=${n}]:checked`) || {}).value || 0);
      const extras = $$('input[name=extra]:checked', est).reduce((s, x) => s + +x.value, 0);
      let base = v('detail') + v('size') + v('method') + extras;
      base = Math.max(50, Math.min(150, base));
      const lo = Math.max(50, Math.floor(base / 5) * 5), hi = Math.min(150, lo + 10);
      $('#estOut').textContent = lo >= 150 ? '$150 and up' : `$${lo} to $${hi}`;
      const p = x => ((x - 50) / 100 * 100) + '%';
      const bar = $('#estBar'); bar.style.left = p(lo); bar.style.right = `calc(100% - ${p(hi)})`;
    };
    est.addEventListener('change', run); run();
  }

  /* ---------- portal tabs ---------- */
  const portal = $('[data-portal]');
  if (portal) {
    const tabs = $$('.ptab', portal), img = $('#portalImg');
    const ALT = { s1: 'CubiX client portal, orders overview', s2: 'CubiX client portal, review and discussion', s3: 'CubiX client portal, new order upload' };
    ['s1', 's2'].forEach(k => { const i = new Image(); i.src = A(`assets/img/portal-${k}.webp`); });
    let idx = 0, timer = null, auto = !reduce;
    const show = i => {
      idx = i;
      tabs.forEach((t, k) => { t.classList.toggle('on', k === i); t.setAttribute('aria-selected', String(k === i)); const b = $('.bar i', t); if (b) { b.style.animation = 'none'; b.offsetWidth; b.style.animation = ''; } });
      img.style.opacity = .35;
      setTimeout(() => { img.src = A(`assets/img/portal-${tabs[i].dataset.s}.webp`); img.alt = ALT[tabs[i].dataset.s]; img.style.opacity = 1; }, 160);
      clearTimeout(timer);
      if (auto) timer = setTimeout(() => show((idx + 1) % tabs.length), 6000);
    };
    tabs.forEach((t, i) => t.addEventListener('click', () => { auto = false; $$('.bar', portal).forEach(b => b.style.visibility = 'hidden'); show(i); }));
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && auto) { show(idx); io.disconnect(); } }, { threshold: .4 });
    io.observe(portal);
  }

  /* ---------- FAQ search and topics ---------- */
  const faq = $('#faqList');
  if (faq) {
    const items = $$('details', faq), nav = $$('#faqNav button'), q = $('#faqSearch'), empty = $('#faqEmpty');
    let topic = 'all';
    nav.forEach(b => { $('.n', b).textContent = items.filter(d => b.dataset.t === 'all' || d.dataset.t === b.dataset.t).length; });
    const run = () => {
      const term = q.value.trim().toLowerCase(); let shown = 0;
      items.forEach(d => {
        const ok = (topic === 'all' || d.dataset.t === topic) && (!term || d.textContent.toLowerCase().includes(term));
        d.hidden = !ok; if (ok) shown++;
        if (term && ok) d.open = true;
      });
      empty.hidden = shown > 0;
    };
    nav.forEach(b => b.addEventListener('click', () => { topic = b.dataset.t; nav.forEach(x => x.classList.toggle('on', x === b)); run(); }));
    q.addEventListener('input', run);
  }

  /* ---------- order form ---------- */
  const form = $('#orderForm');
  if (form) {
    const MAX_FILES = 20, MAX_FILE = 25 * 1024 * 1024;
    const drop = $('#drop'), input = $('#f-files'), list = $('#fileList'), msg = $('#formMsg'), btn = $('#orderBtn');
    let files = [];
    const say = (html, cls = '') => { msg.className = 'form-msg ' + cls; msg.innerHTML = html; };
    const render = () => {
      list.innerHTML = '';
      files.forEach((f, i) => {
        const li = document.createElement('li');
        const isImg = /^image\/(jpeg|png|webp|gif|avif)$/.test(f.type);
        li.innerHTML = (isImg ? '<img alt="">' : `<span class="ext">${(f.name.split('.').pop() || '').toUpperCase()}</span>`) + '<span class="nm"></span><button type="button" aria-label="Remove file">×</button>';
        $('.nm', li).textContent = f.name;
        if (isImg) { const u = URL.createObjectURL(f); const im = $('img', li); im.src = u; im.onload = () => URL.revokeObjectURL(u); }
        $('button', li).onclick = () => { files.splice(i, 1); render(); };
        list.appendChild(li);
      });
      if (files.length) drop.classList.remove('invalid');
    };
    const add = fl => {
      for (const f of fl) {
        if (files.length >= MAX_FILES) { say('Up to 20 files. Email the rest to us.', 'err'); break; }
        if (f.size > MAX_FILE) { say(`${f.name} is over 25 MB. Email it to us or share a download link.`, 'err'); continue; }
        if (!files.some(x => x.name === f.name && x.size === f.size)) files.push(f);
      }
      render();
    };
    input.addEventListener('change', () => { add(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => add(e.dataTransfer.files));

    const summary = () => {
      const fd = new FormData(form);
      return [`Name: ${fd.get('name')}`, `Shop: ${fd.get('shop') || ''}`, `Size: ${fd.get('size') || ''}`, `Printer: ${fd.get('printer') || ''}`,
        `Product: ${fd.get('product')}`, `Files needed: ${fd.getAll('formats').join(', ')}`, `Work via: ${fd.get('channel')}`, '', `${fd.get('notes') || ''}`,
        '', `Photos: ${files.map(f => f.name).join(', ') || 'attached'}`].join('\n');
    };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      let ok = true;
      $$('[required]', form).forEach(f => { const bad = !f.value.trim() || (f.type === 'email' && !/^\S+@\S+\.\S+$/.test(f.value.trim())); f.classList.toggle('invalid', bad); if (bad) ok = false; });
      if (!ok) return say('Please add your name and a valid email address.', 'err');
      if (!files.length) { drop.classList.add('invalid'); return say('Please add at least one photo or file.', 'err'); }

      const fd = new FormData(form); fd.delete('files'); fd.set('formats', fd.getAll('formats').join(', '));
      fd.set('notes', `Product: ${fd.get('product')}\n${fd.get('notes') || ''}`);
      files.forEach(f => fd.append('files', f, f.name));
      btn.disabled = true; btn.firstChild.textContent = 'Sending ';
      await addThumbs(fd, files);
      const fallback = () => {
        const href = mail(`Free model order from ${new FormData(form).get('name')}`, summary());
        say(`Your email app should open with the order details. Please attach the photos there and press send. If it does not open, email <a href="${href}">${CONFIG.email}</a>.`, 'ok');
        location.href = href;
      };
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/order');
      xhr.upload.onprogress = ev => { if (ev.lengthComputable) btn.firstChild.textContent = `Uploading ${Math.round(ev.loaded / ev.total * 100)}% `; };
      xhr.onload = () => {
        let res = {}; try { res = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 300 && res.ok) { form.reset(); files = []; render(); say(`Received. Your order number is <b>${res.id}</b>. We confirm by email within minutes and send a preview within 24 hours.`, 'ok'); }
        else if (xhr.status >= 400 && xhr.status < 500 && res.message) say(res.message, 'err');
        else fallback();
        done();
      };
      xhr.onerror = () => { fallback(); done(); };
      xhr.send(fd);
      function done() { btn.disabled = false; btn.firstChild.textContent = 'Send my free order '; }
    });
    // small webp previews uploaded next to each photo, so the team dashboard loads fast
    async function addThumbs(fd, list) {
      for (const f of list) {
        if (!/^image\/(jpeg|png|webp|gif|bmp)/.test(f.type)) continue;
        try {
          const bmp = await createImageBitmap(f), k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
          if (blob && blob.size < 300 * 1024) fd.append('thumbs', blob, f.name);
        } catch {}
      }
    }
  }

  /* reveal on scroll */
  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => es.forEach(en => {
      if (en.isIntersecting) { en.target.classList.toggle('pre', false); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -6% 0px' });
    $$('.rv').forEach((el, i) => {
      if (el.getBoundingClientRect().top > innerHeight) { el.classList.add('pre'); el.style.transitionDelay = (i % 4) * 60 + 'ms'; io.observe(el); }
    });
  }

  /* fallback for the 3D viewer when it cannot run */
  window.viewerFallback = () => {
    const v = $('#viewer'); if (!v || v.dataset.fb) return; v.dataset.fb = '1';
    v.style.background = `#eef0f3 url(${A(IMG + '01-a.webp')}) center 45% / 80% auto no-repeat`;
    $('#vLoad') && $('#vLoad').classList.add('done'); $('.v-tabs', v) && ($('.v-tabs', v).hidden = true);
    const c = $('canvas', v); c && (c.hidden = true);
  };
  if (location.protocol === 'file:') window.viewerFallback();
})();

/* Photo / Both / Model buttons: a keyboard and tap alternative to dragging the comparison */
document.addEventListener('click', e => {
  const b = e.target.closest('.c-steps [data-to]'); if (!b) return;
  const wrap = b.closest('.stage') || b.parentElement.parentElement;
  const input = wrap.querySelector('.compare input'); if (!input) return;
  input.value = b.dataset.to; input.dispatchEvent(new Event('input', { bubbles: true }));
  b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
});

/* ============ Site settings: edit these values ============ */
window.CUBIX = {
  // Seasonal top bar. Shows `message` until the `until` date, then the normal bar returns on its own.
  holiday: { message: 'Christmas orders welcome. We work every day, holidays included, and deliver print ready files within 24 to 48 hours.', until: '2026-12-31' },
  // Real customer quotes. The section appears on the home page as soon as this list has entries.
  // Example: { quote: 'They saved my December.', name: 'Jane Doe', shop: 'Oak and Ember', url: 'https://etsy.com/shop/...' }
  testimonials: [],
  // Photos of finished prints from client shops. The section appears as soon as this list has entries.
  // Example: { img: 'assets/img/prints/01.webp', caption: 'Painted lantern, 229 mm', shop: 'Oak and Ember' }
  prints: [],
  // Cloudflare Web Analytics token (free). Leave empty to load nothing.
  analyticsToken: ''
};
(() => {
  const C = window.CUBIX, $ = s => document.querySelector(s);
  /* holiday deadline in the top bar */
  const bar = $('.topbar .wrap span:not(.pulse)');
  if (bar && C.holiday && C.holiday.message && C.holiday.until && new Date() <= new Date(C.holiday.until + 'T23:59:59')) {
    bar.textContent = C.holiday.message;
    document.documentElement.classList.add('holiday-on');
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* testimonials */
  const ts = document.querySelector('[data-testimonials]');
  if (ts && C.testimonials.length) {
    ts.querySelector('.quotes').innerHTML = C.testimonials.map(t => `<figure class="quote"><blockquote>${esc(t.quote)}</blockquote><figcaption><b>${esc(t.name)}</b>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.shop)}</a>` : esc(t.shop || '')}</figcaption></figure>`).join('');
    ts.hidden = false;
  }
  /* printed results */
  const pr = document.querySelector('[data-prints]');
  if (pr && C.prints.length) {
    pr.querySelector('.prints').innerHTML = C.prints.map(p => `<figure class="print"><img src="${esc(p.img)}" alt="${esc(p.caption)}" loading="lazy"><figcaption><b>${esc(p.caption)}</b><span>${esc(p.shop || '')}</span></figcaption></figure>`).join('');
    pr.hidden = false;
  }
  /* analytics */
  if (C.analyticsToken) {
    const s = document.createElement('script'); s.defer = true; s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: C.analyticsToken })); document.head.appendChild(s);
    document.addEventListener('click', e => { const a = e.target.closest('a[href="start.html"]'); if (a && window.__cfBeacon) { /* page views are tracked automatically */ } });
  }
})();
