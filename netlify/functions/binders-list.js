// netlify/functions/binders-list.js
//
// Returns metadata for user-created custom binders (name + key), stored as
// one JSON array blob — same "single blob, no query engine" pattern as the
// inventory index. Main Collection, Pending Delivery, and Wanted are NOT
// stored here: Main is a built-in manual binder (key "main") that always
// exists, and Pending Delivery/Wanted are virtual (computed from
// inventory status), per HANDOVER.md §7.
//
// Usage: GET /.netlify/functions/binders-list

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "tangstash-data";
const BINDERS_KEY = "binders-index";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Use GET" });
  }

  try {
    const store = getStore(STORE_NAME);
    const raw = await store.get(BINDERS_KEY, { type: "json" });
    const binders = raw || [];
    return respond(200, { binders });
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
