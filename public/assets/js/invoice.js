/* CubiX invoice page: /invoice/#<token>. Renders one A4 sheet; "Download PDF" uses the browser's Save as PDF. */
(function () {
  const root = document.getElementById('root');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const amount = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const qty = n => Number.isInteger(Number(n)) ? String(n) : amount(n);
  const token = location.hash.replace(/^#\/?/, '');

  async function load() {
    if (!/^[a-f0-9]{40}$/.test(token)) return missing();
    let r;
    try { r = await fetch('/api/invoice/' + token, { credentials: 'same-origin' }); } catch { return missing('You seem to be offline. Check your connection and reload.'); }
    if (!r.ok) return missing();
    const { invoice: v, business: b } = await r.json();
    document.title = `Invoice ${v.number} | ${b.name}`;
    const due = v.status === 'paid' ? 'Paid' : `${v.currency} ${amount(v.total)}`;
    const contact = [b.email, b.website].filter(Boolean).map(esc).join('<br>');
    root.innerHTML = `<article class="sheet" aria-label="Invoice ${esc(v.number)}">
      ${v.status === 'paid' ? `<div class="stamp">PAID<small>${esc(day(v.paid_at))}</small></div>` : v.status === 'void' ? '<div class="stamp void">VOID</div>' : v.status === 'draft' ? '<div class="stamp draft">DRAFT</div>' : ''}
      <header class="head"><h1>Invoice</h1>
        <div class="from"><img src="/assets/brand/logo.svg" alt="${esc(b.name)}" width="105" height="38">
          ${b.tagline ? `<span class="tag">${esc(b.tagline)}</span>` : ''}
          ${contact || b.address ? `<span class="contact">${contact}${b.address ? `${contact ? '<br>' : ''}${esc(b.address).replace(/\n/g, '<br>')}` : ''}</span>` : ''}</div></header>
      <section class="meta">
        <div><span class="label">Invoice no.</span><b>${esc(v.number)}</b></div>
        <div><span class="label">Issued</span><b>${esc(day(v.issued_at))}</b></div>
        <div><span class="label">Terms</span><b>${esc(v.terms || 'Due on receipt')}</b></div>
        <div><span class="label">${v.status === 'paid' ? 'Status' : 'Amount due'}</span><b class="num">${esc(due)}</b></div></section>
      <section class="parties">
        <div><span class="label">Billed to</span><h2>${esc(v.bill_name)}</h2>${v.bill_email || v.bill_extra ? `<p>${esc([v.bill_email, v.bill_extra].filter(Boolean).join('\n'))}</p>` : ''}</div>
        ${v.project_title || v.project_ref ? `<div><span class="label">Project</span>${v.project_title ? `<h2>${esc(v.project_title)}</h2>` : ''}${v.project_ref ? `<p>${esc(v.project_ref)}</p>` : ''}</div>` : '<div></div>'}</section>
      <table class="items"><thead><tr><th class="label">Description</th><th class="label qty">Qty</th><th class="label rate">Rate</th><th class="label amt">Amount</th></tr></thead><tbody>
        ${v.items.map(it => `<tr><td><h3>${esc(it.title)}</h3>${it.description ? `<p class="desc">${esc(it.description)}</p>` : ''}
          ${it.bullets && it.bullets.length ? `<ul>${it.bullets.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</td>
          <td class="qty num">${esc(qty(it.qty))}</td><td class="rate num">${amount(it.rate)}</td><td class="amt num">${amount(it.amount)}</td></tr>`).join('')}
      </tbody></table>
      <section class="totals">
        <div><span>Subtotal</span><span class="num">${amount(v.subtotal)}</span></div>
        <div><span>Tax${v.tax_rate ? ` (${esc(v.tax_rate)}%)` : ''}</span><span class="num">${amount(v.tax)}</span></div>
        <div class="grand"><span class="label">${v.status === 'paid' ? 'Total paid' : 'Total due'}</span><span><small>${esc(v.currency)}</small><strong class="num">${amount(v.total)}</strong></span></div></section>
      <section class="notes">
        <div><span class="label">Payment</span><p>${esc(v.status === 'paid' ? `Received with thanks${v.paid_via ? ' via ' + v.paid_via : ''} on ${day(v.paid_at)}.` : (v.payment_note || '').replace(/the invoice number/i, `invoice ${v.number}`))}</p></div>
        ${v.notes ? `<div><span class="label">Confidentiality</span><p>${esc(v.notes)}</p></div>` : ''}</section>
      <footer class="foot"><b>Thank you.</b><span>Invoice ${esc(v.number)}${b.website ? ` &middot; ${esc(b.website)}` : ''}</span></footer>
    </article>`;
    const st = document.getElementById('state');
    st.textContent = v.status === 'paid' ? 'Paid' : v.status === 'void' ? 'Void' : v.status === 'draft' ? 'Draft preview, not sent' : `Due: ${v.currency} ${amount(v.total)}`;
    st.className = 'state' + (v.status === 'paid' ? ' paid' : '');
    document.getElementById('bar').hidden = false;
    document.getElementById('tip').hidden = false;
  }
  function missing(msg) { root.innerHTML = `<p class="missing">${esc(msg || 'This invoice link is not valid. Please ask us for a new one.')}</p>`; }
  document.getElementById('print').addEventListener('click', () => window.print());
  window.addEventListener('hashchange', () => location.reload());
  load();
})();
