// TapSplit frontend — vanilla JS single-page app (no build step).
const $app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (paise) => (paise < 0 ? '−' : '') + '₹' + (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });
const initials = (name) => name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (p, cls = '') => `<span class="avatar ${cls}" style="background:${p.color}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const haptic = () => navigator.vibrate && navigator.vibrate(8);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
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

// Bottom sheet (a modal that slides up on phones, centred on desktop).
function openSheet(title, bodyHtml) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grab"></div>
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="sheet-body">${bodyHtml}</div>
    </div>`;
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  backdrop.querySelector('input:not([type=hidden])')?.focus();
  return { el: backdrop, close, $: (sel) => backdrop.querySelector(sel) };
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#13a073', '#ffc914', '#e4572e', '#17bebb', '#7e5bef', '#ff7aa2'];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = 1.6 + Math.random() * 1.6 + 's';
    p.style.animationDelay = Math.random() * 0.4 + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4000);
}

function shareSheet(bill) {
  const url = `${location.origin}/b/${bill.id}`;
  const text = `Tap what you had from "${bill.title}" and see what you owe 👇`;
  const sheet = openSheet('Invite your friends', `
    <p class="muted small" style="margin-top:-6px">Friends can scan this at the table, or you can send the link to the group chat. They don't need to sign up.</p>
    <div class="qr" id="qr"></div>
    <div class="link-box"><code>${esc(url)}</code><button class="soft" id="copy">Copy</button></div>
    <div class="share-grid">
      <a class="btn whatsapp" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}">WhatsApp</a>
      <button class="ghost" id="native-share">More…</button>
    </div>`);
  if (window.qrcode) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    sheet.$('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
  } else sheet.$('#qr').remove();
  sheet.$('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); sheet.$('#copy').textContent = 'Copied ✓'; }
    catch { getSelection().selectAllChildren(sheet.$('code')); toast('Press Ctrl+C to copy'); }
  };
  const nativeBtn = sheet.$('#native-share');
  if (!navigator.share) nativeBtn.remove();
  else nativeBtn.onclick = () => navigator.share({ title: 'TapSplit', text, url }).catch(() => {});
}

