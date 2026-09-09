// netlify/functions/goods-list.js
//
// Returns the entire Goods (non-TCG merch) index as one JSON array.
// Same "no query engine, load the whole blob, filter client-side"
// pattern as inventory-list.js — see that file's comment for the full
// reasoning, it applies identically here.
//
// Deliberately a completely separate store key ("goods-index") from
// TCG's "inventory-index" — same underlying "tangstash-data" blob
// store (no need for a second store), but a different key means there
// is no code path, however buggy, that could ever mix the two
// datasets together. Goods and TCG cards are unrelated collections
// that happen to share one app.
//
// Usage: GET /.netlify/functions/goods-list

const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "tangstash-data";
const INDEX_KEY = "goods-index";

exports.handler = async (event) => {
  // Required for Netlify Blobs in classic ("Lambda compatibility mode")
  // functions — see binders-list.js for the full explanation.
  connectLambda(event);

  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Use GET" });
  }

  try {
    const store = getStore(STORE_NAME);
    const raw = await store.get(INDEX_KEY, { type: "json" });
    const records = raw || [];
    return respond(200, { records, count: records.length });
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
