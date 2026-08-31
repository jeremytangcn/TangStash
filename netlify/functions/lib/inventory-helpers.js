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
function computeListingStatus(record) {
  const hasPrice = record.purchasePrice !== null && record.purchasePrice !== undefined && record.purchasePrice !== "";
  const qty = Number(record.quantity) || 0;

  if (qty > 0 && hasPrice) return "Purchased";
  if (qty === 0 && hasPrice) return "Pending Delivery";
  return "Wanted";
}

module.exports = { generateListingUid, computeListingStatus };