// ---------- theme toggle ----------
const themeBtn = document.getElementById('theme-toggle');
function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.textContent = dark ? '☀️' : '🌙';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
themeBtn.onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('tapsplit:theme', dark ? 'dark' : 'light'); } catch {}
  syncThemeButton();
};
syncThemeButton();

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
  document.querySelectorAll('.sheet-backdrop').forEach((s) => s.remove());
  window.scrollTo(0, 0);
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
  $app.className = '';
  const state = { items: [], showPaste: true, subtotal: 0, total: 0 };
  const blankItem = () => ({ name: '', qty: 1, price: '' });
  const num = (v) => parseFloat(v) || 0;

  $app.innerHTML = `
    <section class="hero">
      <h1>Split by <em>what you ate</em>, not equally.</h1>
      <p class="muted">Snap a photo of the bill, share one link, and everyone taps their own dishes. Tax, tip and discounts are shared out fairly, to the paisa.</p>
      <div class="steps"><span>① Snap or paste the bill</span><span>② Share a link</span><span>③ Everyone taps their dishes</span></div>
    </section>

    <div class="section-title"><h2><span class="step-num">1</span>What's on the bill?</h2></div>
    <div class="card">
      <div id="paste-zone" class="paste-zone">
        <label class="scan-zone" id="scan-zone">
          <input type="file" accept="image/*" id="scan-input" hidden />
          <span class="scan-icon" aria-hidden="true">📷</span>
          <span class="scan-text">
            <b>Scan a photo or screenshot of the bill</b>
            <span class="muted small">Tap to choose or take a photo<span class="desktop-only"> · drag it here · or press Ctrl+V to paste</span></span>
          </span>
        </label>
        <div class="divider"><span>or paste the text</span></div>
        <textarea id="receipt" aria-label="Receipt text" placeholder="Paste the receipt text here (from an e-bill, SMS or email)…"></textarea>
        <div class="actions">
          <button id="parse">Read items</button>
          <button class="ghost" id="sample">Try a sample bill</button>
          <button class="link-btn" id="manual">or type items yourself</button>
        </div>
      </div>
      <div id="parsed-banner" class="parsed-banner hidden"></div>
      <div id="items-box"></div>
    </div>

    <div id="extras" class="card hidden">
      <h2>Tax, service &amp; discount</h2>
      <div class="grid3">
        <div><label for="tax">Tax / GST</label><input id="tax" inputmode="decimal" placeholder="₹0" /></div>
        <div><label for="tip">Service / tip</label><input id="tip" inputmode="decimal" placeholder="₹0" /></div>
        <div><label for="discount">Discount</label><input id="discount" inputmode="decimal" placeholder="₹0" /></div>
      </div>
      <p class="muted small" style="margin:10px 0 0">These are shared in proportion to what each person ordered.</p>
    </div>

    <div class="section-title"><h2><span class="step-num">2</span>About you</h2></div>
    <div class="card">
      <div class="grid2">
        <div class="field"><label for="payer">Your name (you paid)</label><input id="payer" placeholder="Aarav" autocomplete="given-name" /></div>
        <div class="field"><label for="title">Where / what was it?</label><input id="title" placeholder="Friday dinner at Blue Tokai" /></div>
      </div>
      <div><label for="upi">Your UPI ID <span style="font-weight:400">(optional, so friends can pay you in one tap)</span></label><input id="upi" placeholder="aarav@okicici" autocomplete="off" /></div>
    </div>

    <div class="cta-dock"><div class="inner"><button class="block" id="create" disabled>Add items to continue</button></div></div>
  `;

  const $ = (id) => document.getElementById(id);

  function itemsTotal() {
    return state.items.reduce((s, it) => s + num(it.price) * it.qty, 0);
  }

  function updateCta() {
    const total = itemsTotal() + num($('tax').value) + num($('tip').value) - num($('discount').value);
    const valid = state.items.filter((i) => i.name.trim() && num(i.price) > 0);
    const btn = $('create');
    if (!valid.length) { btn.disabled = true; btn.textContent = 'Add items to continue'; }
    else if (!$('payer').value.trim()) { btn.disabled = true; btn.textContent = 'Enter your name to continue'; }
    else { btn.disabled = false; btn.innerHTML = `Create bill · ${rupees(Math.round(total * 100))} →`; }
  }

  function rowHtml(it, i) {
    return `
      <div class="edit-row" data-i="${i}">
        <input class="name-input" data-k="name" value="${esc(it.name)}" placeholder="Item name" aria-label="Item name" />
        <div class="bottom">
          <div class="stepper" aria-label="Quantity">
            <button data-step="-1" aria-label="Fewer">−</button><span>${it.qty}</span><button data-step="1" aria-label="More">+</button>
          </div>
          <div class="price-input"><span class="muted">₹</span><input data-k="price" value="${esc(it.price)}" inputmode="decimal" placeholder="Price each" aria-label="Price each" /></div>
          <span class="line-total num">${it.qty > 1 && num(it.price) ? rupees(Math.round(num(it.price) * it.qty * 100)) : ''}</span>
          <button class="remove" data-remove aria-label="Remove item">✕</button>
        </div>
      </div>`;
  }

  function drawItems(focusLast = false) {
    const box = $('items-box');
    $('paste-zone').classList.toggle('hidden', !state.showPaste);
    $('extras').classList.toggle('hidden', state.items.length === 0);
    box.innerHTML = state.items.length ? `
      <div class="edit-list">${state.items.map(rowHtml).join('')}</div>
      <button class="ghost" id="add-item" style="margin-top:10px;width:100%">＋ Add item</button>
      <div id="subtotal-check"></div>` : '';
    if (focusLast) box.querySelector('.edit-row:last-child .name-input')?.focus();
    updateCta();
    checkSubtotal();
  }

  // Compare the items with the subtotal (or, failing that, the total) printed on the bill,
  // so misread or missing lines get noticed.
  function checkSubtotal() {
    const box = $('subtotal-check');
    if (!box) return;
    const useSubtotal = !!state.subtotal;
    if (!useSubtotal && !state.total) { box.innerHTML = ''; return; }
    const extras = useSubtotal ? 0 : num($('tax').value) + num($('tip').value) - num($('discount').value);
    const ours = Math.round((itemsTotal() + extras) * 100);
    const bill = Math.round((useSubtotal ? state.subtotal : state.total) * 100);
    const what = useSubtotal ? 'subtotal' : 'total';
    box.innerHTML = Math.abs(ours - bill) <= 1
      ? `<div class="success" style="margin:12px 0 0">✓ Items add up to the bill's ${what} (${rupees(bill)}).</div>`
      : `<div class="warn" style="margin:12px 0 0"><span>⚠</span><span>These ${useSubtotal ? 'items' : 'items plus tax and tip'} add up to <b>${rupees(ours)}</b>, but the bill's ${what} is <b>${rupees(bill)}</b>. Some prices may have been misread or missed, so compare with your photo.</span></div>`;
  }

  function showBanner(count, photoUrl) {
    const b = $('parsed-banner');
    b.classList.remove('hidden');
    b.innerHTML = `
      <span style="display:flex;align-items:center;gap:10px">
        ${photoUrl ? `<a href="${photoUrl}" target="_blank" rel="noopener" title="Open your photo"><img class="thumb" src="${photoUrl}" alt="Your bill" /></a>` : ''}
        <span>✓ ${photoUrl ? 'Read' : 'Found'} ${plural(count, 'item')}${photoUrl ? ' from your photo' : ''}. Check they look right.</span>
      </span>
      <button class="link-btn" id="repaste">${photoUrl ? 'Try another' : 'Paste again'}</button>`;
  }

  $app.oninput = (e) => {
    const row = e.target.closest('.edit-row');
    if (row) {
      const it = state.items[row.dataset.i];
      it[e.target.dataset.k] = e.target.value;
      row.querySelector('.line-total').textContent = it.qty > 1 && num(it.price) ? rupees(Math.round(num(it.price) * it.qty * 100)) : '';
    }
    checkSubtotal();
    updateCta();
  };

  $app.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const row = t.closest('.edit-row');
    if (row && t.dataset.step) {
      const it = state.items[row.dataset.i];
      it.qty = Math.min(99, Math.max(1, it.qty + Number(t.dataset.step)));
      drawItems();
      return;
    }
    if (row && t.hasAttribute('data-remove')) {
      state.items.splice(+row.dataset.i, 1);
      drawItems();
      return;
    }
    if (t.id === 'add-item') { state.items.push(blankItem()); drawItems(true); return; }
    if (t.id === 'manual') { state.showPaste = false; if (!state.items.length) state.items.push(blankItem()); drawItems(true); return; }
    if (t.id === 'repaste') { state.showPaste = true; $('parsed-banner').classList.add('hidden'); drawItems(); $('receipt').focus(); return; }
    if (t.id === 'sample') { $('receipt').value = SAMPLE_RECEIPT; return parse(); }
    if (t.id === 'parse') return parse();
    if (t.id === 'create') return create();
  };

  function applyParsed(parsed, photoUrl) {
    state.items = parsed.items.map((i) => ({ name: i.name, qty: i.qty, price: String(i.price) }));
    state.subtotal = parsed.subtotal || 0;
    state.total = parsed.total || 0;
    state.showPaste = false;
    $('tax').value = parsed.tax || '';
    $('tip').value = parsed.tip || '';
    $('discount').value = parsed.discount || '';
    showBanner(parsed.items.length, photoUrl);
    drawItems();
    if (!$('payer').value) $('payer').focus({ preventScroll: true });
  }

  async function parse() {
    if (!$('receipt').value.trim()) { toast('Paste the receipt text first'); $('receipt').focus(); return; }
    try {
      const parsed = await api('POST', '/api/parse-receipt', { text: $('receipt').value });
      if (!parsed.items.length) return toast("Couldn't find any items. Try typing them instead.");
      applyParsed(parsed);
    } catch (err) { toast(err.message); }
  }

  // ---------- scanning a photo / screenshot ----------
  // Clean the photo up for OCR: resize (small images enlarged, huge ones shrunk), greyscale,
  // and stretch the contrast so dim restaurant photos become dark text on a light background.
  function prepareImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const long = Math.max(img.naturalWidth, img.naturalHeight);
        const scale = long > 2200 ? 2200 / long : long < 1600 ? Math.min(3, 1600 / long) : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        autoContrast(ctx, canvas.width, canvas.height);
        // PNG keeps the text edges crisp (JPEG artefacts hurt OCR).
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image'))), 'image/png');
      };
      img.onerror = () => reject(new Error("That file doesn't look like an image we can read"));
      img.src = URL.createObjectURL(file);
    });
  }

  function autoContrast(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const grey = new Uint8ClampedArray(w * h);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      grey[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      hist[grey[j]]++;
    }
    // Ignore the darkest and brightest 2% when finding the range to stretch.
    const cut = grey.length * 0.02;
    let lo = 0, hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < cut; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < cut; hi--);
    const range = Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      px[i] = px[i + 1] = px[i + 2] = ((grey[j] - lo) * 255) / range;
    }
    ctx.putImageData(data, 0, 0);
  }

  async function scanImage(file) {
    if (!file || !file.type.startsWith('image/')) return toast('Choose a photo or screenshot of the bill');
    const zone = $('scan-zone');
    if (zone.classList.contains('scanning')) return;
    const photoUrl = URL.createObjectURL(file);
    zone.classList.add('scanning');
    zone.querySelector('.scan-icon').innerHTML = `<img class="thumb" src="${photoUrl}" alt="" />`;
    zone.querySelector('.scan-text').innerHTML = '<b><span class="spinner"></span> Reading your bill…</b><span class="muted small">This takes a few seconds</span>';
    try {
      const blob = await prepareImage(file);
      const res = await fetch('/api/scan-receipt', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(parsed.error || 'Could not read that image');
      $('receipt').value = parsed.text.trim();
      if (!parsed.items.length) {
        toast("Couldn't spot any prices. Check the text we read below, or type the items.");
        $('receipt').focus();
      } else {
        applyParsed(parsed, photoUrl);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      resetScanZone();
    }
  }

  function resetScanZone() {
    const zone = $('scan-zone');
    if (!zone) return;
    zone.classList.remove('scanning', 'dragging');
    zone.querySelector('.scan-icon').textContent = '📷';
    zone.querySelector('.scan-text').innerHTML = '<b>Scan a photo or screenshot of the bill</b><span class="muted small">Tap to choose or take a photo<span class="desktop-only"> · drag it here · or press Ctrl+V to paste</span></span>';
    $('scan-input').value = '';
  }

  $('scan-input').onchange = (e) => scanImage(e.target.files[0]);
  const zone = $('scan-zone');
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('dragging'); };
  zone.ondragleave = () => zone.classList.remove('dragging');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('dragging'); scanImage(e.dataTransfer.files[0]); };
  // Paste a screenshot from the clipboard anywhere on this page.
  document.onpaste = (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return; // plain text pastes go into the textarea as normal
    e.preventDefault();
    if (!state.showPaste) { state.showPaste = true; drawItems(); }
    scanImage(file);
  };

  async function create() {
    const items = state.items.filter((i) => i.name.trim() && num(i.price) > 0);
    $('create').disabled = true;
    $('create').textContent = 'Creating…';
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
      shareSheet(res.bill);
    } catch (err) {
      toast(err.message);
      updateCta();
    }
  }

  drawItems();
}

