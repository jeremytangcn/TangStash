// netlify/functions/preview-image-proxy.js
//
// Streams back a scraped card image for the Add Card screen's live
// preview thumbnails, WITHOUT persisting it to Blobs (that only happens
// once the card is actually saved — see store-card-image.js) and
// without the browser hotlinking the source site directly.
//
// Why this exists: setting a result card's preview thumbnail directly to
// the scraped imageUrl (e.g. `background: url('https://www.toretoku.jp/...')`)
// means the BROWSER fetches that image straight from Toretoku's server,
// with the app's own domain as the referrer. Toretoku's image server
// appears to reject that (a common anti-hotlinking measure) — the price
// fetch would succeed but the preview thumbnail stayed blank, even
// though the same image saves correctly via store-card-image.js, whose
// fetch happens server-side and doesn't trigger the same block. Routing
// the preview through this function too means the browser only ever
// talks to our own domain for images, sidestepping that entirely.
//
// Usage: GET /.netlify/functions/preview-image-proxy?url=<encoded source image URL>

const { isAllowedImageUrl, imageFetchHeaders, refererForHost } = require("./lib/image-sources");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(405, "Use GET");
  }

  const url = event.queryStringParameters && event.queryStringParameters.url;
  if (!url) {
    return respond(400, "Missing required 'url' query parameter");
  }

  // Same allow-list as the permanent-storage path — this proxy can't be
  // used to fetch arbitrary images either.
  const check = isAllowedImageUrl(url);
  if (!check.allowed) {
    return respond(400, check.reason);
  }

  try {
    const res = await fetch(url, { headers: imageFetchHeaders(refererForHost(check.hostname)) });
    if (!res.ok) {
      return respond(502, `Upstream image fetch returned ${res.status}`);
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        // Short-lived cache — this is a live preview during Add Card,
        // not the permanent copy (that's serve-card-image.js, which
        // caches forever since its blobKeys never change once written).
        "Cache-Control": "public, max-age=300",
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return respond(502, `Image proxy failed: ${err.message}`);
  }
};

function respond(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain" },
    body: message,
  };
}
