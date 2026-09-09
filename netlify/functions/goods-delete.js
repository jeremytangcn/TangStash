// netlify/functions/goods-delete.js
//
// Removes one or more Goods records from the index. Same bulk-capable,
// single-read/single-write pattern as inventory-delete.js — see that
// file's header comment for exactly why a loop of single deletes is
// unsafe here (a real, confirmed bug on the TCG side: each single
// delete independently reads-filters-writes the WHOLE array, so rapid
// sequential calls can race and silently resurrect an item an earlier
// call just removed). Built bulk-safe from the start this time instead
// of learning that lesson twice.
//
// Usage: POST /.netlify/functions/goods-delete
//   body: { "id": "TS-A1B2C" }              (single)
//   body: { "ids": ["TS-A1B2C", "TS-D4E5F"] } (bulk)

const { connectLambda, getStore } = require("@netlify/blobs");

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
        error: ids.length === 1 ? `No item found with id ${ids[0]}` : "None of the given ids were found",
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
