// netlify/functions/scrape-card.js
//
// Fetches a single yuyu-tei or toretoku product page and extracts
// { price, currency, imageUrl, cardName, cardNumber, condition }.
//
// Usage: GET /.netlify/functions/scrape-card?url=<encoded listing URL>
//
// Add more sites later by adding another entry to PARSERS - the site is
// auto-detected from the URL's hostname, so callers never need to say
// which parser to use.
//
// Pricing role of each site (decided at the app level, not enforced here -
// this function just returns raw scraped data per source):
//   - yuyu-tei / toretoku: the only two market-price sources. Market price
//     = average of these two when both are available; if only one is
//     available, use that one alone.
//   - toretoku condition ranks: when multiple rank rows exist, use the
//     best available in priority order S > A > B > C > D. The rank actually
//     used should be shown in parentheses in the UI (e.g. "Toretoku (Grade A)").
//
// REMOVED: PriceCharting (was the last-resort Singles source and the sole
// Slab/PSA10 reference price). PriceCharting was consistently blocking
// requests from Netlify's Functions infrastructure with a flat 403 —
// confirmed (via a separate fetch from a different network origin, see
// HANDOVER.md §16) to be an IP-level block, not a markup or header
// problem, so there was nothing left to fix on this side short of routing
// through a paid scraping proxy. Removed rather than left permanently
// broken. Slabs currently have no auto-scraped reference price as a
// result — see HANDOVER.md §18.

const cheerio = require("cheerio");

const PARSERS = {
  "yuyu-tei.jp": parseYuyuTei,
  "www.toretoku.jp": parseToretoku,
  "toretoku.jp": parseToretoku,
};

exports.handler = async (event) => {
  const url = event.queryStringParameters && event.queryStringParameters.url;

  if (!url) {
    return respond(400, { error: "Missing required 'url' query parameter" });
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return respond(400, { error: "Invalid URL" });
  }

  const parser = PARSERS[hostname];
  if (!parser) {
    return respond(400, {
      error: `Unsupported site: ${hostname}. Supported: ${Object.keys(PARSERS).join(", ")}`,
    });
  }

  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
    });

    if (!res.ok) {
      const hint = res.status === 403
        ? " (likely bot detection — the site rejected this request outright)"
        : "";
      return respond(502, {
        error: `Upstream returned ${res.status}${hint}`,
        source: hostname,
      });
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const data = parser($, url);

    // Previously: any listing where a price couldn't be parsed (most
    // commonly because it's out of stock — see the "muted prices" note
    // in the app's own UI, which already anticipates this) discarded
    // EVERYTHING, including a successfully-scraped image and card name.
    // That meant an out-of-stock Yuyu-tei listing came back as a total
    // failure — no thumbnail either — even though the page's image was
    // sitting right there in the same HTML. Only fail outright when
    // there's truly nothing usable at all.
    if (!data.price && !data.imageUrl && !data.cardName) {
      return respond(422, {
        error: "Could not parse a price from this page - site markup may have changed",
        source: hostname,
      });
    }

    return respond(200, { source: hostname, sourceUrl: url, ...data });
  } catch (err) {
    return respond(500, { error: err.message, source: hostname });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// A real browser User-Agent, not a self-identifying bot string. Some
// sites behind basic bot-detection block requests that self-identify as
// a bot in this header. Not a guarantee against anything backed by a
// real bot-detection service (e.g. Cloudflare's managed challenge, or an
// IP-range block like the one that got PriceCharting removed entirely —
// see the note at the top of this file) — there's no fix for those short
// of a headless browser or a paid scraping proxy.
function buildHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
  };
}

// ---- Site-specific parsers ----------------------------------------------

function parseYuyuTei($) {
  // Price sits in a block like "#### 7,980 円" in the rendered page;
  // in the raw HTML it's the element with class containing "price".
  // Fall back to a text-scan for a "X,XXX円" pattern if the selector
  // ever drifts - cheap insurance against a markup change. Verified
  // against a real listing (yuyu-tei.jp/sell/opc/card/promo-st10/10085).
  let priceText = $(".price, [class*='Price']").first().text();
  if (!priceText) {
    const match = $("body").text().match(/([\d,]+)\s*円/);
    priceText = match ? match[0] : "";
  }
  const price = toNumber(priceText);

  // Verified real image URL format: card.yuyu-tei.jp/opc/front/<set>/<id>.jpg
  const imageUrl = $("img[src*='card.yuyu-tei.jp']").first().attr("src") || null;

  const title = $("h1").first().text().trim();
  // Title format is like "P-SR ロロノア・ゾロ(パラレル) | 販売 | [OP01]..."
  const cardNumberMatch = $("body").text().match(/OP\d{2}-\d{3}|ST\d{2}-\d{3}|EB\d{2}-\d{3}|P-\d{3}/);

  return {
    price,
    currency: "JPY",
    imageUrl,
    cardName: title.split("|")[0].trim() || null,
    cardNumber: cardNumberMatch ? cardNumberMatch[0] : null,
    condition: null, // yuyu-tei listings here are single-condition (NM sell price)
  };
}

