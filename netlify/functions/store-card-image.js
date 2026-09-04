// netlify/functions/store-card-image.js
//
// Takes an image URL (typically the imageUrl returned by scrape-card.js)
// and a cardId, downloads the image bytes, and stores them in Netlify
// Blobs under our own key — so the app never hotlinks yuyu-tei's,
// toretoku's, or PriceCharting's CDN, and has its own durable copy.
//
// Usage: POST /.netlify/functions/store-card-image
//   body: { "imageUrl": "https://card.yuyu-tei.jp/opc/front/op01/10033.jpg",
//           "cardId": "op01-025-parallel-sr" }
//
// Returns: { blobKey, blobUrl, contentType, bytes }
//
// Image scrape priority (decided by the caller, not this function): when a
// card has more than one listing URL, try toretoku first, then yuyu-tei,
// then PriceCharting, and store whichever one succeeds first. This function
// only handles a single already-chosen imageUrl per call.
//
// Requires the "netlify-blobs" extension/package enabled on the site
// (npm install @netlify/blobs) — no separate credentials needed when
// running inside a Netlify deploy or `netlify dev`, since the runtime
// injects blob store access automatically.

const { connectLambda, getStore } = require("@netlify/blobs");
const { isAllowedImageUrl, imageFetchHeaders, refererForHost } = require("./lib/image-sources");

const STORE_NAME = "card-images";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB safety ceiling per image

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

  const { imageUrl, cardId } = body;
  if (!imageUrl || !cardId) {
    return respond(400, { error: "Both 'imageUrl' and 'cardId' are required" });
  }

  // Basic guard: only fetch images from hosts we actually scrape, so this
  // endpoint can't be used as an open image-fetching proxy for anything else.
  // See lib/image-sources.js for the allow-list and why PriceCharting's
  // host needs a path-prefix check on top of the hostname check.
  const check = isAllowedImageUrl(imageUrl);
  if (!check.allowed) {
    return respond(400, { error: check.reason });
  }
  const hostname = check.hostname;

  try {
    const imgRes = await fetch(imageUrl, {
      headers: imageFetchHeaders(refererForHost(hostname)),
    });

    if (!imgRes.ok) {
      return respond(502, { error: `Image fetch failed with ${imgRes.status}` });
    }

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return respond(422, { error: `Unexpected content-type: ${contentType}` });
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      return respond(413, { error: `Image too large (${buffer.byteLength} bytes)` });
    }

    const ext = contentType.split("/")[1]?.split("+")[0] || "jpg";
    const blobKey = `${cardId}.${ext}`;

    const store = getStore(STORE_NAME);
    await store.set(blobKey, buffer, {
      metadata: {
        sourceUrl: imageUrl,
        sourceHost: hostname,
        storedAt: new Date().toISOString(),
        contentType,
      },
    });

    // Served back out via serve-card-image.js (a small proxy function —
    // see that file for why a proxy was chosen over a direct Blob URL).
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
