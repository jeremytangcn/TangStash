// netlify/functions/store-external-image.js
//
// Stores an "additional photo" the user supplied as a pasted image link
// (e.g. a Slab back photo hosted on Imgur, Google Photos, etc.) — as
// opposed to store-card-image.js, which only fetches from the specific
// handful of sites this app scrapes, and upload-card-image.js, which
// takes the bytes directly from the user's device.
//
// Why this is deliberately MORE lenient than store-card-image.js's strict
// host allow-list: that allow-list exists because scraped image URLs come
// from parsing a listing page automatically — nothing chose to trust that
// specific URL, so it's worth restricting to known-safe hosts. A pasted
// "additional photo" link is different: the user explicitly typed or
// pasted it themselves, for their own card. Requiring it to also be on
// the scraper allow-list would make the feature useless for its stated
// purpose (a Slab's back photo isn't going to be hosted on Toretoku).
//
// This does still need SOME guardrails, since it's a URL-fetching
// endpoint reachable by anyone who has the site password:
//   - https:// only
//   - rejects obviously-internal/private hostnames (localhost, loopback,
//     link-local, private IP ranges) as a basic SSRF guard — not
//     exhaustive (a real defense needs DNS-resolution-time checking,
//     which a simple hostname-string check can't do), but blocks the
//     obvious cases
//   - same size cap as the other image-storage functions
//
// Usage: POST /.netlify/functions/store-external-image
//   body: { "imageUrl": "https://i.imgur.com/xxxxx.jpg", "cardId": "img-op01-025-..." }

const { connectLambda, getStore } = require("@netlify/blobs");
const { imageFetchHeaders } = require("./lib/image-sources");

const STORE_NAME = "card-images";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB, same ceiling as store-card-image.js (server-side fetch, no base64 body-size concern)

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^169\.254\./, // link-local / cloud metadata endpoints
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

exports.handler = async (event) => {
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

  const { imageUrl, cardId } = body;
  if (!imageUrl || !cardId) {
    return respond(400, { error: "Both 'imageUrl' and 'cardId' are required" });
  }

  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return respond(400, { error: "Invalid imageUrl" });
  }
  if (parsed.protocol !== "https:") {
    return respond(400, { error: "Only https:// image links are supported" });
  }
  if (BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    return respond(400, { error: "That host isn't allowed" });
  }

  try {
    // Referer set to the image's own origin — a generic, best-effort
    // guess for arbitrary user-pasted links (unlike store-card-image.js,
    // there's no fixed handful of known hosts to look up a specific
    // Referer for here). This is the exact failure mode
    // imageFetchHeaders()'s own docs describe: no Referer at all reads
    // as hotlink abuse to a lot of CDN/bucket-hosted image setups (S3
    // buckets serving a marketplace's product images are a common
    // example), which reject the request outright even though the
    // image is genuinely public. Same-origin is what most such checks
    // actually verify, so it doesn't need to be the literal referring
    // page — just the right domain.
    const imgRes = await fetch(imageUrl, { headers: imageFetchHeaders(parsed.origin + "/") });
    if (!imgRes.ok) {
      return respond(502, { error: `Couldn't fetch that image (upstream returned ${imgRes.status})` });
    }

    const contentType = imgRes.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return respond(400, { error: `That URL didn't return an image (got content-type: ${contentType || "unknown"})` });
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.byteLength === 0) {
      return respond(400, { error: "Downloaded image was empty" });
    }
    if (buffer.byteLength > MAX_BYTES) {
      return respond(413, { error: `Image too large (${buffer.byteLength} bytes, max ${MAX_BYTES})` });
    }

    const ext = contentType.split("/")[1]?.split("+")[0] || "jpg";
    const blobKey = `${cardId}.${ext}`;

    const store = getStore(STORE_NAME);
    await store.set(blobKey, buffer, {
      metadata: {
        source: "external-link",
        sourceUrl: imageUrl,
        storedAt: new Date().toISOString(),
        contentType,
      },
    });

    return respond(200, {
      blobKey,
      blobUrl: `/.netlify/functions/serve-card-image?key=${encodeURIComponent(blobKey)}`,
      contentType,
      bytes: buffer.byteLength,
      sourceUrl: imageUrl,
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
