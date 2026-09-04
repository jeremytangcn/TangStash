// netlify/functions/translate-text.js
//
// Translates a short string (card names, mainly Japanese -> English) so
// Add Card can auto-fill an English "Name" field alongside the scraped
// original-language name.
//
// IMPORTANT CAVEAT: this calls Google Translate's unofficial
// `translate_a/single` endpoint — the same one the free "google-translate-api"
// style libraries use. It requires no API key and works well in practice
// for short strings, but it is NOT an official, versioned, or guaranteed-
// stable API: Google can change or block it without notice, and heavy
// use is against Google's Terms of Service. That's an acceptable
// trade-off for a personal app doing a handful of translations a day,
// but it is the first thing to suspect if this function starts failing
// outright — the fix at that point is switching to an official paid API
// (Google Cloud Translation or DeepL both have a free tier) and swapping
// out translateViaGoogle() below; nothing else in the app needs to change,
// since callers only care about this function's { translated } shape.
//
// Usage: GET /.netlify/functions/translate-text?text=<encoded text>&from=ja&to=en

exports.handler = async (event) => {
  const text = event.queryStringParameters && event.queryStringParameters.text;
  const from = (event.queryStringParameters && event.queryStringParameters.from) || "ja";
  const to = (event.queryStringParameters && event.queryStringParameters.to) || "en";

  if (!text || !text.trim()) {
    return respond(400, { error: "Missing required 'text' query parameter" });
  }
  if (text.length > 500) {
    return respond(400, { error: "Text too long (max 500 chars) — this is for card names, not full descriptions" });
  }

  try {
    const translated = await translateViaGoogle(text, from, to);
    if (translated == null) {
      return respond(502, { error: "Translation endpoint returned an unexpected response shape" });
    }
    return respond(200, { original: text, translated, from, to });
  } catch (err) {
    return respond(502, { error: `Translation failed: ${err.message}` });
  }
};

async function translateViaGoogle(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Upstream returned ${res.status}`);
  }

  const data = await res.json();
  // Response shape (undocumented, stable in practice): a nested array
  // where data[0] is an array of [translatedChunk, originalChunk, ...]
  // segments — join the translated chunks back into one string.
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const translated = data[0].map((segment) => (Array.isArray(segment) ? segment[0] : "")).join("");
  return translated || null;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
