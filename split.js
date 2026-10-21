// Pure bill-splitting logic. All money is handled in integer paise (1/100 of a rupee)
// so totals always add up exactly — no floating point drift.

/**
 * Split `total` into parts proportional to `weights`, guaranteeing the parts sum to `total`.
 * Uses the largest-remainder method for the leftover paise.
 */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i]++;
  return parts;
}

/**
 * Compute who owes what.
 * @param bill   { tax, tip, discount, payerId } amounts in paise
 * @param items  [{ id, name, price, qty }] price in paise (per unit)
 * @param people [{ id, name }]
 * @param claims [{ itemId, personId }]
 */
function computeSplit(bill, items, people, claims) {
  const byPerson = new Map(people.map((p) => [p.id, { personId: p.id, name: p.name, subtotal: 0, items: [] }]));
  const unclaimed = [];
  let itemsTotal = 0;
  let claimedTotal = 0;

  for (const item of items) {
    const lineTotal = item.price * item.qty;
    itemsTotal += lineTotal;
    const claimers = claims.filter((c) => c.itemId === item.id && byPerson.has(c.personId)).map((c) => c.personId);
    if (claimers.length === 0) {
      unclaimed.push({ itemId: item.id, name: item.name, amount: lineTotal });
      continue;
    }
    claimedTotal += lineTotal;
    // Sort so the extra paise always go to the same people deterministically.
    claimers.sort((a, b) => a - b);
    const shares = allocate(lineTotal, claimers.map(() => 1));
    claimers.forEach((pid, i) => {
      const entry = byPerson.get(pid);
      entry.subtotal += shares[i];
      entry.items.push({ itemId: item.id, name: item.name, share: shares[i], splitWith: claimers.length });
    });
  }

  // Tax, tip and discount are shared in proportion to what each person ordered.
  const persons = [...byPerson.values()];
  const weights = persons.map((p) => p.subtotal);
  const taxShares = allocate(bill.tax, weights);
  const tipShares = allocate(bill.tip, weights);
  const discountShares = allocate(bill.discount, weights);

  persons.forEach((p, i) => {
    p.tax = taxShares[i];
    p.tip = tipShares[i];
    p.discount = discountShares[i];
    p.total = p.subtotal + p.tax + p.tip - p.discount;
  });

  const grandTotal = itemsTotal + bill.tax + bill.tip - bill.discount;

  // Settle-up: everyone except the payer owes the payer their total.
  const settlements = persons
    .filter((p) => p.personId !== bill.payerId && p.total > 0)
    .map((p) => ({ fromId: p.personId, from: p.name, toId: bill.payerId, amount: p.total }));

  return {
    itemsTotal,
    claimedTotal,
    grandTotal,
    progress: itemsTotal === 0 ? 0 : claimedTotal / itemsTotal,
    unclaimed,
    persons,
    settlements,
  };
}

/**
 * Best-effort parser for receipt text pasted from a bill / SMS / OCR.
 * Recognises lines like "Paneer Tikka 2 x 180", "2 Cold Coffee 240.00", "Naan ..... 45".
 * Lines mentioning tax/GST/service/tip/discount are pulled out as extras, and the
 * printed subtotal is returned so the app can warn when the items don't add up.
 */
// Lines that end in a number but aren't food: table/bill numbers, card-machine details, contact info…
const NOT_FOOD = new RegExp('\\b(' + [
  'table', 'order\\s*(no|id)', 'bill\\s*no', 'invoice', 'receipt', 'token', 'kot', 'date', 'time', 'gstin', 'fssai',
  'phone', 'ph', 'tel', 'mob(ile)?', 'cashier', 'server', 'steward', 'waiter', 'guests?', 'covers?', 'pax', 'seat', 'emp',
  'batch', 'appr', 'approval', 'auth', 'trace', 'ref', 'rrn', 'tid', 'mid', 'terminal', 'term', 'txn', 'trans(action)?',
  'card', 'visa', 'master(card)?', 'amex', 'rupay', 'maestro', 'debit', 'credit', 'acct', 'account', 'upi', 'chk', 'check',
  'station', 'register', 'store', 'pin', 'zip',
].join('|') + ')\\b');
const LOOKS_LIKE_DATE_OR_TIME = /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}:\d{2}/;
const MASKED_CARD = /[x*]{3,}\s*\d{2,}/i;

function parseReceipt(text) {
  const extras = { tax: 0, tip: 0, discount: 0 };
  let subtotal = 0;
  const toPaise = (s) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);

  // Pass 1: every line that ends in an amount.
  const lines = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/[₹$€£]|\brs\.?|\binr\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const money = line.match(/(-?\d[\d,]*(?:\.\d{1,2})?)\s*$/);
    if (!line || !money) continue;
    const label = line.slice(0, money.index).replace(/[.\-:=]+\s*$/, '').trim();
    lines.push({ raw: line, label, lower: label.toLowerCase(), amount: toPaise(money[1]), decimal: /\.\d{2}$/.test(money[1]) });
  }

  // If most amounts on this receipt are written like "14.98", a bare "3483" is an ID, not a price.
  const decimalCount = lines.filter((l) => l.decimal).length;
  const decimalStyle = decimalCount >= 2 && decimalCount >= lines.length / 2;

  // Pass 2: sort lines into extras, totals and items.
  const items = [];
  for (const { raw, label, lower, amount, decimal } of lines) {
    if (raw.includes('#') || NOT_FOOD.test(lower) || LOOKS_LIKE_DATE_OR_TIME.test(raw) || MASKED_CARD.test(raw)) continue;
    if (/^sub\s*-?\s*total\b/.test(lower)) { subtotal = subtotal || amount; continue; }
    if (/^(total|grand total|net|amount|bill amount|balance|change|cash|paid|round(ing)?\s*off)\b/.test(lower)) continue;
    if (/(gst|cgst|sgst|igst|vat|tax)/.test(lower)) { extras.tax += Math.abs(amount); continue; }
    if (/(service|tip|gratuity)/.test(lower)) { extras.tip += Math.abs(amount); continue; }
    if (/(discount|offer|coupon|promo|savings|off\b)/.test(lower) || amount < 0) { extras.discount += Math.abs(amount); continue; }
    if (decimalStyle && !decimal) continue;
    if ((label.match(/[a-z]/gi) || []).length < 2) continue; // an item needs a real name

    // "Name 2 x 180" → qty 2, unit price 180
    let m = label.match(/^(.*?)\s*(\d+)\s*[x×*@]\s*$/i);
    if (m && m[1]) { items.push({ name: m[1].trim(), qty: +m[2], price: amount }); continue; }
    // "2 x Name 360" or "2 Name 360" → qty 2, line total 360
    m = label.match(/^(\d+)\s*[x×*]?\s+(.+)$/i);
    if (m && +m[1] > 0 && +m[1] < 50) {
      const qty = +m[1];
      items.push({ name: m[2].trim(), qty, price: Math.round(amount / qty) });
      continue;
    }
    items.push({ name: label, qty: 1, price: amount });
  }
  // OCR often lowercases the first letter ("paneer Tikka"), so tidy names up.
  for (const it of items) it.name = it.name.charAt(0).toUpperCase() + it.name.slice(1);
  return { items, ...extras, subtotal };
}

module.exports = { allocate, computeSplit, parseReceipt };
