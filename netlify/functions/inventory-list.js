// netlify/functions/inventory-list.js
//
// Returns the entire inventory as one JSON array. There's deliberately no
// server-side filtering/sorting/pagination here — Netlify Blobs has no query
// engine, so the whole index blob is loaded and the app (public/app.js)
// filters and sorts it client-side, same pattern as the mockup.
//
// At ~2,000 records this stays comfortably fast; if the collection grows
// much larger than that, this is the first place that would need to change
// (e.g. splitting the index or adding a real query layer).
//
// Usage: GET /.netlify/functions/inventory-list

const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "tangstash-data";
const INDEX_KEY = "inventory-index";

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
