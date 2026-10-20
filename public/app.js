// TapSplit frontend — vanilla JS single-page app (no build step).
const $app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });
const initials = (name) => name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (p) => `<span class="avatar" style="background:${p.color}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Per-bill identity kept in this browser: which person you are, and the admin token if you created it.
const session = {
  get(billId) {
    try { return JSON.parse(localStorage.getItem('tapsplit:' + billId)) || {}; } catch { return {}; }
  },
  set(billId, patch) {
    try { localStorage.setItem('tapsplit:' + billId, JSON.stringify({ ...session.get(billId), ...patch })); } catch {}
  },
};

// ---------- router ----------
function navigate(path) {
  history.pushState(null, '', path);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a) { e.preventDefault(); navigate(a.getAttribute('href')); }
});
window.addEventListener('popstate', render);

let stream = null;
function render() {
  if (stream) { stream.close(); stream = null; }
  const m = location.pathname.match(/^\/b\/([\w-]+)/);
  if (m) renderBill(m[1]);
  else renderCreate();
}

// =====================================================================
// Create bill page
// =====================================================================
const SAMPLE_RECEIPT = `CAFE BLUE TOKAI - Table 7
Paneer Tikka            1 x 280.00
Butter Naan             4 x 45.00
Dal Makhani                  260.00
2 Cold Coffee                360.00
Masala Chai             3 x 40.00
Chocolate Brownie            190.00
Sub Total                   1390.00
CGST 2.5%                     34.75
SGST 2.5%                     34.75
Service Charge                69.50
Discount (STUDENT10)        -100.00
Grand Total                 1429.00`;

function renderCreate() {
  const state = { items: [{ name: '', qty: 1, price: '' }], tax: '', tip: '', discount: '', mode: 'paste' };

  $app.innerHTML = `
    <section class="hero">
      <h1>Pay for what you ate. Not a rupee more.</h1>
      <p class="muted">Splitting "equally" is unfair to the friend who just had chai. Paste the bill, share one link, and everyone taps what they ordered. Tax, tip and discounts are shared in proportion to what each person ordered.</p>
      <div class="steps">
        <div class="step"><b>1 · Paste</b>Drop in the receipt. We pull out the items, tax and tip.</div>
        <div class="step"><b>2 · Share</b>Send the link to the group. No sign-up needed.</div>
        <div class="step"><b>3 · Tap</b>Everyone claims their dishes, live. Then settle up with UPI.</div>
      </div>
    </section>

    <div class="card">
      <h2>The bill</h2>
      <div class="row">
        <div><label for="title">What was it?</label><input id="title" placeholder="Friday dinner at Blue Tokai" /></div>
        <div><label for="payer">Who paid? (your name)</label><input id="payer" placeholder="Aarav" /></div>
      </div>
      <div><label for="upi">Your UPI ID (optional, lets friends pay you in one tap)</label><input id="upi" placeholder="aarav@okicici" /></div>
    </div>

    <div class="card">
      <h2>Items</h2>
      <div class="tabs">
        <button data-mode="paste">Paste receipt</button>
        <button data-mode="manual">Type items</button>
      </div>
      <div id="paste-box">
        <textarea id="receipt" placeholder="Paste receipt text here (from the bill, an SMS, or a photo-to-text app)…"></textarea>
        <div class="actions" style="margin-top:8px">
          <button id="parse">Read items</button>
          <button class="ghost" id="sample">Use sample receipt</button>
        </div>
      </div>
      <div id="items-box" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <h2>Tax, tip &amp; discount</h2>
      <div class="row row3">
        <div><label for="tax">Tax / GST ₹</label><input id="tax" inputmode="decimal" placeholder="0" /></div>
        <div><label for="tip">Service / tip ₹</label><input id="tip" inputmode="decimal" placeholder="0" /></div>
        <div><label for="discount">Discount ₹</label><input id="discount" inputmode="decimal" placeholder="0" /></div>
      </div>
      <div class="totals"><span>Bill total</span><span id="grand">₹0</span></div>
    </div>

    <button class="block" id="create">Create &amp; get share link →</button>
  `;

  const $ = (id) => document.getElementById(id);

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('paste-box').hidden = mode !== 'paste';
  }

  function drawItems() {
    const box = $('items-box');
    const filled = state.items.some((i) => i.name || i.price);
    if (state.mode === 'paste' && !filled) { box.innerHTML = ''; updateTotal(); return; }
    box.innerHTML = `
      <div class="item-edit small muted"><span>Item</span><span>Qty</span><span>Price each ₹</span><span></span></div>
      ${state.items.map((it, i) => `
        <div class="item-edit" data-i="${i}">
          <input data-k="name" value="${esc(it.name)}" placeholder="Item name" />
          <input data-k="qty" value="${esc(it.qty)}" inputmode="numeric" />
          <input data-k="price" value="${esc(it.price)}" inputmode="decimal" placeholder="0" />
          <button class="danger" data-remove="${i}" title="Remove">✕</button>
        </div>`).join('')}
      <button class="ghost" id="add-item" style="margin-top:6px">+ Add item</button>
    `;
    updateTotal();
  }

  function updateTotal() {
    const n = (v) => parseFloat(v) || 0;
    const items = state.items.reduce((s, it) => s + n(it.price) * (parseInt(it.qty, 10) || 1), 0);
    const total = items + n($('tax').value) + n($('tip').value) - n($('discount').value);
    $('grand').textContent = rupees(Math.round(total * 100));
  }

  $app.oninput = (e) => {
    const row = e.target.closest('.item-edit');
    if (row) state.items[row.dataset.i][e.target.dataset.k] = e.target.value;
    updateTotal();
  };
  $app.onclick = (e) => {
    if (e.target.dataset.mode) { setMode(e.target.dataset.mode); drawItems(); }
    if (e.target.id === 'add-item') { state.items.push({ name: '', qty: 1, price: '' }); drawItems(); }
    if (e.target.dataset.remove !== undefined) {
      state.items.splice(+e.target.dataset.remove, 1);
      if (!state.items.length) state.items.push({ name: '', qty: 1, price: '' });
      drawItems();
    }
  };

  $('sample').onclick = () => { $('receipt').value = SAMPLE_RECEIPT; $('parse').click(); };
  $('parse').onclick = async () => {
    try {
      const parsed = await api('POST', '/api/parse-receipt', { text: $('receipt').value });
      if (!parsed.items.length) return toast("Couldn't find any items. Try typing them instead.");
      state.items = parsed.items;
      $('tax').value = parsed.tax || '';
      $('tip').value = parsed.tip || '';
      $('discount').value = parsed.discount || '';
      drawItems();
      toast(`Found ${parsed.items.length} items. Check them below.`);
    } catch (err) { toast(err.message); }
  };

  $('create').onclick = async () => {
    const items = state.items.filter((i) => i.name.trim() && parseFloat(i.price) > 0);
    if (!$('payer').value.trim()) return toast('Enter the name of the person who paid');
    if (!items.length) return toast('Add at least one item with a price');
    $('create').disabled = true;
    try {
      const res = await api('POST', '/api/bills', {
        title: $('title').value || 'Dinner',
        payerName: $('payer').value,
        upiId: $('upi').value,
        tax: $('tax').value, tip: $('tip').value, discount: $('discount').value,
        items,
      });
      session.set(res.id, { personId: res.personId, adminToken: res.adminToken });
      navigate('/b/' + res.id);
      setTimeout(() => toast('Bill created! Share the link with your friends.'), 300);
    } catch (err) {
      toast(err.message);
      $('create').disabled = false;
    }
  };

  setMode('paste');
  drawItems();
}

// =====================================================================
// Bill page (shared link)
// =====================================================================
function renderBill(billId) {
  let bill = null;
  let actingAs = null; // the creator can tap on behalf of friends without a phone
  if (stream) stream.close();
  $app.oninput = null;
  $app.innerHTML = `<p class="muted">Loading bill…</p>`;

  stream = new EventSource(`/api/bills/${billId}/events`);
  stream.onmessage = (e) => { bill = JSON.parse(e.data); draw(); };
  stream.onerror = async () => {
    if (bill) return; // EventSource reconnects on its own
    try { await api('GET', `/api/bills/${billId}`); } catch (err) {
      stream.close();
      $app.innerHTML = `<div class="card"><h2>Bill not found</h2><p class="muted">Check the link, or <a href="/" data-link>create a new bill</a>.</p></div>`;
    }
  };

  const me = () => session.get(billId);
  const personById = (id) => bill.people.find((p) => p.id === id);

  function draw() {
    const { personId, adminToken } = me();
    const you = personId && personById(personId);
    if (!you) return drawJoin();
    if (!actingAs || !personById(actingAs)) actingAs = you.id;

    const s = bill.split;
    const payer = personById(bill.payerId);
    const actor = personById(actingAs);
    const myRow = s.persons.find((p) => p.personId === actor.id);
    const pct = Math.round(s.progress * 100);

    $app.innerHTML = `
      <div class="card ${bill.locked ? 'locked' : ''}">
        <div class="bill-head">
          <div>
            <h1>${esc(bill.title)}</h1>
            <div class="muted small">Paid by <b>${esc(payer?.name)}</b> · ${bill.items.length} items ${bill.locked ? '· <span class="badge">LOCKED</span>' : '· <span class="live">live</span>'}</div>
          </div>
          <div style="text-align:right">
            <div class="big">${rupees(s.grandTotal)}</div>
            <div class="muted small">total</div>
          </div>
        </div>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="muted small">${pct}% of items claimed${s.unclaimed.length ? ` · ${s.unclaimed.length} left` : ' · all done 🎉'}</div>
        <div class="actions" style="margin-top:12px">
          <button id="share">Share link</button>
          <a class="btn ghost" href="#summary">See who owes what</a>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <h2 style="margin:0">${adminToken ? 'Tapping as' : 'In this bill'}</h2>
          ${adminToken ? '' : `<span class="muted small">You are ${avatar(you)} <b>${esc(you.name)}</b></span>`}
        </div>
        <div class="people">
          ${bill.people.map((p) => `
            <button class="chip ${adminToken ? '' : 'static'} ${p.id === actingAs ? 'selected' : ''}" data-act="${p.id}">
              ${avatar(p)} ${esc(p.name)}${p.id === you.id ? ' (you)' : ''}
            </button>`).join('')}
          ${adminToken && !bill.locked ? `<button class="chip" id="add-friend">＋ friend without the app</button>` : ''}
        </div>
        ${adminToken && actingAs !== you.id ? `<p class="small muted" style="margin:10px 0 0">You're claiming items for <b>${esc(actor.name)}</b>.</p>` : ''}
      </div>

      <h2 style="margin:18px 4px 10px">${bill.locked ? 'Items' : 'Tap everything you had'}</h2>
      <div class="items">
        ${bill.items.map((it) => drawItem(it)).join('')}
      </div>

      ${drawSummary()}
      ${adminToken ? drawAdmin() : ''}

      <div class="dock"><div class="dock-inner">
        <div>
          <div class="label">${actor.id === you.id ? 'Your share' : esc(actor.name) + "'s share"} (incl. tax &amp; tip)</div>
          <div class="amount">${rupees(myRow?.total || 0)}</div>
        </div>
        ${payUpiButton(myRow, actor)}
      </div></div>
    `;
  }

  function drawItem(it) {
    const claimers = bill.claims.filter((c) => c.itemId === it.id).map((c) => personById(c.personId)).filter(Boolean);
    const mine = claimers.some((p) => p.id === actingAs);
    const line = it.price * it.qty;
    const shareLine = mine && claimers.length > 1
      ? `<div class="share">Split ${claimers.length} ways · ${rupees(Math.round(line / claimers.length))} each</div>` : '';
    return `
      <div class="item ${mine ? 'mine' : ''} ${claimers.length ? '' : 'unclaimed'}" data-item="${it.id}" role="button" aria-pressed="${mine}">
        <div class="check">${mine ? '✓' : ''}</div>
        <div class="info">
          <div class="name">${esc(it.name)}</div>
          <div class="meta">${it.qty > 1 ? `${it.qty} × ${rupees(it.price)}` : (claimers.length ? '' : 'Nobody yet')}</div>
          ${shareLine}
        </div>
        <div class="stack">${claimers.map(avatar).join('')}</div>
        <div class="price">${rupees(line)}</div>
      </div>`;
  }

  function drawSummary() {
    const s = bill.split;
    const { personId } = me();
    const payer = personById(bill.payerId);
    return `
      <div class="card" id="summary" style="margin-top:18px">
        <h2>Who owes what</h2>
        ${s.unclaimed.length ? `<div class="warn">⚠ ${s.unclaimed.length} item${s.unclaimed.length > 1 ? 's' : ''} (${rupees(s.unclaimed.reduce((a, u) => a + u.amount, 0))}) not claimed yet: ${s.unclaimed.map((u) => esc(u.name)).join(', ')}. The totals below go up once these are claimed.</div>` : ''}
        <div class="table-wrap"><table>
          <thead><tr><th>Person</th><th>Food</th><th>Tax+tip</th><th>Discount</th><th>Total</th></tr></thead>
          <tbody>
            ${s.persons.map((p) => `
              <tr class="${p.personId === personId ? 'me' : ''}">
                <td>${avatar(personById(p.personId))} ${esc(p.name)}</td>
                <td>${rupees(p.subtotal)}</td>
                <td>${rupees(p.tax + p.tip)}</td>
                <td>${p.discount ? '−' + rupees(p.discount) : '—'}</td>
                <td><b>${rupees(p.total)}</b></td>
              </tr>`).join('')}
          </tbody>
        </table></div>

        <h2 style="margin-top:18px">Settle up</h2>
        ${s.settlements.length ? s.settlements.map((t) => `
          <div class="settle">
            <div class="who">${avatar(personById(t.fromId))} <b>${esc(t.from)}</b> <span class="muted">pays</span> ${avatar(payer)} <b>${esc(payer.name)}</b></div>
            <b>${rupees(t.amount)}</b>
          </div>`).join('') : `<p class="muted">Nobody owes anything yet. Once people claim items, it shows up here.</p>`}
      </div>`;
  }

  function payUpiButton(row, actor) {
    const payer = personById(bill.payerId);
    if (!row || !row.total || actor.id === bill.payerId) {
      return actor.id === bill.payerId ? `<span class="badge">You paid · you're owed ${rupees(bill.split.settlements.reduce((a, t) => a + t.amount, 0))}</span>` : '';
    }
    if (!bill.upiId) return `<span class="muted small">Pay ${esc(payer.name)}</span>`;
    const url = `upi://pay?pa=${encodeURIComponent(bill.upiId)}&pn=${encodeURIComponent(payer.name)}&am=${(row.total / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(bill.title)}`;
    return `<a class="btn" href="${esc(url)}">Pay ${esc(payer.name)} via UPI</a>`;
  }

  function drawAdmin() {
    const r = (p) => (p / 100).toString();
    return `
      <div class="card" id="admin">
        <h2>Bill settings <span class="badge">only you see this</span></h2>
        <div class="row row3">
          <div><label>Tax ₹</label><input id="a-tax" value="${r(bill.tax)}" inputmode="decimal" /></div>
          <div><label>Tip ₹</label><input id="a-tip" value="${r(bill.tip)}" inputmode="decimal" /></div>
          <div><label>Discount ₹</label><input id="a-discount" value="${r(bill.discount)}" inputmode="decimal" /></div>
        </div>
        <div><label>UPI ID</label><input id="a-upi" value="${esc(bill.upiId || '')}" placeholder="name@bank" /></div>
        <div class="item-edit" style="margin-top:12px;grid-template-columns:1fr 64px 96px">
          <input id="n-name" placeholder="Forgot an item?" /><input id="n-qty" value="1" inputmode="numeric" /><input id="n-price" placeholder="₹" inputmode="decimal" />
        </div>
        <div class="actions" style="margin-top:10px">
          <button id="save">Save</button>
          <button class="ghost" id="add-new">Add item</button>
          <button class="ghost" id="lock">${bill.locked ? 'Unlock bill' : 'Lock bill (stop changes)'}</button>
        </div>
      </div>`;
  }

  // Event delegation for the whole bill page
  $app.onclick = async (e) => {
    if (!bill) return;
    const { adminToken } = me();
    const admin = { 'x-admin-token': adminToken };
    try {
      const itemEl = e.target.closest('[data-item]');
      if (itemEl && !bill.locked) {
        itemEl.classList.toggle('mine'); // instant feedback; the live stream confirms
        await api('POST', `/api/bills/${billId}/claims/toggle`, { itemId: +itemEl.dataset.item, personId: actingAs });
        if (navigator.vibrate) navigator.vibrate(10);
        return;
      }
      const chip = e.target.closest('[data-act]');
      if (chip && adminToken) { actingAs = +chip.dataset.act; draw(); return; }
      if (e.target.closest('#add-friend')) {
        const name = prompt("Friend's name");
        if (!name) return;
        const { personId } = await api('POST', `/api/bills/${billId}/people`, { name });
        actingAs = personId;
        return;
      }
      if (e.target.id === 'share') return share();
      if (e.target.id === 'save') {
        await api('PATCH', `/api/bills/${billId}`, {
          tax: document.getElementById('a-tax').value, tip: document.getElementById('a-tip').value,
          discount: document.getElementById('a-discount').value, upiId: document.getElementById('a-upi').value,
        }, admin);
        return toast('Saved');
      }
      if (e.target.id === 'add-new') {
        await api('POST', `/api/bills/${billId}/items`, {
          name: document.getElementById('n-name').value, qty: document.getElementById('n-qty').value, price: document.getElementById('n-price').value,
        }, admin);
        return toast('Item added');
      }
      if (e.target.id === 'lock') {
        await api('PATCH', `/api/bills/${billId}`, { locked: !bill.locked }, admin);
        return toast(bill.locked ? 'Unlocked' : 'Locked. Totals are final.');
      }
    } catch (err) { toast(err.message); }
  };

  async function share() {
    const url = location.origin + '/b/' + billId;
    const text = `Tap what you had from "${bill.title}" and see what you owe:`;
    if (navigator.share) { try { await navigator.share({ title: 'TapSplit', text, url }); return; } catch {} }
    try { await navigator.clipboard.writeText(url); toast('Link copied! Paste it in your group chat.'); }
    catch { prompt('Copy this link:', url); }
  }

  function drawJoin() {
    const payer = personById(bill.payerId);
    $app.innerHTML = `
      <div class="card">
        <p class="muted small" style="margin:0">${esc(payer?.name)} paid ${rupees(bill.split.grandTotal)} for</p>
        <h1>${esc(bill.title)}</h1>
        <p class="muted">Tell us who you are, then tap the items you had. No sign-up needed.</p>
        ${bill.people.length ? `
          <label>Already in the bill? Tap your name</label>
          <div class="people" style="margin-bottom:14px">
            ${bill.people.map((p) => `<button class="chip" data-join="${p.id}">${avatar(p)} ${esc(p.name)}</button>`).join('')}
          </div>` : ''}
        ${bill.locked ? '<div class="warn">This bill is locked, so new people can\'t join.</div>' : `
          <label for="join-name">Or join as someone new</label>
          <div style="display:flex;gap:8px">
            <input id="join-name" placeholder="Your name" autocomplete="given-name" />
            <button id="join">Join</button>
          </div>`}
      </div>
      <div class="card"><h2>On the bill</h2><div class="items">${bill.items.map((it) => `
        <div class="item static"><div class="info"><div class="name">${esc(it.name)}</div></div><div class="price">${rupees(it.price * it.qty)}</div></div>`).join('')}
      </div></div>`;

    $app.onclick = async (e) => {
      const chip = e.target.closest('[data-join]');
      if (chip) { session.set(billId, { personId: +chip.dataset.join }); renderBill(billId); return; }
      if (e.target.id === 'join') {
        const name = document.getElementById('join-name').value.trim();
        if (!name) return toast('Enter your name');
        try {
          const { personId } = await api('POST', `/api/bills/${billId}/people`, { name });
          session.set(billId, { personId });
          renderBill(billId);
        } catch (err) { toast(err.message); }
      }
    };
    document.getElementById('join-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('join').click(); });
  }
}

render();
