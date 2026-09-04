// netlify/functions/inventory-delete.js
//
// Removes one card from the inventory index. Same "single blob, no query
// engine" pattern as inventory-list.js/inventory-save.js — read the
// whole array, filter, write it back.
//
// Usage: POST /.netlify/functions/inventory-delete
//   body: { "id": "TS-A1B2C" }
//
// Only supports deleting by a single id (matches the swipe-to-delete UI
// this was built for, one card at a time) — no bulk-delete endpoint
// exists yet; add one here if a future UI needs it rather than looping
// N single-delete calls from the client.
//
// NOTE: does not clean up the deleted card's stored image blob(s) — same
// accepted trade-off as elsewhere (see HANDOVER §18): orphaned blobs are
// cheap at this app's scale and there's no cleanup job built for them.

const { connectLambda, getStore } = require("@netlify/blobs");

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

  const { id } = body;
  if (!id) {
    return respond(400, { error: "'id' is required" });
  }

  try {
    const store = getStore(STORE_NAME);
    const existing = (await store.get(INDEX_KEY, { type: "json" })) || [];
    const filtered = existing.filter((r) => r.id !== id);

    if (filtered.length === existing.length) {
      return respond(404, { error: `No card found with id ${id}` });
    }

    await store.setJSON(INDEX_KEY, filtered);
    return respond(200, { deleted: id, count: filtered.length });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
