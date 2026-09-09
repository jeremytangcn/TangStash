// netlify/functions/upload-card-image.js
//
// Stores a user-supplied image (e.g. a phone photo of a Slab's back,
// where there's no scrapeable listing to pull an image from) directly
// into the same `card-images` Blobs store store-card-image.js uses —
// same key scheme, same serve-card-image.js proxy serves it back out.
//
// Unlike store-card-image.js, this does NOT fetch from an external URL,
// so the host allow-list there doesn't apply/isn't needed here — the
// image bytes come from the user's own device via the browser's
// FileReader, base64-encoded into the request body.
//
// Usage: POST /.netlify/functions/upload-card-image
//   body: { "imageBase64": "<base64, no data: prefix>",
//           "contentType": "image/jpeg",
//           "cardId": "op01-025-parallel-sr-1" }
//
// Returns: { blobKey, blobUrl, contentType, bytes }

const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "card-images";
// Netlify Functions have a ~6MB request body ceiling (base64 inflates
// bytes by ~33%), so this is set well under that after base64 overhead —
// lower than store-card-image.js's 8MB since that one downloads directly
// server-side and never round-trips through a base64 JSON body.
const MAX_BYTES = 4 * 1024 * 1024; // 4MB raw (~5.3MB once base64-encoded)
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"];

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

  const { imageBase64, contentType, cardId } = body;
  if (!imageBase64 || !cardId) {
    return respond(400, { error: "Both 'imageBase64' and 'cardId' are required" });
  }

  const finalContentType = ALLOWED_CONTENT_TYPES.includes(contentType) ? contentType : "image/jpeg";

  let buffer;
  try {
    buffer = Buffer.from(imageBase64, "base64");
  } catch {
    return respond(400, { error: "imageBase64 could not be decoded" });
  }

  if (buffer.byteLength === 0) {
    return respond(400, { error: "Decoded image is empty" });
  }
  if (buffer.byteLength > MAX_BYTES) {
    return respond(413, { error: `Image too large (${buffer.byteLength} bytes, max ${MAX_BYTES})` });
  }

  try {
    const ext = finalContentType.split("/")[1]?.split("+")[0] || "jpg";
    const blobKey = `${cardId}.${ext}`;

    const store = getStore(STORE_NAME);
    await store.set(blobKey, buffer, {
      metadata: {
        source: "user-upload",
        storedAt: new Date().toISOString(),
        contentType: finalContentType,
      },
    });

    return respond(200, {
      blobKey,
      blobUrl: `/.netlify/functions/serve-card-image?key=${encodeURIComponent(blobKey)}`,
      contentType: finalContentType,
      bytes: buffer.byteLength,
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
