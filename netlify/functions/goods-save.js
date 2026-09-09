// netlify/functions/goods-save.js
//
// Upserts Goods (non-TCG merch) record(s) into the single goods index
// blob. Same upsert-by-id, partial-success-per-record pattern as
// inventory-save.js — see that file's header comment for the full
// reasoning (in particular: a single invalid row in a batch no longer
// aborts the whole batch, it's just skipped and reported).
//
// Usage: POST /.netlify/functions/goods-save
//   body: a single record object, OR { records: [ ...record objects ] }
//         for bulk import (xlsx re-import, same idea as TCG's).
//
// Only "name" is required — there's no TCG-style "card number" concept
// here at all, so there's nothing to make optional-vs-required the way
// inventory-save.js had to for cardNumber.
//
// Status is derived the exact same way as TCG (computeListingStatus,
// shared from lib/inventory-helpers.js — it's a generic function, it
// only ever looks at quantity/purchasePrice, nothing TCG-specific):
//   quantity>0 & purchasePrice set  => Purchased
//   quantity=0 & purchasePrice set  => Pending Delivery
//   quantity=0 & no purchasePrice   => Wanted
// Quantity here is a true count (0, 1, 2, 3...), not a 0/1 flag — "own
// 3 of this cushion" is quantity=3 on one listing. The status rule
// above still works unchanged either way, since it only distinguishes
// zero from non-zero.

const { connectLambda, getStore } = require("@netlify/blobs");
const { generateListingUid, computeListingStatus } = require("./lib/inventory-helpers");

const STORE_NAME = "tangstash-data";
const INDEX_KEY = "goods-index";

exports.handler = async (event) => {
  // Required for Netlify Blobs in classic ("Lambda compatibility mode")
  // functions — see binders-list.js for the full explanation.
  connectLambda(event);

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Use POST" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const incoming = Array.isArray(body.records) ? body.records : [body];
  if (incoming.length === 0) {
    return respond(400, { error: "No record(s) provided" });
  }

  const store = getStore(STORE_NAME);

  try {
    const existing = (await store.get(INDEX_KEY, { type: "json" })) || [];
    const byId = new Map(existing.map((r) => [r.id, r]));

    const savedIds = [];
    const skipped = []; // { record, error } — an invalid row is skipped, not a whole-batch failure
    for (const rec of incoming) {
      const validation = validateRecord(rec);
      if (validation) {
        skipped.push({ record: rec, error: validation });
        continue;
      }

      const id = rec.id && byId.has(rec.id) ? rec.id : generateListingUid();
      const now = new Date().toISOString();
      const prior = byId.get(id);

      const merged = {
        ...prior,
        ...rec,
        id,
        quantity: Number(rec.quantity ?? prior?.quantity ?? 0),
        createdAt: prior?.createdAt || now,
        updatedAt: now,
      };
      merged.status = computeListingStatus(merged); // convenience field, recomputed every save

      byId.set(id, merged);
      savedIds.push(id);
    }

    const updatedList = Array.from(byId.values());
    await store.setJSON(INDEX_KEY, updatedList);

    return respond(200, { saved: savedIds, count: updatedList.length, skipped });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function validateRecord(rec) {
  if (!rec.name) return "name is required";
  if (rec.quantity !== undefined && (isNaN(Number(rec.quantity)) || Number(rec.quantity) < 0)) {
    return "quantity must be a non-negative number";
  }
  return null;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