function parseToretoku($) {
  // Toretoku shows one row per condition rank (S/A/B/C/D) on most
  // listings, e.g. "A 4,280円" / "B 1,880円". Verified against a real
  // listing (toretoku.jp/item/details/171978) that this is NOT
  // necessarily inside a <table><tr> or a `.price-row`-classed element —
  // an earlier version of this parser assumed one of those and silently
  // found nothing on listings that use a div/grid layout instead.
  // Scanning the page's full visible text for the "<rank> <price>円"
  // pattern directly works regardless of the underlying markup, so
  // that's what this does now.
  //
  // We take the best available rank (S > A > B > C > D priority) as the
  // primary price and return all rows so the caller can show the full
  // breakdown and display which rank was actually used, e.g. "Toretoku
  // (Grade A)".
  const RANK_PRIORITY = ["S", "A", "B", "C", "D"];
  const bodyText = $("body").text();
  const rows = [];
  // Requires whitespace (or start-of-text) before the rank letter and at
  // least one whitespace char before the price, so this doesn't match a
  // stray S/A/B/C/D that happens to sit directly against unrelated
  // digits elsewhere on the page (nav text, product codes, etc.).
  const rowRegex = /(?:^|\s)([SABCD])\s+([\d,]+)\s*円/g;
  let match;
  while ((match = rowRegex.exec(bodyText)) !== null) {
    rows.push({ rank: match[1], price: toNumber(match[2]) });
  }

  rows.sort((a, b) => RANK_PRIORITY.indexOf(a.rank) - RANK_PRIORITY.indexOf(b.rank));
  let best = rows[0] || null;

  // Fallback: some listings — single-print promos especially — don't use
  // the ranked table at all, just one flat price with no rank column. If
  // the rank-scan above found nothing, fall back to a bare "X,XXX円"
  // text-scan anywhere on the page — same safety net parseYuyuTei() uses
  // above.
  if (!best) {
    const bodyMatch = bodyText.match(/([\d,]+)\s*円/);
    if (bodyMatch) best = { rank: null, price: toNumber(bodyMatch[0]) };
  }

  // Image: the og:image meta tag is far more reliable than an <img>
  // tag's src attribute — verified against two real listings that this
  // page's product image uses the same URL in both places, but an <img>
  // src can be lazy-loaded (real src only populated by client-side JS
  // this scraper never runs, with the initial HTML src empty or a
  // placeholder) while a meta tag is always present in the raw
  // server-rendered HTML regardless. Falls back to the <img> tag only if
  // the meta tag is somehow missing.
  const imageUrl = $('meta[property="og:image"]').attr("content")
    || $("img[src*='itemMini']").first().attr("src")
    || null;

  // Name: the page <title> is far more reliable than guessing at h1/h2
  // element order — verified against a real listing that this page's
  // actual <h1> is the SITE HEADER logo/nav text ("トレカ専門店トレトク
  // ワンピースカード販売"), not the card title, which is a lower <h2>
  // that comes after a huge category-navigation block. Title format is
  // consistently "【ワンピースカード】 <name> | トレカの激安通販 トレトク【公式】".
  const rawTitle = $("title").first().text().trim();
  const titleMatch = rawTitle.match(/^【[^】]*】\s*(.+?)\s*[|｜]/);
  const cardName = titleMatch ? titleMatch[1].trim() : (rawTitle.split(/[|｜]/)[0].trim() || null);

  const cardNumberEl = bodyText.match(/OP\d{2}-\d{3}|ST\d{2}-\d{3}|EB\d{2}-\d{3}|P-\d{3}/);

  return {
    price: best ? best.price : null,
    currency: "JPY",
    imageUrl,
    cardName,
    cardNumber: cardNumberEl ? cardNumberEl[0] : null,
    condition: best ? best.rank : null, // e.g. "A" - show as "(Grade A)" in the UI. null for flat-price/no-rank listings.
    conditionBreakdown: rows, // e.g. [{rank:'S', price:8200}, {rank:'A', price:7580}, ...] — empty array for flat-price listings.
  };
}

function toNumber(text) {
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}
