// netlify/functions/fx-rate.js
//
// Returns exchange rates for JPY/AUD/CNY(RMB)/MYR/USD -> SGD (your base
// reporting currency), cached in a blob and refreshed once every 24h so
// most requests don't hit the external API at all.
//
// Source: Frankfurter (frankfurter.dev) — free, no API key required.
// NOTE: Frankfurter doesn't cover every currency for every base; if RMB or
// MYR ever come back missing, that's the first thing to check.
//
// Usage: GET /.netlify/functions/fx-rate

const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "tangstash-data";
const CACHE_KEY = "fx-rate-cache";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TARGET_CURRENCIES = ["JPY", "AUD", "CNY", "MYR", "USD"]; // RMB = CNY
const BASE_CURRENCY = "SGD";

exports.handler = async (event) => {
  // Required for Netlify Blobs in classic ("Lambda compatibility mode")
  // functions — see binders-list.js for the full explanation. This
  // function previously took no `event` param at all since it didn't
  // need one otherwise; it's added here purely to have something to
  // pass to connectLambda().
  connectLambda(event);

  const store = getStore(STORE_NAME);

  try {
    const cached = await store.get(CACHE_KEY, { type: "json" });
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_MAX_AGE_MS) {
      return respond(200, { ...cached, cacheHit: true });
    }

    const url = `https://api.frankfurter.dev/v1/latest?base=${BASE_CURRENCY}&symbols=${TARGET_CURRENCIES.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) {
      // Fall back to a stale cache rather than fail outright, if we have one
      if (cached) return respond(200, { ...cached, cacheHit: true, stale: true });
      return respond(502, { error: `FX rate provider returned ${res.status}` });
    }

    const data = await res.json();
    const payload = {
      base: BASE_CURRENCY,
      rates: data.rates, // e.g. { JPY: 113.2, AUD: 1.11, ... } — units of that currency per 1 SGD
      fetchedAt: new Date().toISOString(),
    };
    await store.setJSON(CACHE_KEY, payload);

    return respond(200, { ...payload, cacheHit: false });
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
