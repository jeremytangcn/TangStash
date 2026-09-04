// netlify/functions/lib/image-sources.js
//
// Shared between store-card-image.js (permanent storage) and
// preview-image-proxy.js (Add Card screen preview thumbnails, not
// stored). Keeping this in one place means the allow-list and the
// request headers can't drift out of sync between the two — which
// already happened once (store-card-image.js was still using the old
// self-identifying bot User-Agent after scrape-card.js was fixed to use
// a realistic one, silently risking the same block on the actual save
// step that scrape-card.js had on the fetch step).

// Sites we actually scrape images from. (PriceCharting was removed
// entirely — see the note at the top of scrape-card.js — so its Google
// Cloud Storage bucket entry, which needed an extra path-prefix check
// since the bare hostname is shared by countless unrelated buckets, is
// gone too.)
const ALLOWED_SOURCES = [
  { hostname: "card.yuyu-tei.jp" },
  { hostname: "www.toretoku.jp" },
  { hostname: "toretoku.jp" },
];

function isAllowedImageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  const allowed = ALLOWED_SOURCES.some(
    (src) => src.hostname === parsed.hostname && (!src.pathPrefix || parsed.pathname.startsWith(src.pathPrefix))
  );
  return allowed
    ? { allowed: true, hostname: parsed.hostname }
    : { allowed: false, reason: `Host/path not allowed: ${parsed.hostname}${parsed.pathname}` };
}

// A real browser User-Agent, matching scrape-card.js's buildHeaders() —
// several of these sites (confirmed: PriceCharting) reject requests that
// self-identify as a bot in this header.
//
// `refererOrigin`, when given, sets a Referer header matching the
// image's own site — added after diagnosing a real bug: images would
// silently fail to save whenever the fetch had no Referer at all, which
// is a very common CDN hotlink-protection check (the CDN accepts
// requests that look like they came from a page on its own site, and
// rejects everything else). Use refererForHost() below to get the right
// value for a given image URL's hostname.
function imageFetchHeaders(refererOrigin) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  };
  if (refererOrigin) headers.Referer = refererOrigin;
  return headers;
}

// Maps an image URL's hostname to the Referer that site's own CDN would
// expect (the page the image is actually embedded on, not the CDN
// subdomain itself). Returns undefined for anything not recognized —
// callers should just omit the header in that case rather than guess.
function refererForHost(hostname) {
  if (hostname.endsWith("yuyu-tei.jp")) return "https://yuyu-tei.jp/";
  if (hostname.endsWith("toretoku.jp")) return "https://www.toretoku.jp/";
  return undefined;
}

module.exports = { ALLOWED_SOURCES, isAllowedImageUrl, imageFetchHeaders, refererForHost };
