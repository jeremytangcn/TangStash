// netlify/functions/inventory-delete.js
//
// Removes one or more cards from the inventory index. Same "single blob,
// no query engine" pattern as inventory-list.js/inventory-save.js — read
// the whole array, filter, write it back.
//
// Usage: POST /.netlify/functions/inventory-delete
//   body: { "id": "TS-A1B2C" }              (single)
//   body: { "ids": ["TS-A1B2C", "TS-D4E5F"] } (bulk)
//
// Bulk deletes MUST go through `ids` in one call, not a loop of single
// `id` calls from the client — this was a real bug (not hypothetical):
// the xlsx import's "delete" marker feature originally looped single
// deletes, and each call independently does its own read-the-whole-
// array / filter / write-it-back. That's a read-modify-write race: if a
// later call's read doesn't yet reflect an earlier call's write (the
// underlying blob store isn't guaranteed to be instantaneously
// consistent for a get() immediately following a set()), the later
// call computes "existing minus mine" from a stale array that still
// has the earlier call's card in it, and silently resurrects it when
// it writes back. Reported symptom: importing a file that marked all
// 156 cards for deletion, the import reporting "156 deleted", and 76
// cards still being there after a refresh — consistent with roughly
// half the sequential calls racing each other. A single read + single
// write for the whole batch has no interleaving to race with.
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

  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : (body.id ? [body.id] : []);
  if (ids.length === 0) {
    return respond(400, { error: "'id' or 'ids' is required" });
  }

  try {
    const store = getStore(STORE_NAME);
    const existing = (await store.get(INDEX_KEY, { type: "json" })) || [];
    const idSet = new Set(ids);
    const filtered = existing.filter((r) => !idSet.has(r.id));
    const deletedCount = existing.length - filtered.length;

    if (deletedCount === 0) {
      return respond(404, {
        error: ids.length === 1 ? `No card found with id ${ids[0]}` : "None of the given ids were found",
      });
    }

    await store.setJSON(INDEX_KEY, filtered);
    return respond(200, {
      deleted: ids.length === 1 ? ids[0] : ids,
      deletedCount,
      count: filtered.length,
    });
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