// =====================================================================
// Bill page (shared link)
// =====================================================================
function renderBill(billId) {
  let bill = null;
  let actingAs = null; // the creator can tap on behalf of friends without a phone
  let filter = 'all';
  let pop = { id: null, until: 0 };
  let lastProgress = null;

  if (stream) stream.close();
  $app.oninput = null;
  document.onpaste = null;
  $app.className = 'wide';
  $app.innerHTML = `
    <div class="skeleton" style="height:150px;margin-bottom:14px"></div>
    ${'<div class="skeleton" style="height:58px;margin-bottom:8px"></div>'.repeat(5)}`;

  stream = new EventSource(`/api/bills/${billId}/events`);
  stream.onmessage = (e) => {
    bill = JSON.parse(e.data);
    const p = bill.split.progress;
    if (lastProgress !== null && lastProgress < 1 && p === 1) { confetti(); toast('Everything is claimed 🎉'); }
    lastProgress = p;
    draw();
  };
  stream.onerror = async () => {
    if (bill) return; // EventSource reconnects on its own
    try { await api('GET', `/api/bills/${billId}`); } catch (err) {
      stream.close();
      $app.className = '';
      $app.innerHTML = `<div class="empty" style="margin-top:40px"><span class="emoji">🧾</span><b>We couldn't find this bill</b><p class="small" style="margin:6px 0 14px">The link might be wrong, or the bill was removed.</p><a class="btn" href="/" data-link>Split a new bill</a></div>`;
    }
  };

  const me = () => session.get(billId);
  const personById = (id) => bill.people.find((p) => p.id === id);
  const claimersOf = (itemId) => bill.claims.filter((c) => c.itemId === itemId).map((c) => personById(c.personId)).filter(Boolean);
  const rowFor = (pid) => bill.split.persons.find((p) => p.personId === pid);
  const isAdmin = () => !!me().adminToken;

  function draw() {
    const you = me().personId && personById(me().personId);
    if (!you) return drawJoin();
    if (!actingAs) actingAs = you.id;

    const s = bill.split;
    const payer = personById(bill.payerId);
    const pct = Math.round(s.progress * 100);
    const mineCount = bill.items.filter((it) => claimersOf(it.id).some((p) => p.id === actingAs)).length;
    const visible = bill.items.filter((it) => {
      const c = claimersOf(it.id);
      if (filter === 'mine') return c.some((p) => p.id === actingAs);
      if (filter === 'open') return c.length === 0;
      return true;
    });
    const actor = personById(actingAs) || you; // a just-added friend may not have arrived via the live stream yet

    $app.innerHTML = `
      <div class="bill-layout ${bill.locked ? 'locked' : ''}">
        <div>
          <div class="card">
            <div class="bill-head">
              <div style="min-width:0">
                <h1>${esc(bill.title)}</h1>
                <div class="status-row small muted">
                  <span>${esc(payer?.name)} paid</span>
                  ${bill.locked ? '<span class="pill grey">🔒 Final</span>' : '<span class="live">Live</span>'}
                </div>
              </div>
              <div style="text-align:right">
                <div class="big num">${rupees(s.grandTotal)}</div>
                <div class="muted small">total</div>
              </div>
            </div>
            <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
            <div class="progress-label"><span>${pct === 100 ? 'All items claimed ✓' : `${pct}% claimed`}</span><span>${s.unclaimed.length ? `${plural(s.unclaimed.length, 'item')} left` : ''}</span></div>

            <div style="margin-top:14px">
              <div class="small muted" style="margin-bottom:6px">${isAdmin() ? 'Tapping items for' : 'In this bill'}</div>
              <div class="people">
                ${bill.people.map((p) => `
                  <${isAdmin() ? 'button' : 'span'} class="chip ${isAdmin() && p.id === actingAs ? 'selected' : ''}" data-act="${p.id}">
                    ${avatar(p)} ${esc(p.name)}${p.id === you.id ? ' <span class="me-tag">you</span>' : ''}
                  </${isAdmin() ? 'button' : 'span'}>`).join('')}
                ${isAdmin() && !bill.locked ? '<button class="chip add" id="add-friend">＋ Friend without the app</button>' : ''}
              </div>
            </div>
            <div class="actions" style="margin-top:14px">
              ${bill.locked ? '' : '<button class="soft" id="share">＋ Invite friends</button>'}
              ${isAdmin() ? `<button class="ghost" id="settings">Edit bill</button>` : ''}
              <button class="link-btn" id="switch" style="margin-left:auto">Not ${esc(you.name)}?</button>
            </div>
          </div>

          ${isAdmin() && actingAs !== you.id ? `<div class="success">You're tapping items for <b>${esc(actor.name)}</b>. <button class="link-btn" data-act="${you.id}">Back to me</button></div>` : ''}

          <div class="section-title">
            <h2>${bill.locked ? 'Items' : 'Tap what you had'}</h2>
            <div class="filters" role="tablist">
              ${[['all', 'All', bill.items.length], ['mine', actingAs === you.id ? 'Mine' : esc(actor.name), mineCount], ['open', 'Unclaimed', s.unclaimed.length]]
                .map(([k, label, n]) => `<button role="tab" aria-selected="${filter === k}" class="${filter === k ? 'active' : ''}" data-filter="${k}">${label} <span class="count">${n}</span></button>`).join('')}
            </div>
          </div>
          <div class="items">
            ${visible.length ? visible.map(drawItem).join('') : emptyState()}
          </div>
        </div>

        <div class="side">
          <div class="section-title"><h2>Who owes what</h2></div>
          ${drawSummary()}
        </div>
      </div>
      ${drawDock(you, actor)}
    `;
  }

  function emptyState() {
    if (filter === 'mine') return `<div class="empty"><span class="emoji">👆</span>You haven't picked anything yet.<br/><button class="link-btn" data-filter="all">Show all items</button></div>`;
    return `<div class="empty"><span class="emoji">🎉</span>Every item has been claimed.</div>`;
  }

  function drawItem(it) {
    const claimers = claimersOf(it.id);
    const mine = claimers.some((p) => p.id === actingAs);
    const line = it.price * it.qty;
    const myShare = rowFor(actingAs)?.items.find((x) => x.itemId === it.id);
    const meta = [it.qty > 1 ? `${it.qty} × ${rupees(it.price)}` : '', claimers.length ? '' : 'Nobody yet'].filter(Boolean).join(' · ');
    const popping = pop.id === it.id && Date.now() < pop.until;
    return `
      <button class="item ${mine ? 'mine' : ''} ${claimers.length ? '' : 'unclaimed'} ${popping ? 'pop' : ''}" data-item="${it.id}" aria-pressed="${mine}" ${bill.locked ? 'aria-disabled="true"' : ''}>
        <span class="check" aria-hidden="true">${mine ? '✓' : ''}</span>
        <span class="info">
          <span class="name" style="display:block">${esc(it.name)}</span>
          ${meta ? `<span class="meta" style="display:block">${meta}</span>` : ''}
          ${mine && myShare && claimers.length > 1 ? `<span class="yours" style="display:block">Split ${claimers.length} ways · your part ${rupees(myShare.share)}</span>` : ''}
        </span>
        <span class="stack">${claimers.map((p) => avatar(p)).join('')}</span>
        <span class="price num">${rupees(line)}</span>
      </button>`;
  }

  function drawSummary() {
    const s = bill.split;
    const { personId } = me();
    const payer = personById(bill.payerId);
    const owed = s.settlements.filter((t) => !personById(t.fromId)?.paid).reduce((a, t) => a + t.amount, 0);

    const rows = s.persons.map((p) => {
      const person = personById(p.personId);
      const isPayer = p.personId === bill.payerId;
      let status = '';
      if (isPayer) status = '<span class="pill grey">Paid the bill</span>';
      else if (!p.total) status = '<span class="pill grey">Nothing yet</span>';
      else if (person.paid) status = '<span class="pill">Paid ✓</span>';
      else status = '<span class="pill warn-pill">Owes</span>';
      const canMark = !isPayer && p.total > 0 && (isAdmin() || p.personId === personId);
      return `
        <details class="person-row" ${p.personId === personId ? 'open' : ''}>
          <summary>
            ${avatar(person, 'lg')}
            <span class="who"><b>${esc(p.name)}${p.personId === personId ? '<span class="me-tag">you</span>' : ''}</b>${status}</span>
            <span class="amount num">${rupees(p.total)}</span>
            <span class="chev">▶</span>
          </summary>
          <div class="breakdown">
            ${p.items.map((x) => `<div><span>${esc(x.name)}${x.splitWith > 1 ? ` <span class="small">(÷${x.splitWith})</span>` : ''}</span><span class="num">${rupees(x.share)}</span></div>`).join('') || '<div>No items yet</div>'}
            ${p.tax + p.tip ? `<div><span>Tax &amp; service</span><span class="num">${rupees(p.tax + p.tip)}</span></div>` : ''}
            ${p.discount ? `<div><span>Discount</span><span class="num">${rupees(-p.discount)}</span></div>` : ''}
            <div class="total"><span>${isPayer ? 'Their share' : `Pays ${esc(payer.name)}`}</span><span class="num">${rupees(p.total)}</span></div>
            ${canMark ? `<div style="justify-content:flex-end;margin-top:6px"><button class="${person.paid ? 'ghost' : 'soft'}" data-paid="${p.personId}" data-value="${person.paid ? 0 : 1}" style="padding:7px 12px;font-size:.82rem">${person.paid ? 'Undo paid' : (isAdmin() && p.personId !== personId ? 'Mark as received' : "I've paid")}</button></div>` : ''}
          </div>
        </details>`;
    }).join('');

    return `
      <div class="card">
        ${s.unclaimed.length
          ? `<div class="warn"><span>⚠</span><span><b>${rupees(s.unclaimed.reduce((a, u) => a + u.amount, 0))} not claimed yet</b>: ${s.unclaimed.map((u) => esc(u.name)).join(', ')}. Totals go up once these are claimed.</span></div>`
          : `<div class="success">✓ Every item is claimed${owed ? `. ${esc(payer.name)} is owed ${rupees(owed)}` : ' and everyone has paid'}.</div>`}
        ${rows}
        ${isAdmin() ? `
          <div class="actions" style="margin-top:14px">
            <button class="${bill.locked ? 'ghost' : 'soft'}" id="lock" style="width:100%">${bill.locked ? '🔓 Reopen bill' : '🔒 Lock totals (stop changes)'}</button>
          </div>` : ''}
      </div>`;
  }

  function drawDock(you, actor) {
    const row = rowFor(actor.id);
    const total = row?.total || 0;
    const payer = personById(bill.payerId);
    let action = '';
    if (actor.id === bill.payerId) {
      action = bill.locked ? '' : '<button class="soft" id="share">Invite</button>';
    } else if (total > 0 && actor.paid) {
      action = '<span class="pill">Paid ✓</span>';
    } else if (total > 0 && bill.upiId && actor.id === you.id) {
      const url = `upi://pay?pa=${encodeURIComponent(bill.upiId)}&pn=${encodeURIComponent(payer.name)}&am=${(total / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(bill.title)}`;
      action = `<a class="btn" href="${esc(url)}">Pay via UPI</a>`;
    } else if (total === 0 && !bill.locked) {
      action = '<span class="muted small">Tap the items you had ↑</span>';
    }
    return `
      <div class="dock"><div class="dock-inner">
        <button class="mine-total" id="my-breakdown" aria-label="See breakdown">
          <span class="label">${actor.id === you.id ? 'Your share' : esc(actor.name) + "'s share"}${actor.id === bill.payerId ? '' : ` → ${esc(payer.name)}`}</span>
          <span class="amount num">${rupees(total)}<small>details ›</small></span>
        </button>
        ${action}
      </div></div>`;
  }

  function breakdownSheet() {
    const actor = personById(actingAs) || you; // a just-added friend may not have arrived via the live stream yet
    const row = rowFor(actingAs);
    const payer = personById(bill.payerId);
    const sheet = openSheet(actor.id === me().personId ? 'Your share' : `${actor.name}'s share`, `
      <div class="breakdown" style="padding:0;font-size:.95rem">
        ${row.items.map((x) => `<div><span>${esc(x.name)}${x.splitWith > 1 ? ` <span class="small">(shared by ${x.splitWith})</span>` : ''}</span><span class="num">${rupees(x.share)}</span></div>`).join('') || '<div>Nothing picked yet. Tap the items you had.</div>'}
        <div class="total" style="font-weight:600;color:var(--muted)"><span>Food</span><span class="num">${rupees(row.subtotal)}</span></div>
        <div><span>Tax &amp; service</span><span class="num">${rupees(row.tax + row.tip)}</span></div>
        <div><span>Discount</span><span class="num">${rupees(-row.discount)}</span></div>
        <div class="total" style="font-size:1.15rem"><span>Total</span><span class="num">${rupees(row.total)}</span></div>
      </div>
      <p class="muted small" style="margin:14px 0 0">Tax, service and discount are shared in proportion to your food (${bill.split.claimedTotal ? Math.round((row.subtotal / bill.split.claimedTotal) * 100) : 0}% of what's been claimed so far).${bill.payerId === actor.id ? '' : ` You pay this to ${esc(payer.name)}.`}</p>`);
    return sheet;
  }

  function settingsSheet() {
    const r = (p) => (p ? (p / 100).toString() : '');
    const sheet = openSheet('Edit bill', `
      <div class="field"><label for="s-title">Title</label><input id="s-title" value="${esc(bill.title)}" /></div>
      <div class="grid3 field">
        <div><label for="s-tax">Tax</label><input id="s-tax" value="${r(bill.tax)}" inputmode="decimal" placeholder="₹0" /></div>
        <div><label for="s-tip">Service / tip</label><input id="s-tip" value="${r(bill.tip)}" inputmode="decimal" placeholder="₹0" /></div>
        <div><label for="s-discount">Discount</label><input id="s-discount" value="${r(bill.discount)}" inputmode="decimal" placeholder="₹0" /></div>
      </div>
      <div class="field"><label for="s-upi">Your UPI ID</label><input id="s-upi" value="${esc(bill.upiId || '')}" placeholder="name@bank" /></div>
      <button id="s-save" class="block" style="margin-bottom:18px">Save changes</button>

      <h2>Items</h2>
      <div id="s-items" class="breakdown" style="padding:0;font-size:.9rem;margin-bottom:10px">
        ${bill.items.map((it) => `<div style="align-items:center"><span>${esc(it.name)} <span class="small">${it.qty > 1 ? '× ' + it.qty : ''}</span></span><span style="display:flex;align-items:center;gap:6px"><span class="num">${rupees(it.price * it.qty)}</span><button class="remove" data-del="${it.id}" aria-label="Remove ${esc(it.name)}">✕</button></span></div>`).join('')}
      </div>
      <label>Forgot something?</label>
      <div style="display:grid;grid-template-columns:1fr 56px 90px auto;gap:6px">
        <input id="n-name" placeholder="Item" /><input id="n-qty" value="1" inputmode="numeric" aria-label="Quantity" /><input id="n-price" placeholder="₹ each" inputmode="decimal" /><button id="n-add" class="soft">Add</button>
      </div>`);
    const admin = { 'x-admin-token': me().adminToken };
    sheet.$('#s-save').onclick = async () => {
      try {
        await api('PATCH', `/api/bills/${billId}`, {
          title: sheet.$('#s-title').value, tax: sheet.$('#s-tax').value, tip: sheet.$('#s-tip').value,
          discount: sheet.$('#s-discount').value, upiId: sheet.$('#s-upi').value,
        }, admin);
        sheet.close();
        toast('Saved');
      } catch (err) { toast(err.message); }
    };
    sheet.$('#n-add').onclick = async () => {
      try {
        await api('POST', `/api/bills/${billId}/items`, { name: sheet.$('#n-name').value, qty: sheet.$('#n-qty').value, price: sheet.$('#n-price').value }, admin);
        sheet.close();
        toast('Item added');
      } catch (err) { toast(err.message); }
    };
    sheet.$('#s-items').onclick = async (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      if (!confirm('Remove this item? Anyone who claimed it will lose it.')) return;
      try { await api('DELETE', `/api/bills/${billId}/items/${del.dataset.del}`, null, admin); del.closest('div[style]').remove(); }
      catch (err) { toast(err.message); }
    };
  }

  function addFriendSheet() {
    const sheet = openSheet('Add a friend', `
      <p class="muted small" style="margin-top:-6px">For someone who doesn't have their phone. You'll tap their items for them.</p>
      <div style="display:flex;gap:8px"><input id="f-name" placeholder="Their name" /><button id="f-add">Add</button></div>`);
    const add = async () => {
      const name = sheet.$('#f-name').value.trim();
      if (!name) return sheet.$('#f-name').focus();
      try {
        const { personId } = await api('POST', `/api/bills/${billId}/people`, { name });
        actingAs = personId;
        filter = 'all';
        sheet.close();
        if (personById(personId)) draw();
        toast(`Now tap ${name}'s items`);
      } catch (err) { toast(err.message); }
    };
    sheet.$('#f-add').onclick = add;
    sheet.$('#f-name').onkeydown = (e) => { if (e.key === 'Enter') add(); };
  }

  // Event delegation for the whole bill page
  $app.onclick = async (e) => {
    if (!bill || !me().personId) return;
    const t = e.target.closest('button, a');
    if (!t) return;
    try {
      if (t.dataset.item) {
        if (bill.locked) return toast('This bill is locked. Ask the payer to reopen it.');
        const itemId = +t.dataset.item;
        const nowMine = !t.classList.contains('mine');
        t.classList.toggle('mine', nowMine); // instant feedback; the live stream confirms
        t.querySelector('.check').textContent = nowMine ? '✓' : '';
        pop = { id: itemId, until: Date.now() + 350 };
        t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
        haptic();
        await api('POST', `/api/bills/${billId}/claims/toggle`, { itemId, personId: actingAs });
        return;
      }
      if (t.dataset.act && isAdmin()) { actingAs = +t.dataset.act; draw(); return; }
      if (t.dataset.filter) { filter = t.dataset.filter; draw(); return; }
      if (t.dataset.paid) {
        await api('POST', `/api/bills/${billId}/people/${t.dataset.paid}/paid`, { paid: t.dataset.value === '1' });
        return toast(t.dataset.value === '1' ? 'Marked as paid' : 'Marked as not paid');
      }
      if (t.id === 'share') return shareSheet(bill);
      if (t.id === 'settings') return settingsSheet();
      if (t.id === 'add-friend') return addFriendSheet();
      if (t.id === 'my-breakdown') return breakdownSheet();
      if (t.id === 'switch') { session.set(billId, { personId: null }); actingAs = null; window.scrollTo(0, 0); draw(); return; }
      if (t.id === 'lock') {
        await api('PATCH', `/api/bills/${billId}`, { locked: !bill.locked }, { 'x-admin-token': me().adminToken });
        return toast(bill.locked ? 'Bill reopened' : 'Locked. These totals are final.');
      }
    } catch (err) { toast(err.message); }
  };

  function drawJoin() {
    const payer = personById(bill.payerId);
    $app.className = '';
    $app.innerHTML = `
      <div class="card" style="margin-top:8px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          ${payer ? avatar(payer, 'lg') : ''}
          <div class="small muted"><b style="color:var(--text)">${esc(payer?.name)}</b> paid <b style="color:var(--text)">${rupees(bill.split.grandTotal)}</b> and wants to split it by item</div>
        </div>
        <h1>${esc(bill.title)}</h1>
        <p class="muted" style="margin-top:6px">Tell us who you are, then tap the dishes you had. No sign-up needed.</p>
        ${bill.locked ? '<div class="warn">🔒 This bill is locked, so new people can\'t join.</div>' : `
          <label for="join-name">Your name</label>
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <input id="join-name" placeholder="e.g. Bea" autocomplete="given-name" />
            <button id="join">Join →</button>
          </div>`}
        ${bill.people.length ? `
          <label>Already joined? Tap your name</label>
          <div class="people">${bill.people.map((p) => `<button class="chip" data-join="${p.id}">${avatar(p)} ${esc(p.name)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="section-title"><h2>On the bill</h2><span class="muted small">${plural(bill.items.length, 'item')}</span></div>
      <div class="items">${bill.items.map((it) => `
        <div class="item" style="cursor:default"><span class="info"><span class="name" style="display:block">${esc(it.name)}</span>${it.qty > 1 ? `<span class="meta" style="display:block">${it.qty} × ${rupees(it.price)}</span>` : ''}</span><span class="price num">${rupees(it.price * it.qty)}</span></div>`).join('')}
      </div>`;

    $app.onclick = async (e) => {
      const chip = e.target.closest('[data-join]');
      if (chip) { session.set(billId, { personId: +chip.dataset.join }); renderBill(billId); return; }
      if (e.target.id === 'join') {
        const name = document.getElementById('join-name').value.trim();
        if (!name) { toast('Enter your name'); document.getElementById('join-name').focus(); return; }
        try {
          const { personId } = await api('POST', `/api/bills/${billId}/people`, { name });
          session.set(billId, { personId });
          renderBill(billId);
          setTimeout(() => toast(`Hi ${name}! Tap everything you had.`), 200);
        } catch (err) { toast(err.message); }
      }
    };
    document.getElementById('join-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('join').click(); });
  }
}

render();
