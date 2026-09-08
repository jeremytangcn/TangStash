// netlify/functions/lib/blob-store.js
//
// Wraps @netlify/blobs' getStore() with an explicit siteID/token
// fallback for local development — this is the helper the project's own
// .env file already documents ("netlify/functions/lib/inventory-
// helpers.js's getBlobStore() will use them instead of relying on
// auto-injection"), which turned out to never actually exist in the
// code. That gap is a real, reported bug: local (`netlify dev`) and the
// live deployed site showed two different inventories despite running
// identical, freshly-pushed code.
//
// Why that happens: netlify dev is SUPPOSED to auto-inject Blobs access
// when running against a linked site, matching the live site's real
// store. When that auto-injection silently fails (the .env file already
// flags this as a known occurrence — "netlify dev doesn't always
// auto-inject Blobs access locally even on a linked site"), getStore()
// doesn't throw or warn; it falls back to a local-only, on-disk
// emulation instead. Every read/write still "works" from the app's
// point of view, just against a completely different, empty-or-stale
// dataset than the real one — with nothing surfacing that swap, so it
// looks exactly like a data sync problem rather than a connection
// fallback.
//
// Passing siteID/token explicitly (when present) connects to the SAME
// real store the live site uses, regardless of whether auto-injection
// happened to work that session. In production these env vars are
// unset — this fallback is local-dev-only, per .env's own comment — so
// getStore() is called exactly as it always was.
const { getStore } = require("@netlify/blobs");

function getBlobStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  return getStore(name);
}

module.exports = { getBlobStore };
