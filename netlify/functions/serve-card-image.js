// netlify/functions/serve-card-image.js
//
// Streams a card image back out of the `card-images` Blobs store. This is
// the "small proxy function" option from HANDOVER.md §6 (chosen over a
// direct/public Blob URL, since Netlify Blobs doesn't expose a stable
// public URL without extra config, and a proxy keeps this working
// identically in `netlify dev` and in production).
//
// Usage: GET /.netlify/functions/serve-card-image?key=<imageBlobKey>
//
// Returns the raw image bytes with the content-type that was recorded
// when the image was stored (see store-card-image.js), plus a long cache
// lifetime since a given blobKey's bytes never change after being written
// (a re-scrape writes a new key, it doesn't mutate an old one).

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "card-images";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(405, "Use GET");
  }

  const key = event.queryStringParameters && event.queryStringParameters.key;
  if (!key) {
    return respond(400, "Missing required 'key' query parameter");
  }

  try {
    const store = getStore(STORE_NAME);
    const result = await store.getWithMetadata(key, { type: "arrayBuffer" });

    if (!result || !result.data) {
      return respond(404, "No image found for that key");
    }

    const contentType = (result.metadata && result.metadata.contentType) || "image/jpeg";
    const buffer = Buffer.from(result.data);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        // Immutable: a blobKey's bytes never change once written (a
        // re-scrape produces a new key), so cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return respond(500, err.message);
  }
};

function respond(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain" },
    body: message,
  };
}
