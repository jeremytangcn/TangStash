// netlify/functions/binders-save.js
//
// Create, rename, or delete a custom binder's metadata entry.
//
// Usage: POST /.netlify/functions/binders-save
//   Create: { "name": "For Trade" }
//     -> { key: "custom-a1b2c3", name: "For Trade", createdAt: "..." }
//   Rename: { "key": "custom-a1b2c3", "name": "New name" }
//   Delete: { "key": "custom-a1b2c3", "delete": true }
//
// NOTE: deleting a binder here only removes its entry from the switcher —
// it does NOT touch inventory records that have `binder.key` set to it.
// Those cards simply stop showing up anywhere until reassigned; this
// mirrors how "unassigning" already works (a card's `binder` field is
// just left stale). Good enough for a single-user personal app; revisit
// if that ever becomes confusing in practice.

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "tangstash-data";
const BINDERS_KEY = "binders-index";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Use POST" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const store = getStore(STORE_NAME);

  try {
    const existing = (await store.get(BINDERS_KEY, { type: "json" })) || [];

    if (body.delete && body.key) {
      const filtered = existing.filter((b) => b.key !== body.key);
      await store.setJSON(BINDERS_KEY, filtered);
      return respond(200, { binders: filtered });
    }

    if (body.key) {
      // Rename existing
      const idx = existing.findIndex((b) => b.key === body.key);
      if (idx === -1) return respond(404, { error: "Binder not found" });
      existing[idx] = { ...existing[idx], name: body.name || existing[idx].name };
      await store.setJSON(BINDERS_KEY, existing);
      return respond(200, { binder: existing[idx], binders: existing });
    }

    // Create new
    const name = (body.name || "").trim();
    if (!name) return respond(422, { error: "name is required" });

    const key = "custom-" + generateSuffix();
    const binder = { key, name, createdAt: new Date().toISOString() };
    const updated = [...existing, binder];
    await store.setJSON(BINDERS_KEY, updated);

    return respond(200, { binder, binders: updated });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function generateSuffix() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
