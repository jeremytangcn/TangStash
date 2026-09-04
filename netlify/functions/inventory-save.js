// netlify/functions/inventory-save.js
//
// Upserts card record(s) into the single inventory index blob.
//
// Usage: POST /.netlify/functions/inventory-save
//   body: a single record object, OR { records: [ ...record objects ] }
//         for bulk import (e.g. re-importing the xlsx template).
//
// Upsert rule: if a record has an `id` (Listing UID) that matches an
// existing entry, that entry is replaced in place — this is what makes
// "fill in an existing UID to mass-update that listing" work from the
// import template. Records with no `id`, or an `id` that doesn't match
// anything existing, are treated as new and assigned a fresh UID.
//
// This function does NOT trigger scraping or price recalculation — it only
// persists whatever record shape it's given. Call scrape-card.js /
// store-card-image.js first if a record needs fresh price/image data.

const { connectLambda, getStore } = require("@netlify/blobs");
const { generateListingUid, computeListingStatus } = require("./lib/inventory-helpers");

const STORE_NAME = "tangstash-data";
const INDEX_KEY = "inventory-index";

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
    for (const rec of incoming) {
      const validation = validateRecord(rec);
      if (validation) {
        return respond(422, { error: validation, record: rec });
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

    return respond(200, { saved: savedIds, count: updatedList.length });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function validateRecord(rec) {
  if (!rec.cardName) return "cardName is required";
  if (!rec.cardNumber) return "cardNumber is required";
  if (rec.quantity !== undefined && ![0, 1, "0", "1"].includes(rec.quantity)) {
    return "quantity must be 0 or 1";
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
