// netlify/functions/scrape-card.js
//
// Fetches a single yuyu-tei, toretoku, or PriceCharting product page and
// extracts { price, currency, imageUrl, cardName, cardNumber, rarity,
// condition }.
//
// Usage: GET /.netlify/functions/scrape-card?url=<encoded listing URL>
//
// Add more sites later by adding another entry to PARSERS - the site is
// auto-detected from the URL's hostname, so callers never need to say
// which parser to use.
//
// Pricing role of each site (decided at the app level, not enforced here -
// this function just returns raw scraped data per source):
//   - yuyu-tei / toretoku: primary market-price sources. Market price =
//     average of these two when both are available; if only one is
//     available, use that one alone.
//   - PriceCharting: last resort ONLY - used when neither yuyu-tei nor
//     toretoku data is available for a Single. For Slab (graded) listings,
//     PriceCharting's PSA10 price is used as the reference price instead
//     (see priceCharting.psa10 in this function's output), regardless of
//     yuyu-tei/toretoku availability, since those two sites rarely carry
//     graded slabs.
//   - toretoku condition ranks: when multiple rank rows exist, use the
//     best available in priority order S > A > B > C > D. The rank actually
//     used should be shown in parentheses in the UI (e.g. "Toretoku (Grade A)").

const cheerio = require("cheerio");

const PARSERS = {
  "yuyu-tei.jp": parseYuyuTei,
  "www.toretoku.jp": parseToretoku,
  "toretoku.jp": parseToretoku,
  "www.pricecharting.com": parsePriceCharting,
  "pricecharting.com": parsePriceCharting,
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
      headers: {
        // A plain browser-like UA. Be a polite bot - identify yourself if you
        // ever move this to a scheduled bulk job rather than on-demand clicks.
        "User-Agent":
          "Mozilla/5.0 (compatible; TangStash/1.0; personal collection tracker)",
        "Accept-Language": "ja,en;q=0.8",
      },
    });

    if (!res.ok) {
      return respond(502, {
        error: `Upstream returned ${res.status}`,
        source: hostname,
      });
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const data = parser($, url);

    if (!data.price && !data.psa10) {
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

// ---- Site-specific parsers ----------------------------------------------

function parseYuyuTei($) {
  // Price sits in a block like "#### 7,980 円" in the rendered page;
  // in the raw HTML it's the element with class containing "price".
  // Fall back to a text-scan for a "X,XXX円" pattern if the selector
  // ever drifts - cheap insurance against a markup change.
  let priceText = $(".price, [class*='Price']").first().text();
  if (!priceText) {
    const match = $("body").text().match(/([\d,]+)\s*円/);
    priceText = match ? match[0] : "";
  }
  const price = toNumber(priceText);

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
  // Toretoku shows one row per condition rank (S/A/B/C/D). We take the
  // best available rank (S > A > B > C > D priority) as the primary price
  // and return all rows so the caller can show the full breakdown and
  // display which rank was actually used, e.g. "Toretoku (Grade A)".
  const RANK_PRIORITY = ["S", "A", "B", "C", "D"];
  const rows = [];
  $("table tr, .price-row").each((_, el) => {
    const rowText = $(el).text();
    const priceMatch = rowText.match(/([\d,]+)\s*円/);
    const rankMatch = rowText.match(/^[ \t]*([SABCD])\b/);
    if (priceMatch) {
      rows.push({
        rank: rankMatch ? rankMatch[1] : null,
        price: toNumber(priceMatch[0]),
      });
    }
  });

  rows.sort((a, b) => {
    const ai = a.rank ? RANK_PRIORITY.indexOf(a.rank) : 99;
    const bi = b.rank ? RANK_PRIORITY.indexOf(b.rank) : 99;
    return ai - bi;
  });
  const best = rows[0] || null;
  const imageUrl = $("img[src*='itemMini']").first().attr("src") || null;
  const title = $("h1, h2").first().text().trim();
  const cardNumberEl = $("body").text().match(/OP\d{2}-\d{3}|ST\d{2}-\d{3}|EB\d{2}-\d{3}|P-\d{3}/);

  return {
    price: best ? best.price : null,
    currency: "JPY",
    imageUrl,
    cardName: title || null,
    cardNumber: cardNumberEl ? cardNumberEl[0] : null,
    condition: best ? best.rank : null, // e.g. "A" - show as "(Grade A)" in the UI
    conditionBreakdown: rows, // e.g. [{rank:'S', price:8200}, {rank:'A', price:7580}, ...]
  };
}

function parsePriceCharting($) {
  // PriceCharting shows a price table with columns like
  // Ungraded / Grade 7 / Grade 8 / Grade 9 / Grade 9.5 / PSA 10.
  // We only need two of these:
  //   - "Ungraded" -> used as the last-resort Singles price
  //   - "PSA 10"   -> used as the reference price for Slab listings
  // Selectors are unconfirmed (PriceCharting's table markup wasn't
  // available to test against), so this leans on a text-scan fallback
  // from the start - same pattern as the other parsers use as backup.
  const bodyText = $("body").text();

  const ungradedMatch = bodyText.match(/Ungraded[\s\S]{0,60}?\$([\d,.]+)/i);
  const psa10Match = bodyText.match(/PSA\s*10(?!\d)[\s\S]{0,60}?\$([\d,.]+)/i);

  const ungraded = ungradedMatch ? parseFloat(ungradedMatch[1].replace(/,/g, "")) : null;
  const psa10 = psa10Match ? parseFloat(psa10Match[1].replace(/,/g, "")) : null;

  // Prefer the og:image meta tag - PriceCharting's product photo is
  // usually hosted on a Google Cloud Storage bucket
  // (storage.googleapis.com/images.pricecharting.com/...), so the
  // downstream image-storage step must check the URL PATH, not just the
  // hostname, before allow-listing it (see store-card-image.js).
  const imageUrl = $('meta[property="og:image"]').attr("content") || null;

  const rawTitle = $("title").first().text();
  const cardName = rawTitle.split("Prices")[0].trim() || null;

  const cardNumberMatch = bodyText.match(/Card Number:\s*([^\n|]+)/i);
  const cardNumber = cardNumberMatch && !/none/i.test(cardNumberMatch[1]) ? cardNumberMatch[1].trim() : null;

  return {
    price: ungraded, // primary field, used for the "last resort" Singles case
    ungraded,
    psa10, // used as the Slab reference price, regardless of Singles/Slab role above
    currency: "USD", // NOTE: US-market pricing, not JPY - see role notes at top of file
    imageUrl,
    cardName,
    cardNumber,
    condition: null,
  };
}

function toNumber(text) {
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}
