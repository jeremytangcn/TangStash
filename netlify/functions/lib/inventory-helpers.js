// netlify/functions/lib/inventory-helpers.js
//
// Small shared helpers used by inventory-save.js (and future functions
// that need to reason about a card's derived status).

function generateListingUid() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return "TS-" + suffix;
}

// Status is derived, never stored directly, per the rule:
//   quantity=1 & purchasePrice set     => Purchased
//   quantity=0 & purchasePrice set     => Pending Delivery
//   quantity=0 & no purchasePrice      => Wanted
//
// hasPrice checks Number.isFinite, not just "is it null/undefined/empty
// string" — found via a real bug: a malformed purchasePrice (e.g. the
// client parsing "¥35" with a bare Number(), which returns NaN) still
// passes a null/undefined/""-only check, since NaN isn't any of those.
// JSON has no representation for NaN either — JSON.stringify silently
// turns it into `null` before this function ever sees it, in most
// cases — but this guards the rare path where a non-finite number could
// still arrive here some other way (this function may end up used
// elsewhere someday), so a genuinely priced card can't silently fall
// back to "Wanted" from either direction.
function computeListingStatus(record) {
  const hasPrice = record.purchasePrice !== null && record.purchasePrice !== undefined && record.purchasePrice !== "" && Number.isFinite(Number(record.purchasePrice));
  const qty = Number(record.quantity) || 0;

  if (qty > 0 && hasPrice) return "Purchased";
  if (qty === 0 && hasPrice) return "Pending Delivery";
  return "Wanted";
}

module.exports = { generateListingUid, computeListingStatus };
