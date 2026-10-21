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
 * Lines mentioning tax/GST/service/tip/discount are pulled out as extras.
 */
function parseReceipt(text) {
  const items = [];
  const extras = { tax: 0, tip: 0, discount: 0 };
  const toPaise = (s) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/[₹$]|rs\.?|inr/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const money = line.match(/(-?\d[\d,]*(?:\.\d{1,2})?)\s*$/);
    if (!money) continue;
    const amount = toPaise(money[1]);
    const label = line.slice(0, money.index).replace(/[.\-:=]+\s*$/, '').trim();
    const lower = label.toLowerCase();

    // Header/footer lines that end in a number but aren't food: "Table 7", "Bill No 1234", "Guests 4"…
    if (/\b(table|order|bill\s*no|invoice|token|date|time|gstin|phone|ph|tel|mob(ile)?|cashier|server|steward|guests?|covers?|pax|kot)\b/.test(lower)) continue;
    if (/^(sub\s*total|total|grand total|net|amount|bill amount|round(ing)?\s*off)\b/.test(lower)) continue;
    if (/(gst|cgst|sgst|vat|tax)/.test(lower)) { extras.tax += Math.abs(amount); continue; }
    if (/(service|tip|gratuity)/.test(lower)) { extras.tip += Math.abs(amount); continue; }
    if (/(discount|offer|coupon|promo|off\b)/.test(lower) || amount < 0) { extras.discount += Math.abs(amount); continue; }

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
    if (label) items.push({ name: label, qty: 1, price: amount });
  }
  // OCR often lowercases the first letter ("paneer Tikka"), so tidy names up.
  for (const it of items) it.name = it.name.charAt(0).toUpperCase() + it.name.slice(1);
  return { items, ...extras };
}

module.exports = { allocate, computeSplit, parseReceipt };
