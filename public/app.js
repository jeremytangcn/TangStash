// public/app.js
//
// Full frontend logic for TangStash. Everything (Dashboard, Inventory,
// Binder, Add Card, xlsx import) lives here now — the old inline <script>
// in index.html that ran on hardcoded mock data has been removed.
//
// Pricing formula (mirrors netlify/functions/scrape-card.js's documented
// roles, see HANDOVER.md §5.2):
//   Singles = average of Toretoku + Yuyu-tei (whichever are available).
//   Slabs   = no auto-scraped reference price (PriceCharting, the only
//             source for this, was removed — see HANDOVER.md §18).
//
// Currency: rawSources prices are always stored already-converted to SGD
// (the app's base reporting currency). The original-currency amount is
// kept in each source's `note` field for display, e.g. "(¥21,600)". The
// conversion happens once, at scrape/save time in the Add Card flow (see
// buildRawSourceEntry() below) — nothing re-converts on every render.

// Built as an absolute URL (not a bare relative path) — some mobile
// browsers/webviews (notably ones with an injected fetch monitor/proxy,
// e.g. certain in-app preview browsers) fail to resolve a relative fetch()
// target and throw a generic "The string did not match the expected
// pattern." TypeError. Using window.location.origin sidesteps that
// entirely and is a no-op change everywhere else.
const API_BASE = window.location.origin + "/.netlify/functions";

// ---- Global state --------------------------------------------------------

let inventoryRecords = [];
let customBinders = []; // [{ key, name, createdAt }]
let fxRates = null; // { base: "SGD", rates: { JPY, AUD, CNY, MYR, USD }, fetchedAt }
const currentFilters = { listing: "All", language: "All", set: "All", subset: "All", rarity: "All", conditionType: "All" };
let inventorySearchTerm = "";

// Display-only preference, persisted client-side (this is a real deployed
// site, not a sandboxed artifact — localStorage is fine here). Everything
// is still stored/computed internally in SGD (see the pricing note up
// top); this only changes what formatMoney() prints.
let displayCurrency = safeGetStorage("tangstash-display-currency") || "SGD";

function safeGetStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSetStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore — non-critical */ }
}

// Every image-storage call gets a fresh, unique cardId — deliberately
// NOT deterministic from cardNumber/record.id. Two different physical
// cards can share the same cardNumber (e.g. two "P" promos with no
// specific number), which would otherwise silently overwrite each
// other's stored image under the same blobKey. It also keeps
// serve-card-image.js's aggressive "cache forever" response header
// correct — a blobKey's bytes really do never change once written, so
// a refresh/re-upload always gets a brand new URL instead of fighting a
// stale cached response under a reused key (this was a real bug: an
// earlier version of the refresh feature reused a deterministic key
// per card specifically so refreshes would overwrite in place, which
// silently broke on any image that had ever been requested before,
// since the browser/CDN had it cached as "immutable, 1 year").
function uniqueImageId(base) {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return "img-" + String(base || "card").replace(/[^a-z0-9]/gi, "-").toLowerCase() + "-" + suffix;
}

// ---- Boot -----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  const currencySelect = document.getElementById("display-currency-select");
  if (currencySelect) currencySelect.value = displayCurrency;
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  updateThemeButtons(isLight ? "light" : "dark");

  await Promise.all([loadInventory(), loadBinders(), loadFxRates()]);
  renderDashboard();
  renderInventory();
  renderMainBinder();
  renderAutoBinders();
  renderCustomBinderSwitcher();
  setupBinderSwipe();
});

// Swipe support (pointer events cover touch + mouse drag) for whichever
// binder-page is currently visible — works for Main Collection and any
// custom binder, since both render inside a ".binder-view.active .binder-page".
//
// Swipe RIGHT (finger moves right, dx > 0) -> NEXT page. This matches
// the "turning a physical page forward" feel users expect for a binder,
// and is the opposite of a typical photo-gallery "swipe left to advance"
// convention — deliberately chosen to match explicit user feedback that
// swiping right should move forward, not back.
//
// No longer excludes gestures starting on a filled slot (attachSlotDragHandlers()
// used to own those exclusively) — that exclusion meant a swipe starting
// anywhere on a card, which is most of the visible grid, never reached
// this handler at all. Conflict with the drag-to-reposition feature is
// now resolved via slotDragEngaged instead: attachSlotDragHandlers()
// requires a brief hold before a drag arms (see its own comment), and
// sets slotDragEngaged only once a real drag is underway, checked below.
function setupBinderSwipe() {
  const screen = document.getElementById("screen-binder");
  if (!screen) return;
  let startX = null;
  screen.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".binder-page")) startX = e.clientX;
  });
  screen.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    if (slotDragEngaged) { startX = null; return; } // this gesture was a slot reposition, not a swipe
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 40) {
      const activeView = screen.querySelector(".binder-view.active");
      if (activeView) {
        const nextBtn = activeView.querySelector(".binder-nav-btn:last-of-type");
        const prevBtn = activeView.querySelector(".binder-nav-btn:first-of-type");
        const btn = dx > 0 ? nextBtn : prevBtn;
        if (btn && !btn.classList.contains("disabled")) btn.click();
      }
    }
    startX = null;
  });
}

async function loadInventory() {
  try {
    const data = await apiJson(`${API_BASE}/inventory-list`);
    inventoryRecords = data.records || [];
  } catch (err) {
    inventoryRecords = [];
    console.error("Failed to load inventory:", err);
  }
}

async function loadBinders() {
  try {
    const data = await apiJson(`${API_BASE}/binders-list`);
    customBinders = data.binders || [];
  } catch (err) {
    customBinders = [];
    console.error("Failed to load binders:", err);
  }
}

async function loadFxRates() {
  try {
    fxRates = await apiJson(`${API_BASE}/fx-rate`);
  } catch (err) {
    fxRates = null;
    console.error("Failed to load FX rates:", err);
  }
}

// Shared fetch wrapper: does the network call, safely parses the response
// body (JSON expected), and throws a clear, specific Error in every
// failure case — network failure, non-JSON body (e.g. an HTML error page
// from a proxy/CDN), or a JSON body with an `error` field. Every call
// site in this file goes through this instead of raw fetch()+res.json(),
// so error messages shown in the UI are always something you can act on
// rather than a generic browser-internal string.
async function apiJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error(`Couldn't reach the server (${err.name}: ${err.message}). Check your connection.`);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned an unexpected (non-JSON) response, status ${res.status}: ${text.slice(0, 150)}`);
  }

  if (!res.ok) {
    throw new Error(data.error || `Request failed (status ${res.status})`);
  }
  return data;
}

async function refreshAll() {
  await Promise.all([loadInventory(), loadBinders()]);
  renderDashboard();
  renderInventory();
  renderMainBinder();
  renderAutoBinders();
}

// ---- Currency conversion ---------------------------------------------------

// fxRates.rates gives "units of X per 1 SGD" (base=SGD). To convert an
// amount FROM currency X TO SGD: amount / rate[X].
//
// NOTE: the app's currency picker uses "RMB" (config/card-options.json)
// but the FX provider (fx-rate.js, Frankfurter) returns it under the ISO
// code "CNY" — same currency, different label. Normalize here so both work.
function fxCode(currency) {
  return currency === "RMB" ? "CNY" : currency;
}

function convertToSGD(amount, currency) {
  if (amount == null || amount === "") return null;
  const num = Number(amount);
  if (Number.isNaN(num)) return null;
  if (currency === "SGD") return num;
  const rate = fxRates && fxRates.rates && fxRates.rates[fxCode(currency)];
  if (!rate) return null; // no rate available — caller should handle null
  return num / rate;
}

// Inverse of convertToSGD: SGD -> any currency. Used only for *display*
// (formatMoney) — every internally-stored/computed amount stays in SGD.
function convertFromSGD(amountSGD, toCurrency) {
  if (amountSGD == null) return null;
  if (toCurrency === "SGD") return amountSGD;
  const rate = fxRates && fxRates.rates && fxRates.rates[fxCode(toCurrency)];
  if (!rate) return amountSGD; // no rate yet (e.g. FX still loading) — fall back to SGD rather than showing nothing
  return amountSGD * rate;
}

const CURRENCY_SYMBOLS = { JPY: "¥", USD: "$", SGD: "S$", AUD: "A$", RMB: "¥", MYR: "RM" };

function formatOriginal(amount, currency) {
  if (amount == null) return "";
  const symbol = CURRENCY_SYMBOLS[currency] || currency + " ";
  return symbol + Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- Pricing ---------------------------------------------------------------

function computeMarketPrice(record) {
  const src = record.rawSources || {};
  const isSlab = record.conditionType === "Slabs";

  if (isSlab) {
    // No auto-scraped reference price for Slabs — PriceCharting (PSA10)
    // was the only source for this and was removed (see HANDOVER §18).
    return { value: null, label: "No pricing source available for Slabs" };
  }

  const vals = [];
  if (src.toretoku?.price != null) vals.push(src.toretoku.price);
  if (src.yuyutei?.price != null) vals.push(src.yuyutei.price);

  if (vals.length) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const label = vals.length === 2 ? "Average of Toretoku + Yuyu-tei" : `From ${src.toretoku ? "Toretoku" : "Yuyu-tei"} only`;
    return { value: avg, label };
  }

  return { value: null, label: "No pricing data yet" };
}

// `valueSGD` is always an SGD amount (everything is computed/stored in
// SGD internally) — this is the one place that converts to whatever the
// user picked in Settings for display. Every currency always shows
// exactly 2 decimal places, JPY/RMB included, even on a whole-number
// amount (e.g. "¥680.00", not "¥680") — a deliberate consistency choice
// over the more conventional "JPY has no subunit" formatting this used
// to do.
function formatMoney(valueSGD) {
  if (valueSGD == null) return "—";
  const converted = convertFromSGD(valueSGD, displayCurrency);
  const symbol = CURRENCY_SYMBOLS[displayCurrency] || displayCurrency + " ";
  return symbol + converted.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setDisplayCurrency(currency) {
  displayCurrency = currency;
  safeSetStorage("tangstash-display-currency", currency);
  // Every money figure on screen needs re-rendering with the new currency
  // — cheapest correct way is just re-running the render passes, no
  // re-fetch needed since the underlying SGD data hasn't changed.
  renderDashboard();
  renderInventory();
  rerenderBinderScreen();
}

function setTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  safeSetStorage("tangstash-theme", theme);
  updateThemeButtons(theme);
}

function updateThemeButtons(activeTheme) {
  const darkBtn = document.getElementById("theme-btn-dark");
  const lightBtn = document.getElementById("theme-btn-light");
  if (!darkBtn || !lightBtn) return;
  darkBtn.style.background = activeTheme === "dark" ? "var(--gold)" : "var(--ink-3)";
  darkBtn.style.color = activeTheme === "dark" ? "#1a1300" : "var(--text)";
  lightBtn.style.background = activeTheme === "light" ? "var(--gold)" : "var(--ink-3)";
  lightBtn.style.color = activeTheme === "light" ? "#1a1300" : "var(--text)";
}

function openSettingsModal() {
  document.getElementById("settings-modal").classList.add("open");
}
function closeSettingsModal() {
  document.getElementById("settings-modal").classList.remove("open");
}

function purchasePriceSGD(record) {
  if (record.purchasePrice == null || record.purchasePrice === "") return null;
  return convertToSGD(record.purchasePrice, record.purchaseCurrency || "SGD");
}

// cardNumber like "OP07-119" -> { set: "OP", subset: "07" }; EB/ST follow
// the same shape; anything else (promos etc.) falls back to "Others".
function parseCardNumber(cardNumber) {
  const match = /^(OP|ST|EB)(\d{2})-/.exec(cardNumber || "");
  if (!match) return { set: "Others", subset: "" };
  return { set: match[1], subset: match[2] };
}

function imageUrlFor(record) {
  const keys = imageBlobKeysFor(record);
  if (keys.length) {
    return `${API_BASE}/serve-card-image?key=${encodeURIComponent(keys[0])}`;
  }
  return null;
}

// A record may have multiple images (e.g. a Slab's front + back). Stored
// as `imageBlobKeys` (array); `imageBlobKey` (singular) is kept in sync
// as `imageBlobKeys[0]` for older code/records that only know the
// single-image field.
function imageBlobKeysFor(record) {
  if (Array.isArray(record.imageBlobKeys) && record.imageBlobKeys.length) return record.imageBlobKeys;
  if (record.imageBlobKey) return [record.imageBlobKey];
  return [];
}

function imageUrlsFor(record) {
  return imageBlobKeysFor(record).map((key) => `${API_BASE}/serve-card-image?key=${encodeURIComponent(key)}`);
}

// ---- Dashboard --------------------------------------------------------------

// Every figure here is scoped to Purchased-status records unless noted
// otherwise (Pending Delivery gets its own separate figures) — this
// keeps "Total Purchase Value" (hero) equal to the with-market-value
// card's purchase total plus the without-market-value card's purchase
// total, so the two halves of the 1x2 grid always add back up to the
// headline number.
function renderDashboard() {
  const heroValueEl = document.getElementById("dash-hero-value");
  if (!heroValueEl) return; // dashboard not in DOM

  const purchased = inventoryRecords.filter((r) => r.status === "Purchased");
  const pending = inventoryRecords.filter((r) => r.status === "Pending Delivery");

  const withMarket = [];
  const withoutMarket = [];
  purchased.forEach((r) => {
    (computeMarketPrice(r).value != null ? withMarket : withoutMarket).push(r);
  });

  const sumPurchase = (list) => list.reduce((sum, r) => {
    const cost = purchasePriceSGD(r);
    return cost != null ? sum + cost : sum;
  }, 0);
  const sumMarket = (list) => list.reduce((sum, r) => {
    const v = computeMarketPrice(r).value;
    return v != null ? sum + v : sum;
  }, 0);

  const totalPurchaseValue = sumPurchase(purchased);
  const pendingValue = sumPurchase(pending);

  heroValueEl.textContent = formatMoney(totalPurchaseValue);
  setText("dash-hero-pending", "Pending Delivery: " + formatMoney(pendingValue));

  const mvPurchase = sumPurchase(withMarket);
  const mvMarket = sumMarket(withMarket);
  const mvProfit = mvMarket - mvPurchase;
  const totalCount = purchased.length || 1; // avoid divide-by-zero when the collection is empty
  const mvPct = Math.round((withMarket.length / totalCount) * 100);
  const nomvPct = Math.round((withoutMarket.length / totalCount) * 100);

  setText("dash-mv-purchase", formatMoney(mvPurchase));
  setText("dash-mv-market", formatMoney(mvMarket));
  const plEl = document.getElementById("dash-mv-pl");
  if (plEl) {
    plEl.textContent = (mvProfit >= 0 ? "+ " : "\u2212 ") + formatMoney(Math.abs(mvProfit));
    plEl.classList.toggle("down", mvProfit < 0);
  }
  setText("dash-mv-count", `${withMarket.length} card${withMarket.length === 1 ? "" : "s"} (${mvPct}%)`);

  setText("dash-nomv-purchase", formatMoney(sumPurchase(withoutMarket)));
  setText("dash-nomv-count", `${withoutMarket.length} card${withoutMarket.length === 1 ? "" : "s"} (${nomvPct}%)`);

  // Same Card Number + Card Name grouping key used on the Inventory
  // screen (see inventoryGroupKey) — "unique" means distinct physical
  // cards, not distinct listings, so multiple copies of the same card
  // still count once here.
  const uniqueCards = new Set(purchased.map(inventoryGroupKey)).size;
  const englishCards = purchased.filter((r) => r.language === "English").length;
  const japaneseCards = purchased.filter((r) => r.language === "Japanese").length;
  const slabsGraded = purchased.filter((r) => r.conditionType === "Slabs").length;

  setText("dash-stat-total", purchased.length);
  setText("dash-stat-unique", uniqueCards);
  setText("dash-stat-english", englishCards);
  setText("dash-stat-japanese", japaneseCards);
  setText("dash-stat-slabs", slabsGraded);
  setText("dash-stat-pending", pending.length);

  const recentlyAdded = [...inventoryRecords]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 5);
  renderDashRows("dash-recent", recentlyAdded, (r) => formatMoney(computeMarketPrice(r).value));
}

function renderDashRows(containerId, records, valueFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (records.length === 0) {
    container.innerHTML = `<div class="inv-loading" style="margin:0 22px 14px;">Nothing here yet.</div>`;
    return;
  }
  container.innerHTML = records.map((r) => dashRowHtml(r, valueFn(r))).join("");
}

function dashRowHtml(record, valueText) {
  const img = imageUrlFor(record);
  const thumb = img
    ? `<div class="thumb" style="background-image:url('${escapeAttr(img)}'); background-size:cover; background-position:center;"></div>`
    : `<div class="thumb"></div>`;
  return `
    <div class="row-card" onclick="showPriceBreakdownFor('${escapeAttr(record.id)}')" style="cursor:pointer;">
      ${thumb}
      <div>
        <div class="row-title">${escapeHtml(record.cardName)}</div>
        <div class="row-sub">${escapeHtml(record.cardNumber)}${record.rarity ? " · " + escapeHtml(record.rarity) : ""}</div>
      </div>
      <div class="row-value"><div class="amt">${escapeHtml(valueText)}</div></div>
    </div>
  `;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ---- Inventory --------------------------------------------------------------

// Groups sharing a card number don't get their own expand state cleared
// on every re-render (search typing, filter changes, refreshAll after a
// swipe action) — a plain Set of card numbers, so it naturally persists
// across renderInventory() calls the same way currentFilters/inventorySearchTerm do.
let expandedInventoryGroups = new Set();

function toggleInventoryGroup(groupKey) {
  if (expandedInventoryGroups.has(groupKey)) expandedInventoryGroups.delete(groupKey);
  else expandedInventoryGroups.add(groupKey);
  renderInventory();
}

// Card Number + Card Name — tightened from Card Number alone so
// same-numbered cards with genuinely different names (misc promos,
// re-releases, whatever else shares a number) don't get lumped
// together; same number AND same name is what actually means "the same
// physical card, filed as multiple listings."
// Card Number + Card Name — tightened from Card Number alone so
// same-numbered cards with genuinely different names (misc promos,
// re-releases, whatever else shares a number) don't get lumped
// together; same number AND same name is what actually means "the same
// physical card, filed as multiple listings." The "::" separator (not
// "\u0000") is load-bearing: this key gets embedded in an onclick
// attribute and set via innerHTML, and a literal null byte gets
// replaced/stripped during HTML parsing — so the key added to
// expandedInventoryGroups on click stopped matching the key freshly
// computed on the next render, and groups silently never showed as
// expanded. "::" is a normal printable string, so it round-trips
// through HTML/innerHTML exactly as written.
// Card Number + Card Name + Artist + Language — tightened again from
// Card Number + Card Name alone: two listings can share both of those
// yet still be genuinely different prints (a reprint with a different
// artist credit, or the same card in two languages), so those two
// fields join the key too. Same physical card, filed as multiple
// listings, is what should still land in one group.
function inventoryGroupKey(record) {
  return [record.cardNumber, record.cardName, record.artist, record.language]
    .map((v) => String(v ?? ""))
    .join("::");
}

function renderInventory() {
  const listEl = document.getElementById("inv-list");
  if (!listEl) return;

  const filtered = inventoryRecords.filter(matchesFilters).filter(matchesSearch);
  const sorted = filtered.sort((a, b) => {
    const numCompare = String(a.cardNumber).localeCompare(String(b.cardNumber));
    if (numCompare !== 0) return numCompare;
    const priceA = computeMarketPrice(a).value ?? 0;
    const priceB = computeMarketPrice(b).value ?? 0;
    return priceA - priceB;
  });

  if (sorted.length === 0) {
    listEl.innerHTML = `<div class="inv-loading">No cards match these filters yet.</div>`;
    return;
  }

  // Group by Card Number + Card Name (not rarity/foil/language — still
  // a deliberate choice: this groups every physical copy filed under
  // the same number AND name, variants included). A group of one
  // renders exactly like an ungrouped row always has; only 2+ get the
  // group-header treatment, so a collection with no duplicates looks
  // completely unchanged.
  const groups = new Map();
  sorted.forEach((r) => {
    const key = inventoryGroupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  listEl.innerHTML = [...groups.values()].map((group) =>
    group.length > 1 ? renderInventoryGroup(group) : renderInventoryRow(group[0])
  ).join("");
  attachAllSwipeHandlers();
}

// Header row for a group of 2+ listings sharing a Card Number + Card
// Name — tap to expand/collapse the individual listings beneath it
// (each rendered with the exact same renderInventoryRow() used
// everywhere else, so swipe-to-delete/clone, tap-for-detail, and the
// status badge all keep working unchanged once expanded). The header
// itself isn't swipeable and doesn't open a detail sheet — there's no
// single record to show; tapping it only toggles the group.
function renderInventoryGroup(group) {
  const groupKey = inventoryGroupKey(group[0]);
  const cardNumber = String(group[0].cardNumber);
  const isExpanded = expandedInventoryGroups.has(groupKey);
  const firstImg = imageUrlFor(group[0]);
  const thumbInner = firstImg
    ? `<img src="${escapeAttr(firstImg)}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:5px;">`
    : "";

  const statusCounts = {};
  group.forEach((r) => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
  const statusText = ["Purchased", "Pending Delivery", "Wanted"]
    .filter((s) => statusCounts[s])
    .map((s) => `${statusCounts[s]} ${s}`)
    .join(", ");

  const totalValue = group.reduce((sum, r) => {
    const v = computeMarketPrice(r).value;
    return v != null ? sum + v : sum;
  }, 0);

  return `
    <div class="inv-group-wrap" style="margin:0 22px 10px;">
      <div class="inv-item inv-group-header" onclick="toggleInventoryGroup('${escapeAttr(groupKey)}')">
        <div class="inv-thumb">${thumbInner}<span class="inv-group-count-badge">×${group.length}</span></div>
        <div class="inv-mid">
          <div class="inv-name">${escapeHtml(group[0].cardName)}</div>
          <div class="inv-meta">${escapeHtml(cardNumber)} · ${escapeHtml(statusText)}</div>
        </div>
        <div class="inv-right">
          <div class="inv-price">${formatMoney(totalValue)}</div>
          <div class="inv-group-chevron${isExpanded ? " open" : ""}">▾</div>
        </div>
      </div>
      ${isExpanded ? `<div class="inv-group-members">${group.map((r) => renderInventoryRow(r, true)).join("")}</div>` : ""}
    </div>
  `;
}

function renderInventoryRow(record, nested) {
  const purchase = purchasePriceSGD(record);
  const purchaseText = purchase != null ? formatMoney(purchase) : "—";
  const market = computeMarketPrice(record);
  const marketText = market.value != null ? formatMoney(market.value) : "—";
  const { set, subset } = parseCardNumber(record.cardNumber);
  const qtyBadge =
    record.status === "Wanted" ? "On wishlist" :
    record.status === "Pending Delivery" ? "Pending arrival" :
    "×1 copy"; // v1: quantity is a 0/1 received-flag per row, not a multi-copy count

  const img = imageUrlFor(record);
  const thumbInner = img
    ? `<img src="${escapeAttr(img)}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:5px;">`
    : "";

  // Nested (inside an expanded inv-group-members list) skips .swipe-row's
  // own 22px side margins — .inv-group-wrap/.inv-group-members already
  // provide the screen-edge margin and indent, so applying both would
  // double up and push these rows too far right.
  const rowStyle = nested ? ` style="margin:0 0 8px;"` : "";

  return `
    <div class="swipe-row"${rowStyle}>
      <div class="swipe-action swipe-action-left" onclick="cloneInventoryCard('${escapeAttr(record.id)}')">
        <span class="swipe-action-icon">⧉</span><span>Clone</span>
      </div>
      <div class="swipe-action swipe-action-right" onclick="confirmDeleteInventoryCard('${escapeAttr(record.id)}')">
        <span class="swipe-action-icon">🗑</span><span>Delete</span>
      </div>
      <div class="inv-item swipe-content"
           data-row-id="${escapeAttr(record.id)}"
           data-listing="${escapeAttr(record.status)}"
           data-language="${escapeAttr(record.language)}"
           data-set="${escapeAttr(set)}"
           data-subset="${escapeAttr(subset)}"
           data-rarity="${escapeAttr(record.rarity)}"
           onclick="handleInventoryRowClick('${escapeAttr(record.id)}')">
        <div class="inv-thumb">${thumbInner}<span class="rarity-tag">${escapeHtml(record.rarity || "")}</span></div>
        <div class="inv-mid">
          <div class="inv-name">${escapeHtml(record.cardName)}</div>
          <div class="inv-meta">${escapeHtml(record.cardNumber)} · ${escapeHtml(record.language || "")} · ${escapeHtml(record.category || "")}</div>
          <div class="inv-qty-badge">${qtyBadge}</div>
        </div>
        <div class="inv-right">
          <div class="price-line">
            <div class="inv-price">${purchaseText}</div>
            <div class="info-btn" onclick="event.stopPropagation(); showPriceBreakdownFor('${escapeAttr(record.id)}')">?</div>
          </div>
          <div class="inv-price-sub">${marketText}</div>
        </div>
      </div>
    </div>
  `;
}

// ---- Inventory: swipe left (delete) / swipe right (clone) -----------------
// Pointer events, same technique as the binder drag-to-reposition feature —
// native HTML5 drag doesn't fire reliably for touch on mobile Safari.

const SWIPE_ACTION_WIDTH = 84; // must match .swipe-action's CSS width
let openSwipeRowId = null;

// Set whenever a horizontal drag gesture (axis === 'x') actually happens,
// regardless of whether it settled open or snapped back closed. Needed
// because a pointerdown+pointermove+pointerup sequence on the SAME
// element still fires a trailing "click" event afterward (that's just
// how click events work for mouse, and mobile browsers don't reliably
// suppress it either without preventDefault at exactly the right spot) —
// without this flag, that click reaches handleInventoryRowClick() right
// after finish() opens the row, and since openSwipeRowId now matches,
// it immediately closes what was just revealed. One flag, cleared the
// first time it's consulted, swallows exactly that one trailing click
// without affecting a genuine plain tap (which never sets it, since
// axis never leaves null for a tap).
let suppressRowClick = false;

function attachAllSwipeHandlers() {
  document.querySelectorAll("#inv-list .swipe-content").forEach((el) => attachSwipeHandlers(el));
}

function attachSwipeHandlers(contentEl) {
  const rowId = contentEl.dataset.rowId;
  let startX = null;
  let startY = null;
  let baseX = 0; // translateX when this drag started (0, +WIDTH, or -WIDTH)
  let axis = null; // 'x' | 'y' | null (undecided) — set once movement clears a small threshold

  contentEl.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startY = e.clientY;
    baseX = contentEl.dataset.openState === "left" ? SWIPE_ACTION_WIDTH : contentEl.dataset.openState === "right" ? -SWIPE_ACTION_WIDTH : 0;
    axis = null;
    contentEl.style.transition = "none";
  });

  contentEl.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // not enough movement yet to decide
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (axis === "x") {
        contentEl.setPointerCapture(e.pointerId);
        if (openSwipeRowId && openSwipeRowId !== rowId) closeSwipeRow(openSwipeRowId);
      }
    }
    if (axis !== "x") return; // vertical drag — let the page scroll normally
    e.preventDefault();
    const next = Math.max(-SWIPE_ACTION_WIDTH, Math.min(SWIPE_ACTION_WIDTH, baseX + dx));
    contentEl.style.transform = `translateX(${next}px)`;
  });

  const finish = (e) => {
    if (startX === null) return;
    contentEl.style.transition = "transform 0.2s ease";
    if (axis === "x") {
      const dx = e.clientX - startX;
      const settled = baseX + dx;
      if (settled > SWIPE_ACTION_WIDTH / 2) {
        contentEl.style.transform = `translateX(${SWIPE_ACTION_WIDTH}px)`;
        contentEl.dataset.openState = "left";
        openSwipeRowId = rowId;
      } else if (settled < -SWIPE_ACTION_WIDTH / 2) {
        contentEl.style.transform = `translateX(-${SWIPE_ACTION_WIDTH}px)`;
        contentEl.dataset.openState = "right";
        openSwipeRowId = rowId;
      } else {
        contentEl.style.transform = "translateX(0px)";
        contentEl.dataset.openState = "";
        if (openSwipeRowId === rowId) openSwipeRowId = null;
      }
      suppressRowClick = true;
    }
    startX = null;
    startY = null;
    axis = null;
  };

  contentEl.addEventListener("pointerup", finish);
  contentEl.addEventListener("pointercancel", finish);
}

// ---- Modal backdrops: robust "tap outside to dismiss" ----------------------
// A plain `onclick="if (event.target===this) close()"` on a backdrop
// isn't enough for every modal in this app: the price-breakdown modal can
// be opened from attachSlotDragHandlers()'s pointerup handler (a plain
// tap on a binder slot), not from a click handler. The browser still
// fires a trailing "click" event right after that pointerup, at the same
// screen coordinates — but by then the modal is already open, so the
// backdrop (now covering the whole screen) is the topmost element AT
// those coordinates, making it the click's target. That click looks
// identical to a genuine "tap outside to dismiss" and immediately closes
// the modal that had just opened (bug: tapping a binder card appeared to
// do nothing, since open-then-instantly-close happens within one tap).
// Fix: only dismiss when the POINTERDOWN that started this click also
// landed on the backdrop itself, not just the click's target — a
// deliberate tap-outside always starts and ends on the backdrop, but this
// ghost click starts on a binder slot and only ends on the backdrop.
function armBackdropDismiss(e) {
  e.currentTarget.dataset.armedDismiss = (e.target === e.currentTarget) ? "1" : "";
}
function dismissBackdropIfArmed(e, closeFn) {
  const armed = e.currentTarget.dataset.armedDismiss === "1";
  e.currentTarget.dataset.armedDismiss = "";
  if (e.target === e.currentTarget && armed) closeFn();
}

// ---- Full-screen photo viewer: pinch-to-zoom + pan + double-tap -----------
// Deliberately built on raw Pointer Events rather than the browser's
// native pinch-zoom (which touch-action:none on the <img> disables) —
// native pinch would zoom the whole page/viewport, not just the photo,
// and wouldn't compose with the tap-outside-to-close backdrop.
let imgZoom = { scale: 1, x: 0, y: 0 };
const IMG_ZOOM_MAX = 4;
const imgViewerPointers = new Map(); // pointerId -> {x, y}, only while the viewer is open
let imgPinchStartDist = null;
let imgPinchStartScale = 1;
let imgPanAnchor = null; // {x, y, originX, originY} — set whenever exactly one pointer is down and scale > 1
let imgLastTapAt = 0;

function openImageViewer(url) {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img");
  if (!modal || !img) return;
  img.src = url;
  imgZoom = { scale: 1, x: 0, y: 0 };
  applyImgZoom();
  attachImageViewerHandlers();
  modal.classList.add("open");
  const hint = document.getElementById("image-viewer-hint");
  if (hint) { hint.style.opacity = "1"; setTimeout(() => { hint.style.opacity = "0"; }, 2200); }
}

function closeImageViewer() {
  const modal = document.getElementById("image-viewer-modal");
  if (modal) modal.classList.remove("open");
  const img = document.getElementById("image-viewer-img");
  if (img) img.src = "";
  imgViewerPointers.clear();
  imgPinchStartDist = null;
  imgPanAnchor = null;
}

function applyImgZoom() {
  const img = document.getElementById("image-viewer-img");
  if (img) img.style.transform = `translate(${imgZoom.x}px, ${imgZoom.y}px) scale(${imgZoom.scale})`;
}

function attachImageViewerHandlers() {
  const img = document.getElementById("image-viewer-img");
  if (!img || img.dataset.zoomWired) return; // wire once — src changes on every open, listeners don't need to
  img.dataset.zoomWired = "1";

  img.addEventListener("pointerdown", (e) => {
    img.setPointerCapture(e.pointerId);
    imgViewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (imgViewerPointers.size === 2) {
      const pts = [...imgViewerPointers.values()];
      imgPinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      imgPinchStartScale = imgZoom.scale;
      imgPanAnchor = null; // a second finger landing mid-pan hands off to pinch instead
    } else if (imgViewerPointers.size === 1) {
      const p = imgViewerPointers.get(e.pointerId);
      imgPanAnchor = { x: p.x, y: p.y, originX: imgZoom.x, originY: imgZoom.y };

      // Double-tap (single-finger, two quick taps) toggles zoom.
      const now = Date.now();
      if (now - imgLastTapAt < 320) {
        imgZoom = imgZoom.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 };
        applyImgZoom();
        imgPanAnchor = null;
      }
      imgLastTapAt = now;
    }
  });

  img.addEventListener("pointermove", (e) => {
    if (!imgViewerPointers.has(e.pointerId)) return;
    imgViewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (imgViewerPointers.size === 2 && imgPinchStartDist) {
      const pts = [...imgViewerPointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      imgZoom.scale = Math.min(IMG_ZOOM_MAX, Math.max(1, imgPinchStartScale * (dist / imgPinchStartDist)));
      applyImgZoom();
    } else if (imgViewerPointers.size === 1 && imgPanAnchor && imgZoom.scale > 1) {
      const p = imgViewerPointers.get(e.pointerId);
      imgZoom.x = imgPanAnchor.originX + (p.x - imgPanAnchor.x);
      imgZoom.y = imgPanAnchor.originY + (p.y - imgPanAnchor.y);
      applyImgZoom();
    }
  });

  const releasePointer = (e) => {
    imgViewerPointers.delete(e.pointerId);
    if (imgViewerPointers.size < 2) imgPinchStartDist = null;
    if (imgViewerPointers.size === 1) {
      // One finger still down after a pinch ends — hand off to panning
      // from here, so lifting the second finger doesn't jump the image.
      const [, p] = [...imgViewerPointers.entries()][0];
      imgPanAnchor = { x: p.x, y: p.y, originX: imgZoom.x, originY: imgZoom.y };
    } else {
      imgPanAnchor = null;
    }
    if (imgZoom.scale <= 1) { imgZoom = { scale: 1, x: 0, y: 0 }; applyImgZoom(); }
  };
  img.addEventListener("pointerup", releasePointer);
  img.addEventListener("pointercancel", releasePointer);
}

function closeSwipeRow(rowId) {
  const el = document.querySelector(`.swipe-content[data-row-id="${rowId}"]`);
  if (el) {
    el.style.transition = "transform 0.2s ease";
    el.style.transform = "translateX(0px)";
    el.dataset.openState = "";
  }
  if (openSwipeRowId === rowId) openSwipeRowId = null;
}

// Tapping a row normally opens its full detail sheet — but if the row is
// currently swiped open (revealing Clone/Delete), the first tap just
// closes that instead, matching how swipe-action lists usually behave
// (a tap on the revealed content dismisses the reveal rather than firing
// the row's primary action right after a swipe gesture).
function handleInventoryRowClick(id) {
  if (suppressRowClick) {
    suppressRowClick = false;
    return;
  }
  if (openSwipeRowId === id) {
    closeSwipeRow(id);
    return;
  }
  showPriceBreakdownFor(id);
}

// Tapping anywhere outside an open swipe row closes it — standard
// "swipe to reveal" list behavior.
document.addEventListener("pointerdown", (e) => {
  if (!openSwipeRowId) return;
  if (e.target.closest(`.swipe-content[data-row-id="${openSwipeRowId}"]`)) return;
  if (e.target.closest(".swipe-action")) return; // let the action's own click fire first
  closeSwipeRow(openSwipeRowId);
});

function confirmDeleteInventoryCard(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;
  const ok = window.confirm(`Delete "${record.cardName}" (${record.cardNumber})? This can't be undone.`);
  if (ok) deleteInventoryCard(recordId);
  else closeSwipeRow(recordId);
}

async function deleteInventoryCard(recordId) {
  try {
    await apiJson(`${API_BASE}/inventory-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: recordId }),
    });
    await refreshAll();
    showToast("Card deleted.");
  } catch (err) {
    showToast("Couldn't delete: " + err.message);
    closeSwipeRow(recordId);
  }
}

// Cloning opens a small modal asking for Purchase Price, Purchase
// Currency, Collection, and Sub-Condition before creating the copy,
// instead of immediately creating an identical listing — these are the
// fields most likely to genuinely differ between one physical copy and
// another of "the same" card (bought at a different price, filed in a
// different collection, graded differently), whereas everything else on
// the record (name, number, rarity, artist, etc.) really is identical
// and stays copied as-is. Collection and Sub-Condition are pre-filled
// from the original (editable, since they often DO carry over);
// Purchase Price/Currency start blank. Binder placement and Quantity
// still reset the same way as before — copying binder.page/slot
// literally would make both cards claim the same slot (a rendering
// conflict, not a real feature), so the clone always lands unplaced,
// ready to be placed via the slot picker.
let cloneSourceId = null;

function cloneInventoryCard(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;
  cloneSourceId = recordId;

  document.getElementById("clone-modal-title").textContent = record.cardName;
  document.getElementById("clone-modal-sub").textContent = `${record.cardNumber} · ${record.language || ""}`;
  document.getElementById("clone-purchase-price").value = "";
  document.getElementById("clone-purchase-currency").value = record.purchaseCurrency || "SGD";
  document.getElementById("clone-collection").value = Array.isArray(record.collection) ? record.collection.join(" + ") : "";
  document.getElementById("clone-sub-condition").value = record.subCondition || "";
  document.getElementById("clone-modal").classList.add("open");
  closeSwipeRow(recordId);
}

function closeCloneModal() {
  document.getElementById("clone-modal").classList.remove("open");
  cloneSourceId = null;
}

// Leaving Purchase Price blank keeps the clone as a new Wanted listing
// (matching the old default behavior exactly); filling it in marks the
// clone Purchased (in hand) immediately, on the theory that if you're
// recording a purchase price for this specific copy, you already have
// it — same "quantity=1 & purchasePrice set => Purchased" rule
// HANDOVER.md §4 uses everywhere else.
async function submitClone() {
  const record = inventoryRecords.find((r) => r.id === cloneSourceId);
  if (!record) return;

  const priceRaw = document.getElementById("clone-purchase-price").value.trim();
  const currency = document.getElementById("clone-purchase-currency").value.trim() || "SGD";
  const collectionRaw = document.getElementById("clone-collection").value.trim();
  const subCondition = document.getElementById("clone-sub-condition").value.trim();

  const clone = {
    ...record,
    quantity: priceRaw ? 1 : 0,
    purchasePrice: priceRaw ? Number(priceRaw) : null,
    purchaseCurrency: priceRaw ? currency : null,
    purchaseDate: priceRaw ? new Date().toISOString().slice(0, 10) : null,
    collection: collectionRaw ? collectionRaw.split("+").map((s) => s.trim()).filter(Boolean) : [],
    subCondition,
    binder: null,
  };
  delete clone.id;
  delete clone.createdAt;
  delete clone.status;

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clone),
    });
    closeCloneModal();
    await refreshAll();
    showToast(`Cloned "${record.cardName}" as a new ${priceRaw ? "Purchased" : "Wanted"} listing.`);
  } catch (err) {
    showToast("Couldn't clone: " + err.message);
  }
}

// ---- Search ------------------------------------------------------------------

function onInventorySearch(value) {
  inventorySearchTerm = (value || "").trim().toLowerCase();
  renderInventory();
}

function matchesSearch(record) {
  if (!inventorySearchTerm) return true;
  const haystack = `${record.cardName || ""} ${record.cardNumber || ""}`.toLowerCase();
  return haystack.includes(inventorySearchTerm);
}

// ---- Filters -------------------------------------------------------------

function matchesFilters(record) {
  const { set, subset } = parseCardNumber(record.cardNumber);
  const fieldValue = { listing: record.status, language: record.language, set, subset, rarity: record.rarity, conditionType: record.conditionType };

  return Object.keys(currentFilters).every((key) => {
    const wanted = currentFilters[key];
    return wanted === "All" || fieldValue[key] === wanted;
  });
}

// Dropdown is position:fixed (see the CSS comment on .filter-dropdown
// for why), so its screen position has to be set here rather than in
// CSS — anchored to the trigger pill's own on-screen position, then
// nudged left if it would run past the right edge of the viewport
// (measured after opening, since the dropdown's own width isn't known
// until it's actually laid out).
function toggleFilterMenu(key) {
  const menu = document.getElementById("fd-" + key);
  const wasOpen = menu.classList.contains("open");
  document.querySelectorAll(".filter-dropdown").forEach((d) => d.classList.remove("open"));
  if (wasOpen) return;

  const pill = document.getElementById("fp-" + key);
  const rect = pill.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + "px";
  menu.style.left = rect.left + "px";
  menu.classList.add("open");

  const menuRect = menu.getBoundingClientRect();
  const overflowRight = menuRect.right - (window.innerWidth - 12);
  if (overflowRight > 0) {
    menu.style.left = Math.max(12, rect.left - overflowRight) + "px";
  }
}

const FILTER_LABELS = { listing: "Listing", language: "Language", set: "Set", subset: "Sub-Set", rarity: "Rarity", conditionType: "Condition" };

function selectFilter(key, value, optionEl) {
  currentFilters[key] = value;
  document.getElementById("fp-" + key).textContent = FILTER_LABELS[key] + ": " + value;
  document.getElementById("fp-" + key).classList.toggle("active-filter", value !== "All");

  const menu = document.getElementById("fd-" + key);
  menu.querySelectorAll(".filter-option").forEach((o) => o.classList.remove("selected"));
  optionEl.classList.add("selected");
  menu.classList.remove("open");

  renderInventory();
}

// Dashboard stat tiles (see the 3x2 grid in renderDashboard) jump here
// with a pre-applied filter — e.g. tapping "Slabs Graded" lands on
// Inventory already filtered to Listing:Purchased + Condition:Slabs.
// Every filter not mentioned resets to "All" and any active search term
// is cleared, so each tile always shows a clean, fully-explained view —
// nothing left over from wherever the person filtered/searched last.
function goToInventoryFiltered(filters) {
  Object.keys(currentFilters).forEach((key) => { currentFilters[key] = "All"; });
  Object.assign(currentFilters, filters);

  Object.keys(currentFilters).forEach((key) => {
    const pill = document.getElementById("fp-" + key);
    if (!pill) return;
    const value = currentFilters[key];
    pill.textContent = FILTER_LABELS[key] + ": " + value;
    pill.classList.toggle("active-filter", value !== "All");
    const menu = document.getElementById("fd-" + key);
    if (menu) {
      menu.querySelectorAll(".filter-option").forEach((o) => {
        o.classList.toggle("selected", o.textContent.trim() === value);
      });
    }
  });

  inventorySearchTerm = "";
  const searchInput = document.getElementById("inv-search-input");
  if (searchInput) searchInput.value = "";

  showScreen("inventory");
  renderInventory();
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".filter-item")) {
    document.querySelectorAll(".filter-dropdown").forEach((d) => d.classList.remove("open"));
  }
});

// ---- Price breakdown modal -------------------------------------------------

// Tracks which record/binder the price-breakdown modal is currently
// showing, so the edit-mode functions below (toggleDetailEdit and
// friends) — triggered from a static pencil-icon button that isn't
// rebuilt per-record like pm-details/pm-rows are — know which card
// they're acting on, and saveDetailEdit() can re-open the same sheet
// (with the same binderKey, so Change/Remove buttons still show
// correctly) after saving.
let currentDetailRecordId = null;
let currentDetailBinderKey = null;
// Staged NEW photos for the detail-edit "add additional image" flow —
// a separate array from the Add Card screen's own `extraPhotos` so the
// two forms never cross-contaminate if both happen to be mid-edit.
let editExtraPhotos = [];

function showPriceBreakdownFor(recordId, binderKey) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;

  currentDetailRecordId = recordId;
  currentDetailBinderKey = binderKey || null;
  cancelDetailEdit(); // in case a previous card was left mid-edit

  const src = record.rawSources || {};
  const market = computeMarketPrice(record);
  const isSlab = record.conditionType === "Slabs";

  const rows = [];
  if (src.toretoku) {
    rows.push({
      dotType: "manual",
      name: "Toretoku" + (src.toretoku.grade ? ` (Grade ${src.toretoku.grade})` : ""),
      tag: (isSlab ? "Not used for Slabs" : "In average") + (src.toretoku.inStock === false ? " · Out of stock" : ""),
      priceText: formatMoney(src.toretoku.price) + (src.toretoku.note ? ` (${src.toretoku.note})` : ""),
      muted: src.toretoku.inStock === false,
    });
  }
  if (src.yuyutei) {
    rows.push({
      dotType: "manual",
      name: "Yuyu-tei",
      tag: (isSlab ? "Not used for Slabs" : "In average") + (src.yuyutei.inStock === false ? " · Out of stock" : ""),
      priceText: formatMoney(src.yuyutei.price) + (src.yuyutei.note ? ` (${src.yuyutei.note})` : ""),
      muted: src.yuyutei.inStock === false,
    });
  }
  if (src.pricecharting) {
    // Legacy data from before PriceCharting was removed (see HANDOVER
    // §18) — still shown for any card that has it, just not something
    // new scrapes can add anymore.
    rows.push(
      isSlab
        ? { dotType: "lastresort", name: "PriceCharting · PSA10", tag: "Slab reference price (legacy — source removed)", priceText: src.pricecharting.psa10 != null ? formatMoney(src.pricecharting.psa10) : "—", muted: false }
        : { dotType: "lastresort", name: "PriceCharting · Ungraded", tag: "Legacy data — source removed, no longer used", priceText: src.pricecharting.ungraded != null ? formatMoney(src.pricecharting.ungraded) : "—", muted: true }
    );
  }

  document.getElementById("pm-title").textContent = record.cardName;
  // Card Number, Original Name, Artist, Color, and Family Type used to
  // live here as a plain " · "-joined subtitle line. Moved into the
  // pm-details grid below instead, alongside every other field, so
  // there's one place to look for full card info instead of splitting
  // it between a header line and a grid.
  const pmSubEl = document.getElementById("pm-sub");
  pmSubEl.textContent = "";
  pmSubEl.style.display = "none";

  const statusBadge = document.getElementById("pm-status-badge");
  statusBadge.textContent = record.status;
  statusBadge.className = "pm-status-badge" + (record.status === "Pending Delivery" ? " pending" : record.status === "Wanted" ? " wanted" : "");

  // Full card detail grid — every field on the record, not just pricing.
  // Added because tapping a listing previously only surfaced the price
  // breakdown; there was no way to see purchase info, condition details,
  // or where a card is placed in a binder without editing/guessing.
  const detailItems = [];
  const addDetail = (label, value, span2) => {
    if (value == null || value === "") return;
    detailItems.push(`<div class="pm-detail-item${span2 ? " span-2" : ""}"><div class="pm-detail-label">${escapeHtml(label)}</div><div class="pm-detail-value">${escapeHtml(value)}</div></div>`);
  };
  // Pills instead of a plain " + "-joined string, for the three
  // multi-value tag fields — matches how they're picked/edited on the
  // Add Card screen (chip-toggle / chip-tag), just read-only here.
  const addPillDetail = (label, values) => {
    if (!Array.isArray(values) || !values.length) return;
    const pills = values.map((v) => `<span class="pm-pill">${escapeHtml(v)}</span>`).join("");
    detailItems.push(`<div class="pm-detail-item span-2"><div class="pm-detail-label">${escapeHtml(label)}</div><div class="pm-detail-value pm-pill-row">${pills}</div></div>`);
  };
  addDetail("Original Name", record.cardNameOriginal);
  addDetail("Card Number", record.cardNumber);
  addDetail("Artist", record.artist);
  addDetail("Category", record.category);
  addDetail("Rarity", record.rarity);
  addDetail("Foil Type", record.foilType);
  addDetail("Language", record.language);
  addDetail("Condition Type", record.conditionType);
  if (record.conditionType === "Slabs") {
    addDetail("Sub-Condition", record.subCondition);
    addDetail("Grading Co.", record.gradingCompany);
    addDetail("Cert Number", record.certNumber);
  } else if (record.subCondition) {
    addDetail("Sub-Condition", record.subCondition);
  }
  if (record.status !== "Wanted" && record.purchasePrice != null) {
    addDetail("Purchase Date", record.purchaseDate);
  }
  addPillDetail("Collection", record.collection);
  addPillDetail("Color", record.color);
  addPillDetail("Family Type", record.familyType);
  if (record.binder && record.binder.key) {
    const binderLabel = record.binder.key === "main" ? "Main Collection" : (customBinders.find((b) => b.key === record.binder.key)?.name || record.binder.key);
    addDetail("Binder Placement", `${binderLabel} — Page ${record.binder.page}, Slot ${record.binder.slot + 1}`, true);
  }
  document.getElementById("pm-details").innerHTML = detailItems.join("");

  const galleryEl = document.getElementById("pm-gallery");
  const imageUrls = imageUrlsFor(record);
  if (imageUrls.length >= 1) {
    galleryEl.style.display = "flex";
    galleryEl.innerHTML = imageUrls.map((url, i) => `
      <img src="${escapeAttr(url)}" alt="Photo ${i + 1}" onclick="openImageViewer('${escapeAttr(url)}')" style="width:80px; height:112px; object-fit:cover; border-radius:8px; border:1px solid var(--line); flex:0 0 auto; cursor:pointer;">
    `).join("");
  } else {
    galleryEl.style.display = "none";
    galleryEl.innerHTML = "";
  }
  const hasAnyUrl = record.toretokuUrl || record.yuyuteiUrl;
  const showPurchaseRow = record.status !== "Wanted" && record.purchasePrice != null;
  document.getElementById("pm-rows").innerHTML =
    (showPurchaseRow
      ? `<div class="pm-average-row purchase">
          <div class="pm-average-label">Purchase price</div>
          <div class="pm-average-value">${escapeHtml(formatOriginal(record.purchasePrice, record.purchaseCurrency || "SGD"))}</div>
        </div>`
      : "")
  + `
    <div class="pm-average-row">
      <div class="pm-average-label">Market price — ${escapeHtml(market.label)}</div>
      <div class="pm-average-value">${market.value != null ? formatMoney(market.value) : "—"}</div>
    </div>
  ` + (rows.length
    ? rows.map((r) => `
      <div class="price-source-row">
        <div class="ps-dot ${r.dotType}"></div>
        <div>
          <div class="ps-name">${escapeHtml(r.name)}</div>
          <div class="ps-tag">${escapeHtml(r.tag)}</div>
        </div>
        <div class="ps-price${r.muted ? " out-of-stock" : ""}">${escapeHtml(r.priceText)}</div>
      </div>
    `).join("")
    : `<div class="inv-loading" style="margin:10px 0;">No pricing sources recorded for this card yet.</div>`)
  + (hasAnyUrl
    ? `<button class="save-btn" id="pm-refresh-btn" style="margin: 12px 0 0; width:100%;" onclick="refreshPriceFor('${escapeAttr(record.id)}')">↻ Refresh price from saved URLs</button>`
    : "")
  + (binderKey
    ? `<button class="save-btn" style="margin: 8px 0 0; width:100%; background:var(--ink-3); color:var(--text);" onclick="changeCardInSlot('${escapeAttr(record.id)}', '${escapeAttr(binderKey)}')">⇄ Change card in this slot</button>
       <button class="save-btn" style="margin: 8px 0 0; width:100%; background:var(--ink-3); color:var(--coral); border:1px solid var(--line);" onclick="removeCardFromBinder('${escapeAttr(record.id)}')">Remove from this binder</button>`
    : "");

  document.getElementById("price-modal").classList.add("open");
}

// ---- Detail sheet: edit sources & photos (pencil icon) ---------------------
// Everything on the card is editable here except binder placement —
// that's a separate, deliberate action (slot picker / "Change card in
// this slot"), not a field to overwrite by accident alongside a typo
// fix. Quantity also isn't a field here: it's not shown anywhere in the
// view-mode details grid either, and toggling Wanted/Pending/Purchased
// by hand (rather than through purchase-modal's dedicated flow) is more
// of a status transition than "information" to correct.
function detailEditOption(value, current, label) {
  return `<option value="${escapeAttr(value)}"${value === (current || "") ? " selected" : ""}>${escapeHtml(label != null ? label : value)}</option>`;
}

function toggleDetailEdit() {
  const formEl = document.getElementById("pm-edit-form");
  const gridEl = document.getElementById("pm-details");
  if (!formEl || !gridEl) return;

  if (formEl.style.display !== "none") {
    cancelDetailEdit();
    return;
  }

  const record = inventoryRecords.find((r) => r.id === currentDetailRecordId);
  if (!record) return;

  editExtraPhotos = [];
  // Existing photos beyond the primary (index 0) are shown read-only —
  // this pencil only ADDS photos, it doesn't remove or reorder existing
  // ones.
  const existingExtraUrls = imageUrlsFor(record).slice(1);
  const isSlab = record.conditionType === "Slabs";
  const opt = detailEditOption;

  formEl.innerHTML = `
    <div class="field-label" style="padding:0; margin-top:0;">Card Name</div>
    <input class="form-input" id="pm-edit-card-name" value="${escapeAttr(record.cardName || "")}" style="margin-bottom:10px;">
    <div class="field-label" style="padding:0;">Original Name</div>
    <input class="form-input" id="pm-edit-card-name-original" value="${escapeAttr(record.cardNameOriginal || "")}" style="margin-bottom:10px;">
    <div class="form-row" style="margin-bottom:10px;">
      <input class="form-input" id="pm-edit-card-number" placeholder="Card number" value="${escapeAttr(record.cardNumber || "")}" style="flex:1;">
      <input class="form-input" id="pm-edit-rarity" placeholder="Rarity" value="${escapeAttr(record.rarity || "")}" style="flex:0 0 90px;">
    </div>
    <div class="field-label" style="padding:0;">Artist</div>
    <input class="form-input" id="pm-edit-artist" value="${escapeAttr(record.artist || "")}" style="margin-bottom:10px;">
    <div class="form-row" style="margin-bottom:10px;">
      <select class="form-input" id="pm-edit-category" style="flex:1;">
        <option value="">Category…</option>
        ${opt("Leader", record.category)}${opt("Character", record.category)}${opt("Event", record.category)}${opt("Stage", record.category)}${opt("Don!!", record.category)}
      </select>
      <select class="form-input" id="pm-edit-foil-type" style="flex:1;">
        <option value="">Foil type…</option>
        ${opt("Foil", record.foilType)}${opt("Non-Foil", record.foilType)}${opt("Textured Foil", record.foilType)}
      </select>
    </div>
    <div class="field-label" style="padding:0;">Color <span style="font-weight:400; color:var(--text-faint);">(multiple = join with " + ")</span></div>
    <input class="form-input" id="pm-edit-color" placeholder="e.g. Red + Green" value="${escapeAttr((record.color || []).join(" + "))}" style="margin-bottom:10px;">
    <div class="field-label" style="padding:0;">Family Type <span style="font-weight:400; color:var(--text-faint);">(multiple = join with " + ")</span></div>
    <input class="form-input" id="pm-edit-family-type" placeholder="e.g. Straw Hat Crew" value="${escapeAttr((record.familyType || []).join(" + "))}" style="margin-bottom:10px;">
    <div class="field-label" style="padding:0;">Collection <span style="font-weight:400; color:var(--text-faint);">(multiple = join with " + ")</span></div>
    <input class="form-input" id="pm-edit-collection" value="${escapeAttr((record.collection || []).join(" + "))}" style="margin-bottom:10px;">
    <div class="form-row" style="margin-bottom:10px;">
      <select class="form-input" id="pm-edit-language" style="flex:1;">
        ${opt("Japanese", record.language)}${opt("English", record.language)}${opt("Chinese", record.language)}
      </select>
      <select class="form-input" id="pm-edit-condition-type" style="flex:1;" onchange="document.getElementById('pm-edit-slab-fields').style.display = this.value === 'Slabs' ? 'flex' : 'none';">
        ${opt("Singles", record.conditionType)}${opt("Slabs", record.conditionType)}${opt("Sealed", record.conditionType)}
      </select>
    </div>
    <div class="form-row" id="pm-edit-slab-fields" style="margin-bottom:10px; display:${isSlab ? "flex" : "none"};">
      <select class="form-input" id="pm-edit-grading-company" style="flex:1;">
        <option value="">Grading co…</option>
        ${opt("PSA", record.gradingCompany)}${opt("CGC", record.gradingCompany)}${opt("ARS", record.gradingCompany)}
      </select>
      <input class="form-input" id="pm-edit-cert-number" placeholder="Cert number" value="${escapeAttr(record.certNumber || "")}" style="flex:1;">
    </div>
    <div class="field-label" style="padding:0;">Sub-Condition</div>
    <input class="form-input" id="pm-edit-sub-condition" placeholder="e.g. Sealed, White Dot, Damaged" value="${escapeAttr(record.subCondition || "")}" style="margin-bottom:10px;">
    <div class="form-row" style="margin-bottom:10px;">
      <input class="form-input" id="pm-edit-purchase-price" placeholder="Purchase price (blank = Wanted)" value="${escapeAttr(record.purchasePrice != null ? record.purchasePrice : "")}" style="flex:1;">
      <select class="form-input" id="pm-edit-purchase-currency" style="flex:0 0 90px;">
        ${opt("JPY", record.purchaseCurrency || "JPY")}${opt("SGD", record.purchaseCurrency || "JPY")}${opt("AUD", record.purchaseCurrency || "JPY")}${opt("RMB", record.purchaseCurrency || "JPY")}${opt("MYR", record.purchaseCurrency || "JPY")}${opt("USD", record.purchaseCurrency || "JPY")}
      </select>
    </div>
    <div class="field-label" style="padding:0;">Purchase Date</div>
    <input class="form-input" type="date" id="pm-edit-purchase-date" value="${escapeAttr(record.purchaseDate || "")}" style="margin-bottom:14px;">

    <div class="field-label" style="padding:0; margin-top:0;">Toretoku URL</div>
    <input class="form-input" id="pm-edit-toretoku-url" placeholder="Exact listing URL — not a catalog search link" value="${escapeAttr(record.toretokuUrl || "")}" style="margin-bottom:10px;">
    <div class="field-label" style="padding:0;">Yuyu-tei URL</div>
    <input class="form-input" id="pm-edit-yuyutei-url" placeholder="Exact listing URL" value="${escapeAttr(record.yuyuteiUrl || "")}" style="margin-bottom:10px;">
    ${existingExtraUrls.length ? `
    <div class="field-label" style="padding:0;">Existing additional photos</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
      ${existingExtraUrls.map((u) => `<img src="${escapeAttr(u)}" alt="" style="width:46px; height:64px; object-fit:cover; border-radius:6px; border:1px solid var(--line);">`).join("")}
    </div>` : ""}
    <div class="field-label" style="padding:0;">Add a photo</div>
    <div class="form-row" style="margin-bottom:6px; gap:8px;">
      <label class="fetch-btn" style="flex:1; display:flex; align-items:center; justify-content:center; padding:10px; text-align:center;">
        📁 Upload
        <input type="file" id="pm-edit-photo-file" accept="image/*" multiple style="display:none;" onchange="addEditPhotoFiles(this)">
      </label>
      <label class="fetch-btn" style="flex:1; display:flex; align-items:center; justify-content:center; padding:10px; text-align:center;">
        📷 Camera
        <input type="file" id="pm-edit-photo-camera" accept="image/*" capture="environment" style="display:none;" onchange="addEditPhotoFiles(this)">
      </label>
    </div>
    <div class="url-row" style="margin-bottom:6px;">
      <input class="url-input" id="pm-edit-photo-link" placeholder="Or paste an image link…">
      <button class="fetch-btn" onclick="addEditPhotoLink()">Add</button>
    </div>
    <div id="pm-edit-photos-preview" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;"></div>
    <div id="pm-edit-status" style="margin:0 0 8px; font-family:var(--mono); font-size:10.5px; color:var(--teal);"></div>
    <div class="form-row" style="gap:8px;">
      <button class="save-btn" style="flex:1; margin:0; background:var(--ink-3); color:var(--text);" onclick="cancelDetailEdit()">Cancel</button>
      <button class="save-btn" style="flex:1; margin:0;" onclick="saveDetailEdit()">Save</button>
    </div>
  `;
  formEl.style.display = "block";
  gridEl.style.display = "none";
  const pricingEl = document.getElementById("pm-pricing-section");
  if (pricingEl) pricingEl.style.display = "none";
  const btnEl = document.getElementById("pm-edit-toggle-btn");
  if (btnEl) { btnEl.textContent = "✕"; btnEl.title = "Cancel editing"; }
}

function cancelDetailEdit() {
  editExtraPhotos = [];
  const formEl = document.getElementById("pm-edit-form");
  const gridEl = document.getElementById("pm-details");
  const pricingEl = document.getElementById("pm-pricing-section");
  if (formEl) { formEl.style.display = "none"; formEl.innerHTML = ""; }
  if (gridEl) gridEl.style.display = "";
  if (pricingEl) pricingEl.style.display = "";
  const btnEl = document.getElementById("pm-edit-toggle-btn");
  if (btnEl) { btnEl.textContent = "✎"; btnEl.title = "Edit sources & photos"; }
}

function addEditPhotoFiles(input) {
  Array.from(input.files || []).forEach((file) => editExtraPhotos.push({ type: "file", file }));
  input.value = "";
  renderEditPhotosPreview();
}

function addEditPhotoLink() {
  const input = document.getElementById("pm-edit-photo-link");
  const url = input.value.trim();
  if (!url) return;
  editExtraPhotos.push({ type: "link", url: normalizeUrl(url) });
  input.value = "";
  renderEditPhotosPreview();
}

function removeEditPhoto(index) {
  editExtraPhotos.splice(index, 1);
  renderEditPhotosPreview();
}

function renderEditPhotosPreview() {
  const preview = document.getElementById("pm-edit-photos-preview");
  if (!preview) return;
  preview.innerHTML = "";
  editExtraPhotos.forEach((photo, i) => {
    const src = photo.type === "file" ? URL.createObjectURL(photo.file) : photo.url;
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative; width:46px; height:64px;";
    wrap.innerHTML = `
      <img src="${escapeAttr(src)}" style="width:100%; height:100%; object-fit:cover; border-radius:6px; border:1px solid var(--line);">
      <span onclick="removeEditPhoto(${i})" style="position:absolute; top:-6px; right:-6px; width:18px; height:18px; border-radius:50%; background:var(--coral); color:#fff; font-size:11px; display:flex; align-items:center; justify-content:center; cursor:pointer;">✕</span>
    `;
    preview.appendChild(wrap);
  });
}

// Saves every field except binder placement (that's still "Change card
// in this slot" — a deliberate, separate action). Multi-value fields
// (Color/Family Type/Collection) use the same " + " convention as
// everywhere else in the app (xlsx import, card-options.json). Uploads
// any newly-added photos (appended after whatever's already on the
// card — existing photos aren't touched), then re-opens the same sheet
// so the result is visible immediately. Uses store-external-image.js
// for pasted links (same lenient, non-scraper-allow-list path as
// everywhere else a user manually pastes a link — see saveCard()'s
// comment) and upload-card-image.js for direct file uploads, matching
// the Add Card screen's own "additional photos" handling exactly.
function splitPlusList(raw) {
  return raw ? raw.split("+").map((s) => s.trim()).filter(Boolean) : [];
}

async function saveDetailEdit() {
  const record = inventoryRecords.find((r) => r.id === currentDetailRecordId);
  if (!record) return;
  const statusEl = document.getElementById("pm-edit-status");

  const toretokuUrl = valueOf("pm-edit-toretoku-url");
  const yuyuteiUrl = valueOf("pm-edit-yuyutei-url");
  const purchasePriceRaw = valueOf("pm-edit-purchase-price");
  const conditionType = valueOf("pm-edit-condition-type") || "Singles";

  const updated = {
    ...record,
    cardName: valueOf("pm-edit-card-name") || record.cardName,
    cardNameOriginal: valueOf("pm-edit-card-name-original") || null,
    cardNumber: valueOf("pm-edit-card-number") || record.cardNumber,
    rarity: valueOf("pm-edit-rarity") || null,
    artist: valueOf("pm-edit-artist") || null,
    category: valueOf("pm-edit-category") || null,
    foilType: valueOf("pm-edit-foil-type") || null,
    color: splitPlusList(valueOf("pm-edit-color")),
    familyType: splitPlusList(valueOf("pm-edit-family-type")),
    collection: splitPlusList(valueOf("pm-edit-collection")),
    language: valueOf("pm-edit-language") || "Japanese",
    conditionType,
    gradingCompany: conditionType === "Slabs" ? (valueOf("pm-edit-grading-company") || null) : null,
    certNumber: conditionType === "Slabs" ? (valueOf("pm-edit-cert-number") || null) : null,
    subCondition: valueOf("pm-edit-sub-condition") || null,
    purchasePrice: purchasePriceRaw ? Number(purchasePriceRaw) : null,
    purchaseCurrency: valueOf("pm-edit-purchase-currency") || "JPY",
    purchaseDate: valueOf("pm-edit-purchase-date") || null,
    toretokuUrl: toretokuUrl ? normalizeUrl(toretokuUrl) : null,
    yuyuteiUrl: yuyuteiUrl ? normalizeUrl(yuyuteiUrl) : null,
  };

  if (editExtraPhotos.length) {
    const tempId = uniqueImageId(record.cardNumber);
    const existingKeys = record.imageBlobKeys || (record.imageBlobKey ? [record.imageBlobKey] : []);
    const newKeys = [];
    for (let i = 0; i < editExtraPhotos.length; i++) {
      const photo = editExtraPhotos[i];
      if (statusEl) statusEl.textContent = `Uploading photo ${i + 1} of ${editExtraPhotos.length}…`;
      try {
        let imgData;
        if (photo.type === "file") {
          const base64 = await fileToBase64(photo.file);
          imgData = await apiJson(`${API_BASE}/upload-card-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageBase64: base64, contentType: photo.file.type || "image/jpeg", cardId: `${tempId}-${existingKeys.length + i}` }),
          });
        } else {
          imgData = await apiJson(`${API_BASE}/store-external-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: photo.url, cardId: `${tempId}-${existingKeys.length + i}` }),
          });
        }
        newKeys.push(imgData.blobKey);
      } catch (imgErr) {
        showToast(`Photo ${i + 1} failed: ${imgErr.message}`);
      }
    }
    if (newKeys.length) {
      updated.imageBlobKeys = [...existingKeys, ...newKeys];
      if (!updated.imageBlobKey) updated.imageBlobKey = updated.imageBlobKeys[0];
    }
  }

  if (statusEl) statusEl.textContent = "Saving…";
  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    editExtraPhotos = [];
    await refreshAll();
    showPriceBreakdownFor(currentDetailRecordId, currentDetailBinderKey);
    showToast("Card updated.");
  } catch (err) {
    if (statusEl) statusEl.textContent = "Save failed: " + err.message;
  }
}

// Re-scrapes whichever of toretokuUrl/yuyuteiUrl are saved on a record
// (e.g. from an xlsx import, or an older Add Card save) and returns an
// updated copy (rawSources + image), WITHOUT saving it — callers
// (refreshPriceFor for one card, refreshAllPrices for many) decide
// when/how to persist, so a bulk refresh can batch everything into one
// inventory-save call instead of one per card. Never throws; a failure
// on one source just leaves that source's existing data in place and
// gets logged.
async function buildRefreshedRecord(record) {
  const sourceUrls = { toretoku: record.toretokuUrl, yuyutei: record.yuyuteiUrl };
  const fetched = {};
  const rawSources = { ...(record.rawSources || {}) };

  for (const [key, rawUrl] of Object.entries(sourceUrls)) {
    if (!rawUrl) continue;
    try {
      const data = await apiJson(`${API_BASE}/scrape-card?url=${encodeURIComponent(normalizeUrl(rawUrl))}`);
      fetched[key] = data;
      rawSources[key] = buildRawSourceEntry(key, data);
    } catch (err) {
      console.warn(`Refresh failed for ${key} on ${record.cardName}:`, err.message);
    }
  }

  const updated = { ...record, rawSources };

  const imageUrl = (fetched.toretoku && fetched.toretoku.imageUrl)
    || (fetched.yuyutei && fetched.yuyutei.imageUrl);
  if (imageUrl) {
    try {
      const tempId = uniqueImageId(record.cardNumber || record.id);
      const imgData = await apiJson(`${API_BASE}/store-card-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, cardId: tempId }),
      });
      updated.imageBlobKey = imgData.blobKey;
      // Refresh only the primary photo (index 0) — keep any additional
      // manually-uploaded photos (e.g. a Slab back) untouched.
      updated.imageBlobKeys = [imgData.blobKey, ...(record.imageBlobKeys || []).slice(1)];
    } catch (err) {
      console.warn(`Image refresh failed for ${record.cardName}:`, err.message);
    }
  }

  return updated;
}

async function refreshPriceFor(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;
  const btn = document.getElementById("pm-refresh-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }

  const updated = await buildRefreshedRecord(record);

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    await refreshAll();
    showPriceBreakdownFor(recordId);
    showToast("Price refreshed.");
  } catch (err) {
    showToast("Refresh failed: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh price from saved URLs"; }
  }
}

// Bulk version, reachable from the Inventory header's "↻" icon —
// refreshes every record that has at least one saved source URL.
// Deliberately sequential, not parallel: firing N simultaneous scrape
// requests is more likely to trip a site's bot detection than one at a
// time (see HANDOVER §16 on PriceCharting specifically), and this isn't
// time-critical. One bulk inventory-save at the end rather than N
// individual saves.
async function refreshAllPrices() {
  const eligible = inventoryRecords.filter((r) => r.toretokuUrl || r.yuyuteiUrl);
  if (eligible.length === 0) {
    showToast("No cards have a saved source URL to refresh from yet.");
    return;
  }

  const btn = document.getElementById("refresh-all-btn");
  const statusEl = document.getElementById("import-status");
  if (btn) btn.classList.add("spinning");

  const updates = [];
  for (let i = 0; i < eligible.length; i++) {
    if (statusEl) statusEl.textContent = `Refreshing ${i + 1} of ${eligible.length}…`;
    updates.push(await buildRefreshedRecord(eligible[i]));
  }

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: updates }),
    });
    if (statusEl) statusEl.textContent = `Refreshed ${updates.length} card(s).`;
    await refreshAll();
  } catch (err) {
    if (statusEl) statusEl.textContent = "Bulk refresh failed: " + err.message;
  } finally {
    if (btn) btn.classList.remove("spinning");
  }
}

function closePriceBreakdown() {
  document.getElementById("price-modal").classList.remove("open");
}

// ---- Import (xlsx) ----------------------------------------------------------
// Column order/mapping must match HANDOVER.md §3.3 and the generated
// public/tangstash-import-template.xlsx (see build_scripts/make_template.py).

const IMPORT_COLUMN_MAP = [
  ["Listing UID", "id"],
  ["Card Name", "cardName"],
  ["Original Name", "cardNameOriginal"],
  ["Artist", "artist"],
  ["Card Number", "cardNumber"],
  ["Category", "category"],
  ["Print Source", "printSource"],
  ["Rarity", "rarity"],
  ["Foil Type", "foilType"],
  ["Color", "color"],
  ["Family Type", "familyType"],
  ["Collection", "collection"],
  ["Language", "language"],
  ["Quantity", "quantity"],
  ["Purchase Price", "purchasePrice"],
  ["Purchase Currency", "purchaseCurrency"],
  ["Purchase Date", "purchaseDate"],
  ["Toretoku URL", "toretokuUrl"],
  ["Yuyu-tei URL", "yuyuteiUrl"],
  ["Image Link", "imageLink"],
  ["Additional Photos", "extraPhotoLinks"],
  ["Condition Type", "conditionType"],
  ["Sub-Condition", "subCondition"],
  ["Grading Company", "gradingCompany"],
  ["Cert Number", "certNumber"],
  ["Binder Placement", "binderPlacementRaw"],
];

// Fields stored as arrays (multi-value) but represented as a single
// " + "-joined cell in xlsx, per card-options.json's
// colorFamilyTypeCollection note — e.g. "Red + Green". "Additional
// Photos" uses the same " + " convention (see the template's Legend
// tab) but ISN'T one of these three: it doesn't end up as a plain
// array field on the saved record the way Color/Family Type/Collection
// do — it's consumed separately in handleImportFile() to actually fetch
// and store each photo, then discarded before the record is saved (see
// below).
const MULTI_VALUE_FIELDS = ["color", "familyType", "collection"];

// The filled-in counterpart to the blank tangstash-import-template.xlsx
// download — every current card, using the exact same column layout as
// IMPORT_COLUMN_MAP (Listing UID included), so re-uploading this file
// later — edited or not — mass-updates the matching listings via that
// UID instead of creating duplicates, exactly like the template's own
// "fill in an existing UID" workflow. "Additional Photos" is always
// left blank: once a photo is stored, only its blob key survives, not
// the original URL, so there's nothing to round-trip there — and a
// blank cell there is safe on re-import, since it just means "no NEW
// photo to add" (existing photos are never touched by the import path).
// Inverse of the import side's parsing (see handleImportFile) — turns a
// record's current {key, page, slot} back into "<Binder Name> <Number>"
// for export, so re-uploading an unedited export round-trips to the
// exact same spot.
function formatBinderPlacement(binder) {
  if (!binder || binder.page == null || binder.slot == null) return "";
  const name = binder.key === "main" ? "Main Collection" : (customBinders.find((b) => b.key === binder.key)?.name || binder.key);
  const number = (binder.page - 1) * 9 + binder.slot + 1;
  return `${name} ${number}`;
}

function exportInventoryTemplate() {
  if (!inventoryRecords.length) {
    showToast("No cards in inventory yet to export.");
    return;
  }
  const headers = IMPORT_COLUMN_MAP.map(([col]) => col);
  const rows = inventoryRecords.map((r) => {
    const row = {};
    IMPORT_COLUMN_MAP.forEach(([col, field]) => {
      if (field === "extraPhotoLinks") { row[col] = ""; return; }
      if (field === "binderPlacementRaw") { row[col] = formatBinderPlacement(r.binder); return; }
      let value = r[field];
      if (MULTI_VALUE_FIELDS.includes(field)) {
        value = Array.isArray(value) ? value.join(" + ") : "";
      } else if (value == null) {
        value = "";
      }
      row[col] = value;
    });
    return row;
  });

  const cardsSheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  cardsSheet["!cols"] = headers.map(() => ({ wch: 22 }));

  const legendRows = [
    ["TangStash — Export"],
    ["Every card currently in your inventory, one row per listing. Re-upload this file (edited or not) from the Inventory screen's import icon (⇅) to mass-update — matched by Listing UID, same as the blank import template."],
    [],
    ["Column", "Notes"],
    ["Listing UID", "Matches an existing card on re-import — updates it in place instead of creating a duplicate. Don't edit this."],
    ["Color / Family Type / Collection", "Multiple values are joined with ' + '."],
    ["Additional Photos", "Always blank on export — only a stored photo's blob survives, not its original link. Leave blank on re-import too; it won't remove any existing photos."],
    ["Binder Placement", "\"<Binder Name> <Number>\" — reflects where this card is placed right now. Editing it and re-importing moves the card (or creates a new binder if the name doesn't exist); leaving it as-is on re-import keeps it exactly where it is."],
  ];
  const legendSheet = XLSX.utils.aoa_to_sheet(legendRows);
  legendSheet["!cols"] = [{ wch: 30 }, { wch: 95 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, legendSheet, "Legend");
  XLSX.utils.book_append_sheet(wb, cardsSheet, "Cards");

  XLSX.writeFile(wb, `tangstash-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function triggerImport() {
  document.getElementById("import-file-input").click();
}

// Recognizes a Listing UID cell that marks the row for DELETION instead
// of create/update — "del"/"delete" (any case) attached to the front or
// back of the UID, e.g. "TS-A2B3C-del", "delete-TS-A2B3C", "TS-A2B3Cdel".
// Anchored on the app's own generated UID shape ("TS-" + 5 chars from a
// fixed alphabet) rather than a looser "ends with del" pattern — that
// alphabet includes D/E/L, so a real UID could coincidentally end in
// "del" purely by chance, and treating that as a delete marker would
// silently destroy a card instead of importing it. Returns the bare UID
// to delete, or null if this cell isn't a delete marker at all.
function parseUidForDelete(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const uidMatch = trimmed.match(/TS-[A-Z0-9]{5}/i);
  if (!uidMatch) return null;
  const remainder = trimmed.replace(uidMatch[0], "").replace(/[-_.\s]/g, "").toLowerCase();
  if (remainder === "del" || remainder === "delete") return uidMatch[0].toUpperCase();
  return null;
}

async function handleImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  const statusEl = document.getElementById("import-status");
  if (statusEl) statusEl.textContent = "Reading file…";

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames.includes("Cards") ? "Cards" : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const allRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    // Split off delete-marked rows first — these only need a Listing
    // UID, not a Card Name/Card Number, so they have to be pulled out
    // before the "needs Card Name + Card Number" filter below, or a row
    // that's just there to delete an existing card (nothing else filled
    // in) would get silently dropped instead of acted on.
    const idsToDelete = [];
    const rows = [];
    allRows.forEach((row) => {
      const deleteUid = parseUidForDelete(row["Listing UID"]);
      if (deleteUid) idsToDelete.push(deleteUid);
      else rows.push(row);
    });

    let deletedCount = 0;
    let deleteFailures = 0;
    for (const id of idsToDelete) {
      if (statusEl) statusEl.textContent = `Deleting ${deletedCount + deleteFailures + 1} of ${idsToDelete.length}…`;
      try {
        await apiJson(`${API_BASE}/inventory-delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        deletedCount++;
      } catch (err) {
        deleteFailures++;
        console.warn(`Delete failed for ${id}:`, err.message);
      }
    }

    const records = rows
      .filter((row) => String(row["Card Name"] || "").trim() && String(row["Card Number"] || "").trim())
      .map((row) => {
        const rec = {};
        IMPORT_COLUMN_MAP.forEach(([col, field]) => {
          let value = row[col];
          if (value === "" || value === undefined) value = undefined;
          if (field === "quantity") value = value === undefined ? 0 : Number(value);
          if (field === "purchasePrice") value = value === undefined || value === "" ? null : Number(value);
          if (field === "purchaseDate" && value instanceof Date) {
            value = value.toISOString().slice(0, 10);
          }
          if (MULTI_VALUE_FIELDS.includes(field)) {
            value = value === undefined ? [] : String(value).split("+").map((s) => s.trim()).filter(Boolean);
          }
          // "Additional Photos" uses the same " + " convention as the
          // multi-value fields above, but stays a plain array of URL
          // strings, not a saved record field — the image-fetch pass
          // right after this map() consumes it to actually store each
          // photo, then deletes it before the record is saved.
          if (field === "extraPhotoLinks") {
            value = value === undefined ? [] : String(value).split("+").map((s) => s.trim()).filter(Boolean);
          }
          if (value !== undefined) rec[field] = value;
        });
        if (!rec.id) delete rec.id; // blank Listing UID -> new card
        return rec;
      });

    if (records.length === 0) {
      if (statusEl) {
        statusEl.textContent = idsToDelete.length
          ? `Deleted ${deletedCount} card(s).` + (deleteFailures ? ` ${deleteFailures} couldn't be deleted (already gone?).` : "")
          : "No valid rows found (need at least Card Name + Card Number, or a Listing UID marked for deletion).";
      }
      if (idsToDelete.length) await refreshAll();
      return;
    }

    // Fetch/store images for any row that has an Image Link and/or
    // Additional Photos — these are manually-pasted links (same as the
    // Add Card screen's own Image Link / Additional Photos fields), so
    // they go through store-external-image.js's lenient path, not the
    // Toretoku/Yuyu-tei scraper allow-list (see saveCard()'s comment on
    // this same distinction). Sequential per photo, same reasoning as
    // refreshAllPrices(): this isn't time-critical, and importing many
    // rows at once with many links is more requests than any single
    // manual save, so there's even more reason not to fire them all at
    // once. inventory-save.js explicitly does NOT do this itself (see
    // its header comment) — it only persists whatever shape it's given.
    const rowsNeedingImages = records.filter((r) => r.imageLink || (r.extraPhotoLinks && r.extraPhotoLinks.length));
    let imageFailures = 0;
    if (rowsNeedingImages.length) {
      let done = 0;
      for (const rec of records) {
        const links = [];
        if (rec.imageLink) links.push(rec.imageLink);
        if (rec.extraPhotoLinks) links.push(...rec.extraPhotoLinks);

        if (!links.length) continue;
        done++;
        if (statusEl) statusEl.textContent = `Fetching images for card ${done} of ${rowsNeedingImages.length}…`;

        const tempId = uniqueImageId(rec.cardNumber);
        const imageBlobKeys = [];
        for (let i = 0; i < links.length; i++) {
          try {
            const imgData = await apiJson(`${API_BASE}/store-external-image`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ imageUrl: links[i], cardId: `${tempId}-${i}` }),
            });
            imageBlobKeys.push(imgData.blobKey);
          } catch (imgErr) {
            imageFailures++;
            console.warn(`Image ${i + 1} for "${rec.cardName}" failed:`, imgErr.message);
          }
        }
        if (imageBlobKeys.length) {
          rec.imageBlobKeys = imageBlobKeys;
          rec.imageBlobKey = imageBlobKeys[0]; // kept for older code paths
        }
      }
    }
    // Not a real record field, never sent to inventory-save — cleaned up
    // unconditionally (previously this only ran inside the `if
    // (rowsNeedingImages.length)` block above, so a batch where NOT ONE
    // row had a photo link left every record carrying a stray empty
    // `extraPhotoLinks: []`, harmlessly stored but never intended).
    records.forEach((rec) => { delete rec.extraPhotoLinks; });

    // "<Binder Name> <Number>" -> resolve/create the binder, convert the
    // running slot count into {page, slot} (9 per page, in reading
    // order), and only commit it if that exact spot is actually free —
    // this never overwrites another card's placement, whether that
    // card already existed or is also being placed by an earlier row in
    // this same file.
    const placementFailures = { unparsed: 0, conflict: 0 };
    const occupiedSlots = new Map(); // "key|page|slot" -> an id (real or "row-<i>" for a new card)
    inventoryRecords.forEach((r) => {
      if (r.binder && r.binder.page != null && r.binder.slot != null) {
        occupiedSlots.set(`${r.binder.key}|${r.binder.page}|${r.binder.slot}`, r.id);
      }
    });
    const binderNameCache = new Map(); // lowercased name -> key, so repeated names in this file only create the binder once

    async function resolveBinderKeyForImport(name) {
      const trimmed = name.trim();
      const lower = trimmed.toLowerCase();
      if (lower === "main collection") return "main";
      if (binderNameCache.has(lower)) return binderNameCache.get(lower);
      const existing = customBinders.find((b) => b.name.trim().toLowerCase() === lower);
      if (existing) {
        binderNameCache.set(lower, existing.key);
        return existing.key;
      }
      const created = await apiJson(`${API_BASE}/binders-save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      customBinders = created.binders;
      binderNameCache.set(lower, created.binder.key);
      return created.binder.key;
    }

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const raw = rec.binderPlacementRaw;
      delete rec.binderPlacementRaw; // not a real record field
      if (!raw) continue;

      const match = String(raw).trim().match(/^(.+?)\s+(\d+)$/);
      if (!match) { placementFailures.unparsed++; continue; }

      const [, binderName, numberStr] = match;
      const number = parseInt(numberStr, 10);
      if (number < 1) { placementFailures.unparsed++; continue; }

      const page = Math.ceil(number / 9);
      const slot = (number - 1) % 9;
      const binderKey = await resolveBinderKeyForImport(binderName);
      const slotKey = `${binderKey}|${page}|${slot}`;
      const claimant = rec.id || `row-${i}`;
      const occupant = occupiedSlots.get(slotKey);

      if (occupant && occupant !== claimant) { placementFailures.conflict++; continue; }

      occupiedSlots.set(slotKey, claimant);
      rec.binder = { key: binderKey, page, slot };
    }

    if (statusEl) statusEl.textContent = `Uploading ${records.length} card(s)…`;

    const data = await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });

    if (statusEl) {
      let summary = `Imported ${data.saved.length} card(s). Total inventory: ${data.count}.`;
      if (idsToDelete.length) summary += ` Deleted ${deletedCount} card(s).` + (deleteFailures ? ` ${deleteFailures} couldn't be deleted (already gone?).` : "");
      if (imageFailures) summary += ` (${imageFailures} image link${imageFailures === 1 ? "" : "s"} couldn't be fetched — check the URLs and retry those cards.)`;
      if (placementFailures.conflict) summary += ` ${placementFailures.conflict} Binder Placement${placementFailures.conflict === 1 ? "" : "s"} skipped — that slot was already taken.`;
      if (placementFailures.unparsed) summary += ` ${placementFailures.unparsed} Binder Placement${placementFailures.unparsed === 1 ? "" : "s"} couldn't be read — expected "<Binder Name> <Number>".`;
      statusEl.textContent = summary;
    }
    await refreshAll();
  } catch (err) {
    if (statusEl) statusEl.textContent = "Import failed: " + err.message;
    console.error(err);
  } finally {
    input.value = ""; // allow re-selecting the same file later
  }
}

// ---- Add Card ----------------------------------------------------------------

const scrapeResults = { toretoku: null, yuyutei: null };

// Color is a fixed multi-select (chip toggle) — cards can be more than
// one color (e.g. Red + Green). Family Type and Collection are free-text
// multi-value tags instead of a fixed list: Family Type covers the
// game's many crew/faction "Feature" tags, too numerous and prone to
// drift to hardcode correctly, and Collection is open-ended by nature.
// See card-options.json's colorFamilyTypeCollection note.
let selectedColors = [];
let familyTypeTags = [];
let collectionTags = [];

function toggleColorChip(color, chipEl) {
  const idx = selectedColors.indexOf(color);
  if (idx === -1) {
    selectedColors.push(color);
    chipEl.classList.add("active");
  } else {
    selectedColors.splice(idx, 1);
    chipEl.classList.remove("active");
  }
}

function addTagFrom(inputId, field) {
  const input = document.getElementById(inputId);
  const value = input.value.trim();
  if (!value) return;
  const list = field === "familyType" ? familyTypeTags : collectionTags;
  if (!list.includes(value)) list.push(value);
  input.value = "";
  renderTagChips(field);
}

function removeTag(field, value) {
  const list = field === "familyType" ? familyTypeTags : collectionTags;
  const idx = list.indexOf(value);
  if (idx !== -1) list.splice(idx, 1);
  renderTagChips(field);
}

function renderTagChips(field) {
  const containerId = field === "familyType" ? "add-family-type-chips" : "add-collection-chips";
  const list = field === "familyType" ? familyTypeTags : collectionTags;
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = list.map((tag) => `
    <span class="chip-tag">${escapeHtml(tag)}<span class="chip-remove" onclick="removeTag('${field}', '${escapeAttr(tag)}')">✕</span></span>
  `).join("");
}

function resetChipFields() {
  selectedColors = [];
  familyTypeTags = [];
  collectionTags = [];
  document.querySelectorAll("#add-color-chips .chip-toggle").forEach((c) => c.classList.remove("active"));
  renderTagChips("familyType");
  renderTagChips("collection");
}

function getAddCardUrl(source) {
  const el = document.getElementById("url-" + source);
  return el ? el.value.trim() : "";
}

function normalizeUrl(raw) {
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return "https://" + raw;
}

async function fetchSource(source) {
  const rawUrl = getAddCardUrl(source);
  const box = document.getElementById("result-" + source);
  if (!box) return;

  if (!rawUrl) {
    box.classList.remove("pending");
    box.querySelector(".source-price").textContent = "—";
    box.querySelector(".source-cond").textContent = "No URL entered";
    return;
  }

  box.classList.add("pending");
  box.querySelector(".source-price").textContent = "Fetching…";
  box.querySelector(".source-cond").textContent = "Contacting site…";

  try {
    const url = normalizeUrl(rawUrl);
    const data = await apiJson(`${API_BASE}/scrape-card?url=${encodeURIComponent(url)}`);

    scrapeResults[source] = data;
    box.classList.remove("pending");
    box.querySelector(".source-thumb").textContent = "";
    if (data.imageUrl) {
      // Routed through preview-image-proxy.js rather than hotlinking
      // data.imageUrl directly — some sources (confirmed: Toretoku) block
      // direct browser hotlinking, which left this thumbnail blank even
      // though the underlying scrape succeeded and the same image saves
      // fine later via store-card-image.js (a server-side fetch, not
      // subject to the same block). See that file for the full story.
      const proxiedImageUrl = `${API_BASE}/preview-image-proxy?url=${encodeURIComponent(data.imageUrl)}`;
      box.querySelector(".source-thumb").style.background = `center/cover no-repeat url('${proxiedImageUrl}')`;
    } else {
      box.querySelector(".source-thumb").style.background = "linear-gradient(160deg, #262c3d, #12151d)";
    }

    const sgd = computeScrapedSGD(source, data);
    const priceLabel = sgd != null ? formatMoney(sgd) : "—";
    box.querySelector(".source-price").textContent = priceLabel;
    const condBits = [];
    if (data.condition) condBits.push(`Grade ${data.condition}`);
    if (sgd != null) condBits.push(`(${formatOriginal(data.price ?? data.ungraded, data.currency)})`);
    box.querySelector(".source-cond").textContent = condBits.length ? condBits.join(" ") : "Fetched just now";

    // Auto-fill card detail fields from whichever source answers first.
    maybeFillCardDetails(data);
  } catch (err) {
    scrapeResults[source] = null;
    box.classList.remove("pending");
    box.querySelector(".source-price").textContent = "—";
    box.querySelector(".source-cond").textContent = "Error: " + err.message;
  }
}

function computeScrapedSGD(source, data) {
  return data.price != null ? convertToSGD(data.price, data.currency || "JPY") : null;
}

async function maybeFillCardDetails(data) {
  const nameEl = document.getElementById("add-card-name");
  const originalEl = document.getElementById("add-card-name-original");
  const numberEl = document.getElementById("add-card-number");
  const rarityEl = document.getElementById("add-card-rarity");
  const statusEl = document.getElementById("translate-status");

  if (numberEl && !numberEl.value && data.cardNumber) numberEl.value = data.cardNumber;
  if (rarityEl && !rarityEl.value && data.rarity) rarityEl.value = data.rarity;
  if (originalEl && !originalEl.value && data.cardName) originalEl.value = data.cardName;

  // Auto-translate the scraped (native-language) name into the English
  // "Name" field — only once, and only if the user hasn't already typed
  // something there themselves. See translate-text.js for the important
  // caveat about the translation endpoint this relies on.
  if (nameEl && !nameEl.value && data.cardName && !nameEl.dataset.translating) {
    nameEl.dataset.translating = "1";
    if (statusEl) statusEl.textContent = "Translating…";
    try {
      const result = await apiJson(`${API_BASE}/translate-text?text=${encodeURIComponent(data.cardName)}&from=ja&to=en`);
      if (!nameEl.value) nameEl.value = result.translated; // re-check: user may have typed while this was in flight
      if (statusEl) statusEl.textContent = "";
    } catch (err) {
      if (statusEl) statusEl.textContent = "Auto-translate failed — type the English name in manually.";
      console.warn("Translation failed:", err.message);
    } finally {
      delete nameEl.dataset.translating;
    }
  }
}

async function fetchAll() {
  await Promise.all([fetchSource("toretoku"), fetchSource("yuyutei")]);
}

// Builds the rawSources.<source> entry the record shape expects, from a
// raw scrape-card.js response, converting to SGD once here.
function buildRawSourceEntry(source, data) {
  if (!data) return null;
  const sgd = data.price != null ? convertToSGD(data.price, data.currency || "JPY") : null;
  return {
    price: sgd,
    grade: data.condition || undefined,
    note: data.price != null ? formatOriginal(data.price, data.currency || "JPY") : undefined,
    inStock: true,
    conditionBreakdown: data.conditionBreakdown || undefined,
  };
}

// Unified list of pending "additional photos" for the card currently
// being added — each entry is either { type: 'file', file: File }
// (from the Upload or Camera input, same handling either way) or
// { type: 'link', url: string } (pasted image link). Kept as one list
// so the preview row and save-time upload loop don't need to care which
// source a given photo came from.
let extraPhotos = [];

function addExtraPhotoFiles(input) {
  Array.from(input.files || []).forEach((file) => extraPhotos.push({ type: "file", file }));
  input.value = ""; // allows picking the same file again later if removed
  renderExtraPhotosPreview();
}

// Live preview for the manual "Image Link" fallback field. A direct
// <img src> hotlink, same approach renderExtraPhotosPreview() already
// uses for pasted "additional photo" links — this is a link the user
// typed/pasted themselves, not a scraped URL, so it isn't subject to the
// scraper allow-list preview-image-proxy.js enforces for the Toretoku/
// Yuyu-tei source-thumb previews above. onerror clears it silently
// rather than showing a broken-image icon if the link doesn't resolve.
function updateImageLinkPreview(url) {
  const preview = document.getElementById("add-image-link-preview");
  if (!preview) return;
  const trimmed = (url || "").trim();
  if (!trimmed) {
    preview.style.display = "none";
    preview.innerHTML = "";
    return;
  }
  preview.style.display = "block";
  preview.innerHTML = `<img src="${escapeAttr(trimmed)}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;" onerror="this.parentElement.style.display='none'; this.parentElement.innerHTML='';">`;
}

function addExtraPhotoLink() {
  const input = document.getElementById("add-extra-photo-link");
  const url = input.value.trim();
  if (!url) return;
  extraPhotos.push({ type: "link", url: normalizeUrl(url) });
  input.value = "";
  renderExtraPhotosPreview();
}

function removeExtraPhoto(index) {
  extraPhotos.splice(index, 1);
  renderExtraPhotosPreview();
}

function renderExtraPhotosPreview() {
  const preview = document.getElementById("add-extra-photos-preview");
  if (!preview) return;
  preview.innerHTML = "";
  extraPhotos.forEach((photo, i) => {
    const src = photo.type === "file" ? URL.createObjectURL(photo.file) : photo.url;
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative; width:46px; height:64px;";
    wrap.innerHTML = `
      <img src="${escapeAttr(src)}" style="width:100%; height:100%; object-fit:cover; border-radius:6px; border:1px solid var(--line);">
      <span onclick="removeExtraPhoto(${i})" style="position:absolute; top:-6px; right:-6px; width:18px; height:18px; border-radius:50%; background:var(--coral); color:#fff; font-size:11px; display:flex; align-items:center; justify-content:center; cursor:pointer;">✕</span>
    `;
    preview.appendChild(wrap);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:image/jpeg;base64,<data>" — strip the prefix
      const commaIdx = reader.result.indexOf(",");
      resolve(reader.result.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(new Error("Couldn't read file: " + file.name));
    reader.readAsDataURL(file);
  });
}

async function saveCard() {
  const statusEl = document.getElementById("add-card-status");
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

  const cardName = document.getElementById("add-card-name").value.trim();
  const cardNumber = document.getElementById("add-card-number").value.trim();
  if (!cardName || !cardNumber) {
    setStatus("Card name and card number are required.");
    return;
  }

  const purchasePriceRaw = document.getElementById("add-purchase-price").value.trim();
  const purchaseCurrency = document.getElementById("add-purchase-currency").value.trim() || "SGD";
  const received = document.getElementById("add-received-checkbox").checked;

  const record = {
    cardName,
    cardNumber,
    cardNameOriginal: valueOf("add-card-name-original"),
    artist: valueOf("add-card-artist"),
    color: [...selectedColors],
    familyType: [...familyTypeTags],
    collection: [...collectionTags],
    category: valueOf("add-card-category"),
    rarity: valueOf("add-card-rarity"),
    foilType: valueOf("add-foil-type"),
    language: valueOf("add-language") || "Japanese",
    conditionType: valueOf("add-condition-type") || "Singles",
    subCondition: valueOf("add-sub-condition"),
    gradingCompany: valueOf("add-grading-company"),
    certNumber: valueOf("add-cert-number"),
    toretokuUrl: getAddCardUrl("toretoku"),
    yuyuteiUrl: getAddCardUrl("yuyutei"),
    imageLink: valueOf("add-image-link"),
    purchasePrice: purchasePriceRaw ? Number(purchasePriceRaw) : null,
    purchaseCurrency,
    purchaseDate: new Date().toISOString().slice(0, 10),
    quantity: purchasePriceRaw ? (received ? 1 : 0) : 0,
    rawSources: {
      toretoku: buildRawSourceEntry("toretoku", scrapeResults.toretoku),
      yuyutei: buildRawSourceEntry("yuyutei", scrapeResults.yuyutei),
    },
  };
  // Drop null source entries so rawSources only holds sources actually fetched
  Object.keys(record.rawSources).forEach((k) => {
    if (!record.rawSources[k]) delete record.rawSources[k];
  });

  setStatus("Saving image…");
  try {
    const tempId = uniqueImageId(cardNumber);
    const imageBlobKeys = [];

    // Primary image, from the scrape priority order (Toretoku > Yuyu-tei),
    // or the manual "Image Link" fallback if neither was fetched. These
    // two cases need DIFFERENT storage endpoints: a scraped URL goes
    // through store-card-image.js's strict host allow-list (only
    // Toretoku/Yuyu-tei — nothing chose to trust an auto-scraped URl
    // beyond that). The manual fallback link is different — the user
    // explicitly typed/pasted it themselves, so it needs the same
    // lenient path store-external-image.js already uses for pasted
    // "additional photo" links, not the scraper allow-list. Routing a
    // manual link through the strict allow-list was the bug: any host
    // other than Toretoku/Yuyu-tei (e.g. tcgrepublic.com) silently
    // failed to save, since the failure was only console.warn'd.
    const scrapedImageUrl = pickBestImageUrl();
    const manualImageUrl = valueOf("add-image-link");
    const primaryImageUrl = scrapedImageUrl || manualImageUrl;
    if (primaryImageUrl) {
      try {
        const endpoint = scrapedImageUrl ? "store-card-image" : "store-external-image";
        const imgData = await apiJson(`${API_BASE}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: primaryImageUrl, cardId: tempId + "-0" }),
        });
        imageBlobKeys.push(imgData.blobKey);
      } catch (imgErr) {
        console.warn("Primary image storage failed:", imgErr.message);
        showToast("Card saved, but the image couldn't be stored: " + imgErr.message);
      }
    }

    // Additional images (e.g. a Slab's back photo) — from Upload, Camera,
    // or a pasted link (extraPhotos, populated by addExtraPhotoFiles() /
    // addExtraPhotoLink()), stored in placement order after the primary
    // image. Files go through upload-card-image.js (no allow-list — it's
    // the user's own device photo). Links go through
    // store-external-image.js, a deliberately more lenient path than
    // store-card-image.js's strict scraper allow-list, since these are
    // links the user explicitly chose to add, not auto-scraped data —
    // see that function's own comment for the reasoning and safety caps.
    for (let i = 0; i < extraPhotos.length; i++) {
      const photo = extraPhotos[i];
      try {
        let imgData;
        if (photo.type === "file") {
          const base64 = await fileToBase64(photo.file);
          imgData = await apiJson(`${API_BASE}/upload-card-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageBase64: base64,
              contentType: photo.file.type || "image/jpeg",
              cardId: `${tempId}-${i + 1}`,
            }),
          });
        } else {
          imgData = await apiJson(`${API_BASE}/store-external-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: photo.url, cardId: `${tempId}-${i + 1}` }),
          });
        }
        imageBlobKeys.push(imgData.blobKey);
      } catch (imgErr) {
        console.warn(`Additional photo ${i + 1} failed:`, imgErr.message);
      }
    }

    if (imageBlobKeys.length) {
      record.imageBlobKeys = imageBlobKeys;
      record.imageBlobKey = imageBlobKeys[0]; // kept for older code paths
    }

    setStatus("Saving card…");
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });

    setStatus("Saved!");
    await refreshAll();
    resetAddCardForm();
    showScreen("inventory");
  } catch (err) {
    setStatus("Save failed: " + err.message);
    console.error(err);
  }
}

// Image scrape priority per HANDOVER.md §5.2/§6: Toretoku > Yuyu-tei
function pickBestImageUrl() {
  if (scrapeResults.toretoku && scrapeResults.toretoku.imageUrl) return scrapeResults.toretoku.imageUrl;
  if (scrapeResults.yuyutei && scrapeResults.yuyutei.imageUrl) return scrapeResults.yuyutei.imageUrl;
  return null;
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function resetAddCardForm() {
  ["url-toretoku", "url-yuyutei", "add-card-name", "add-card-name-original",
   "add-card-artist", "add-card-number", "add-card-rarity", "add-purchase-price", "add-image-link",
   "add-sub-condition", "add-cert-number"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const translateStatusEl = document.getElementById("translate-status");
  if (translateStatusEl) translateStatusEl.textContent = "";
  ["add-card-category", "add-foil-type", "add-language", "add-condition-type", "add-grading-company", "add-purchase-currency"]
    .forEach((id) => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  const receivedEl = document.getElementById("add-received-checkbox");
  if (receivedEl) receivedEl.checked = true;
  ["add-extra-photos-file", "add-extra-photos-camera", "add-extra-photo-link"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  extraPhotos = [];
  const extraPreviewEl = document.getElementById("add-extra-photos-preview");
  if (extraPreviewEl) extraPreviewEl.innerHTML = "";
  updateImageLinkPreview("");
  resetChipFields();

  scrapeResults.toretoku = null;
  scrapeResults.yuyutei = null;
  ["toretoku", "yuyutei"].forEach((source) => {
    const box = document.getElementById("result-" + source);
    if (!box) return;
    box.classList.add("pending");
    box.querySelector(".source-thumb").style.background = "";
    box.querySelector(".source-thumb").textContent = "?";
    box.querySelector(".source-price").textContent = "—";
    box.querySelector(".source-cond").textContent = "Not fetched yet";
  });
  const statusEl = document.getElementById("add-card-status");
  if (statusEl) statusEl.textContent = "";
}

// ---- Binder: shared helpers -------------------------------------------------

function statusFilteredRecords(status) {
  return inventoryRecords
    .filter((r) => r.status === status)
    .sort((a, b) => String(a.cardNumber).localeCompare(String(b.cardNumber)));
}

function slotHtml(index, record, opts) {
  opts = opts || {};
  if (!record) {
    const emptyClass = opts.autoEmpty ? "slot auto-empty" : "slot empty";
    const onClick = opts.onEmptyClick ? ` onclick="${opts.onEmptyClick}(${index})"` : "";
    return `<div class="${emptyClass}"${onClick}><span class="slot-num">${index + 1}</span>${opts.autoEmpty ? "" : '<span class="slot-icon">＋</span>'}</div>`;
  }
  const market = computeMarketPrice(record).value;
  const purchase = purchasePriceSGD(record);
  const purchaseText = record.status === "Wanted" ? "—" : (purchase != null ? formatMoney(purchase) : "—");
  const marketText = market != null ? formatMoney(market) : "—";
  const onClick = opts.onFilledClick ? ` onclick="${opts.onFilledClick}('${escapeAttr(record.id)}', ${index})"` : "";
  const imgUrl = imageUrlFor(record);
  const bgStyle = imgUrl ? `background-image:url('${escapeAttr(imgUrl)}'); background-size:cover; background-position:center;` : "";
  return `<div class="slot filled"${onClick} style="cursor:${opts.onFilledClick ? "pointer" : "default"}; ${bgStyle}">
      <span class="slot-num">${index + 1}</span>
      <div class="slot-footer">
        <span class="slot-rarity-tag">${escapeHtml(record.rarity || "")}</span>
        <div class="slot-prices">
          <span class="slot-price-purchase">${purchaseText}</span>
          <span class="slot-price-market">${marketText}</span>
        </div>
      </div>
    </div>`;
}

// ---- Binder: Main Collection + custom binders (manually arranged) ----------

// Like slotHtml's filled case, but passes binderKey through to the click
// handler so the price-breakdown modal knows to offer "Remove from binder"
// (only meaningful for manually-placed cards, not the auto binders).
function manualSlotHtml(index, record, binderKey) {
  const market = computeMarketPrice(record).value;
  const purchase = purchasePriceSGD(record);
  const purchaseText = record.status === "Wanted" ? "—" : (purchase != null ? formatMoney(purchase) : "—");
  const marketText = market != null ? formatMoney(market) : "—";
  const imgUrl = imageUrlFor(record);
  const bgStyle = imgUrl ? `background-image:url('${escapeAttr(imgUrl)}'); background-size:cover; background-position:center;` : "";
  // Main Collection and custom binders are manually arranged — the slot
  // picker doesn't filter by status, so a Wanted or Pending Delivery
  // card (quantity=0, by definition — see card-options.json's
  // listingStatus note) CAN end up placed here, e.g. to plan where it
  // will go once it's actually bought. Dim it so it reads as "not
  // purchased yet" instead of looking identical to a card actually in
  // hand. Not applied in slotHtml() (the Wanted/Pending Delivery
  // binders themselves), since literally every card there is
  // quantity=0 — dimming would just dim everything, for no signal.
  const notPurchased = Number(record.quantity) === 0;
  const shadeOverlay = notPurchased
    ? `<div class="slot-shade"><span class="slot-shade-label">${escapeHtml(record.status)}</span></div>`
    : "";
  // No onclick here (unlike other slot renders) — tap vs. drag is
  // disambiguated in JS by attachSlotDragHandlers(), which calls
  // showPriceBreakdownFor() itself for a plain tap (no real movement).
  return `<div class="slot filled" data-slot-index="${index}" data-record-id="${escapeAttr(record.id)}" style="${bgStyle}">
      ${shadeOverlay}
      <span class="slot-num">${index + 1}</span>
      <div class="slot-footer">
        <span class="slot-rarity-tag">${escapeHtml(record.rarity || "")}</span>
        <div class="slot-prices">
          <span class="slot-price-purchase">${purchaseText}</span>
          <span class="slot-price-market">${marketText}</span>
        </div>
      </div>
    </div>`;
}

let mainBinderPage = 1;
const customBinderPage = {}; // key -> page number

function cardsForBinder(binderKey) {
  return inventoryRecords.filter((r) => r.binder && r.binder.key === binderKey);
}

function pagesForBinder(binderKey) {
  const cards = cardsForBinder(binderKey);
  const pageNumbers = new Set(cards.map((c) => c.binder.page).filter((p) => p != null));

  if (pageNumbers.size === 0) {
    // No explicit placement yet — fall back to sorting by card number
    // across pages of 9, per HANDOVER.md §7.
    const sorted = [...cards].sort((a, b) => String(a.cardNumber).localeCompare(String(b.cardNumber)));
    const pages = {};
    sorted.forEach((c, i) => {
      const page = Math.floor(i / 9) + 1;
      const slot = i % 9;
      pages[page] = pages[page] || Array(9).fill(null);
      pages[page][slot] = c;
    });
    return pages;
  }

  const pages = {};
  for (const p of pageNumbers) pages[p] = Array(9).fill(null);
  cards.forEach((c) => {
    if (c.binder.page != null && c.binder.slot != null) {
      pages[c.binder.page] = pages[c.binder.page] || Array(9).fill(null);
      pages[c.binder.page][c.binder.slot] = c;
    }
  });
  return pages;
}

function renderMainBinder() {
  renderManualBinder("main", "main-binder-grid", "main-page-label", "main-page-sub", "main-prev-btn", "main-next-btn", () => mainBinderPage, (p) => { mainBinderPage = p; });
}

function renderManualBinder(binderKey, gridId, labelId, subId, prevBtnId, nextBtnId, getPage, setPage) {
  const gridEl = document.getElementById(gridId);
  if (!gridEl) return;

  const pages = pagesForBinder(binderKey);
  const pageNumbers = Object.keys(pages).map(Number).sort((a, b) => a - b);
  if (pageNumbers.length === 0) pageNumbers.push(1);
  if (!pages[pageNumbers[0]]) pages[pageNumbers[0]] = Array(9).fill(null);

  // Pages the user can actually be on: every real page (has a card
  // somewhere on it) plus every blank page needed to reach either one
  // past the last real page, OR whatever blank page is already being
  // requested — whichever is further. That second part matters:
  // without it, clicking "next" repeatedly across several blank pages
  // in a row (nothing placed yet on any of them) silently bounced back
  // to page 1 on the second click, because pagesForBinder() only ever
  // reports pages that already have a card in them, so a fresh render
  // recomputing "one past the last real page" from scratch would never
  // reach further than page 2 no matter how many times "next" was
  // clicked. Building the full contiguous range up to whichever page
  // is actually requested also means a real gap (cards on page 1 and 3
  // but nothing on 2) is still navigable in order, not skipped.
  const maxReal = pageNumbers[pageNumbers.length - 1];
  const requested = Number(getPage());
  const maxDisplayable = Math.max(maxReal + 1, Number.isFinite(requested) ? requested : 0);
  const displayablePages = [];
  for (let p = pageNumbers[0]; p <= maxDisplayable; p++) displayablePages.push(p);

  let current = requested;
  if (!displayablePages.includes(current)) current = pageNumbers[0];
  setPage(current);

  const slots = pages[current] || Array(9).fill(null);
  gridEl.innerHTML = slots.map((rec, i) => {
    if (!rec) {
      return `<div class="slot empty" data-slot-index="${i}" onclick="openSlotPicker('${binderKey}', ${current}, ${i})"><span class="slot-num">${i + 1}</span><span class="slot-icon">＋</span></div>`;
    }
    return manualSlotHtml(i, rec, binderKey);
  }).join("");
  attachSlotDragHandlers(gridEl, binderKey, current);

  const labelEl = document.getElementById(labelId);
  const subEl = document.getElementById(subId);
  if (labelEl) labelEl.textContent = "Page " + current;
  if (subEl) subEl.textContent = cardsForBinder(binderKey).length + " card(s) in this binder";

  const idx = displayablePages.indexOf(current);
  const prevBtn = document.getElementById(prevBtnId);
  const nextBtn = document.getElementById(nextBtnId);
  if (prevBtn) {
    prevBtn.classList.toggle("disabled", idx <= 0);
    prevBtn.onclick = () => { if (idx > 0) { setPage(displayablePages[idx - 1]); renderManualBinder(binderKey, gridId, labelId, subId, prevBtnId, nextBtnId, getPage, setPage); } };
  }
  if (nextBtn) {
    nextBtn.onclick = () => {
      const atEnd = idx >= displayablePages.length - 1;
      const nextPage = atEnd ? displayablePages[displayablePages.length - 1] + 1 : displayablePages[idx + 1];
      setPage(nextPage);
      renderManualBinder(binderKey, gridId, labelId, subId, prevBtnId, nextBtnId, getPage, setPage);
    };
  }
}

// ---- Binder: drag-to-reposition within a page ------------------------------
// Pointer events (not HTML5 native drag-and-drop) so this works with touch
// on mobile Safari, not just mouse. A short tap (no real movement) still
// opens the price breakdown sheet — same behavior as before, just handled
// here instead of via a plain onclick, so it can be told apart from a drag.

const DRAG_THRESHOLD_PX = 12;

// Whether a slot-reposition drag is actively engaged right now — checked
// by setupBinderSwipe() so a single continuous gesture can't be
// interpreted as BOTH a slot drag and a page swipe. See
// attachSlotDragHandlers()'s hold-to-arm comment for why this exists.
let slotDragEngaged = false;

// Slot dragging requires a brief hold before it engages (SLOT_HOLD_MS),
// the same "press and hold, then drag" pattern as rearranging home-screen
// icons on a phone. This exists specifically to coexist with page-swipe:
// both gestures start the same way (finger down on a card, then move
// horizontally), so without some way to tell them apart, a normal swipe
// across the page — which naturally starts on top of a card, since cards
// cover most of the grid — got eaten by drag-detection and could never
// reach the page-swipe handler. Requiring a hold first means a quick
// swipe is free to be treated as page navigation, while deliberately
// holding a card down before moving it is a reposition attempt.
const SLOT_HOLD_MS = 180;
const SLOT_HOLD_CANCEL_PX = 10; // moving this far before the hold completes cancels the drag attempt entirely

function attachSlotDragHandlers(gridEl, binderKey, page) {
  let drag = null; // { fromIndex, recordId, slotEl, startX, startY, moved, armed }
  let holdTimer = null;

  gridEl.onpointerdown = (e) => {
    const slotEl = e.target.closest(".slot.filled");
    if (!slotEl || !gridEl.contains(slotEl)) return;
    drag = {
      fromIndex: Number(slotEl.dataset.slotIndex),
      recordId: slotEl.dataset.recordId,
      slotEl,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      armed: false,
    };
    holdTimer = setTimeout(() => {
      if (!drag) return;
      drag.armed = true;
      drag.slotEl.classList.add("drag-armed");
    }, SLOT_HOLD_MS);
  };

  gridEl.onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.armed) {
      // Moving before the hold completes means this is a swipe, not a
      // hold-then-drag — abandon the drag attempt and let the page-swipe
      // handler (which sees the same pointer events, since nothing here
      // captured them) decide what this gesture means instead.
      if (Math.hypot(dx, dy) > SLOT_HOLD_CANCEL_PX) {
        clearTimeout(holdTimer);
        drag = null;
      }
      return;
    }

    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
      slotDragEngaged = true;
      drag.slotEl.classList.add("dragging");
      drag.slotEl.setPointerCapture(e.pointerId);
    }
    if (drag.moved) {
      drag.slotEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.06)`;
      gridEl.querySelectorAll(".slot.drop-target").forEach((s) => s.classList.remove("drop-target"));
      const target = slotElementUnderPoint(gridEl, e.clientX, e.clientY);
      if (target && target !== drag.slotEl) target.classList.add("drop-target");
    }
  };

  gridEl.onpointerup = async (e) => {
    clearTimeout(holdTimer);
    if (!drag) return;
    const { slotEl, fromIndex, moved } = drag;
    slotEl.classList.remove("dragging", "drag-armed");
    slotEl.style.transform = "";
    gridEl.querySelectorAll(".slot.drop-target").forEach((s) => s.classList.remove("drop-target"));
    slotDragEngaged = false;

    if (!moved) {
      // A plain tap (with or without an incomplete hold) — open the
      // price breakdown, same as clicking used to.
      showPriceBreakdownFor(drag.recordId, binderKey);
    } else {
      const target = slotElementUnderPoint(gridEl, e.clientX, e.clientY);
      if (target && target !== slotEl) {
        const toIndex = Number(target.dataset.slotIndex);
        await repositionBinderSlot(binderKey, page, fromIndex, toIndex);
      }
    }
    drag = null;
  };

  gridEl.onpointercancel = () => {
    clearTimeout(holdTimer);
    slotDragEngaged = false;
    if (drag) {
      drag.slotEl.classList.remove("dragging", "drag-armed");
      drag.slotEl.style.transform = "";
      gridEl.querySelectorAll(".slot.drop-target").forEach((s) => s.classList.remove("drop-target"));
    }
    drag = null;
  };
}

function slotElementUnderPoint(gridEl, x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el.classList && el.classList.contains("slot") && gridEl.contains(el)) return el;
  }
  return null;
}

// Moves the card at fromIndex to toIndex on the given binder page. If
// toIndex is occupied, the two cards swap; if empty, it's a plain move.
// Also "commits" every OTHER card currently shown on this page to an
// explicit binder.page/slot (matching what's on screen) — needed because
// a page with no explicit placement yet renders via a computed fallback
// sort (see pagesForBinder()), and a drag should lock in a real
// arrangement, not just the two cards touched, or an untouched card could
// appear to silently jump position next render.
async function repositionBinderSlot(binderKey, page, fromIndex, toIndex) {
  const pages = pagesForBinder(binderKey);
  const slots = pages[page] || Array(9).fill(null);
  const fromRecord = slots[fromIndex];
  if (!fromRecord || fromIndex === toIndex) return;

  const updates = [];
  slots.forEach((rec, i) => {
    if (!rec) return;
    let targetSlot = i;
    if (i === fromIndex) targetSlot = toIndex;
    else if (i === toIndex) targetSlot = fromIndex;
    const alreadyCorrect = rec.binder && rec.binder.key === binderKey && rec.binder.page === page && rec.binder.slot === targetSlot;
    if (!alreadyCorrect) {
      updates.push({ ...rec, binder: { key: binderKey, page, slot: targetSlot } });
    }
  });
  if (updates.length === 0) return;

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: updates }),
    });
    await refreshAll();
    rerenderBinderScreen();
  } catch (err) {
    showToast("Couldn't reposition card: " + err.message);
  }
}

let pendingSlotAssignment = null; // { binderKey, page, slot }

function openSlotPicker(binderKey, page, slotIndex) {
  pendingSlotAssignment = { binderKey, page, slot: slotIndex };
  document.getElementById("slot-picker-search").value = "";
  renderSlotPickerResults("");
  document.getElementById("slot-picker-modal").classList.add("open");
}

function closeSlotPicker() {
  document.getElementById("slot-picker-modal").classList.remove("open");
  pendingSlotAssignment = null;
}

function onSlotPickerSearch(value) {
  renderSlotPickerResults(value);
}

function renderSlotPickerResults(term) {
  const listEl = document.getElementById("slot-picker-results");
  if (!listEl) return;
  const q = (term || "").trim().toLowerCase();
  const unplaced = inventoryRecords.filter((r) => {
    const placedElsewhere = r.binder && r.binder.key;
    const matches = !q || `${r.cardName} ${r.cardNumber}`.toLowerCase().includes(q);
    return matches && !placedElsewhere;
  }).slice(0, 30);

  if (unplaced.length === 0) {
    listEl.innerHTML = `<div class="inv-loading" style="margin:10px 0;">No unplaced cards match. (Cards already in a binder must be removed from it first.)</div>`;
    return;
  }

  listEl.innerHTML = unplaced.map((r) => {
    const imgUrl = imageUrlFor(r);
    const thumbInner = imgUrl
      ? `<img src="${escapeAttr(imgUrl)}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;">`
      : "";
    return `
    <div class="row-card" style="cursor:pointer; margin:0 0 8px;" onclick="assignCardToSlot('${escapeAttr(r.id)}')">
      <div class="thumb">${thumbInner}</div>
      <div>
        <div class="row-title">${escapeHtml(r.cardName)}</div>
        <div class="row-sub">${escapeHtml(r.cardNumber)} · ${escapeHtml(r.rarity || "")}</div>
      </div>
    </div>
  `;
  }).join("");
}

async function assignCardToSlot(recordId) {
  if (!pendingSlotAssignment) return;
  const { binderKey, page, slot } = pendingSlotAssignment;
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...record, binder: { key: binderKey, page, slot } }),
    });
    closeSlotPicker();
    await refreshAll();
    rerenderBinderScreen();
  } catch (err) {
    showToast("Couldn't place card: " + err.message);
  }
}

function openBinderCardDetail(recordId) {
  showPriceBreakdownFor(recordId);
}

// Clears a card's binder placement (sets binder to null) so it becomes
// "unplaced" again and can be assigned to any slot via openSlotPicker.
// Does NOT delete the card itself — only its binder placement.
async function removeCardFromBinder(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...record, binder: null }),
    });

    closePriceBreakdown();
    await refreshAll();
    rerenderBinderScreen();
    showToast(`${record.cardName} removed from binder.`);
  } catch (err) {
    showToast("Couldn't remove card: " + err.message);
  }
}

// Swaps out the card in a manual-binder slot for a different one, without
// the two-step "open detail → remove → tap the now-empty slot → pick a
// replacement" that was previously the only way to do this. Clears the
// current occupant's placement first (leaving it unplaced, same as
// "Remove from this binder"), THEN opens the slot picker targeted at that
// exact page/slot — assignCardToSlot() doesn't clear whatever card is
// already there, so skipping this step would leave both cards claiming
// the same slot.
async function changeCardInSlot(recordId, binderKey) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record || !record.binder) return;
  const { page, slot } = record.binder;

  closePriceBreakdown();
  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...record, binder: null }),
    });
    await refreshAll();
    rerenderBinderScreen();
    openSlotPicker(binderKey, page, slot);
  } catch (err) {
    showToast("Couldn't change card: " + err.message);
  }
}

function rerenderBinderScreen() {
  renderMainBinder();
  renderAutoBinders();
  customBinders.forEach((b) => renderCustomBinder(b.key));
}

// ---- Binder: Pending Delivery / Wanted (auto, virtual) ---------------------

function renderAutoBinders() {
  renderAutoBinderGrid("pending", "Pending Delivery");
  renderAutoBinderGrid("wanted", "Wanted");
}

let pendingBinderPage = 1;
let wantedBinderPage = 1;

// Wanted cards sort by an explicit, user-set priority (see
// setWantedPriority) — a card with no priority yet sorts after every
// explicitly-ranked one, falling back to Card Number so the order
// stays stable and predictable before anyone's ranked anything.
// Pending Delivery (and everything else) keeps statusFilteredRecords'
// own plain Card Number sort untouched.
function sortedRecordsForBinder(status) {
  const records = statusFilteredRecords(status);
  if (status !== "Wanted") return records;
  return [...records].sort((a, b) => {
    const pa = a.priority != null ? Number(a.priority) : Infinity;
    const pb = b.priority != null ? Number(b.priority) : Infinity;
    if (pa !== pb) return pa - pb;
    return String(a.cardNumber).localeCompare(String(b.cardNumber));
  });
}

function renderAutoBinderGrid(binderKey, status) {
  const gridEl = document.querySelector(`#binder-view-${binderKey} .binder-grid`);
  if (!gridEl) return;

  // Paginated the same 9-per-page way Main Collection/custom binders
  // are — this used to just take the first 9 records and stop, with no
  // way to see the rest at all once a binder passed 9 cards.
  const allRecords = sortedRecordsForBinder(status);
  const totalPages = Math.max(1, Math.ceil(allRecords.length / 9));
  let page = binderKey === "pending" ? pendingBinderPage : wantedBinderPage;
  page = Math.min(Math.max(1, page), totalPages);
  if (binderKey === "pending") pendingBinderPage = page; else wantedBinderPage = page;

  const slots = Array(9).fill(null);
  allRecords.slice((page - 1) * 9, page * 9).forEach((r, i) => { slots[i] = r; });

  // Pending Delivery, in select mode: tapping a filled slot toggles
  // selection instead of opening the detail sheet, sharing the same
  // pendingSelectedIds state (and staying in sync with) the list below.
  if (binderKey === "pending" && pendingSelectMode) {
    gridEl.innerHTML = slots.map((rec, i) => pendingSelectableSlotHtml(i, rec)).join("");
  } else {
    gridEl.innerHTML = slots.map((rec, i) => slotHtml(i, rec, { autoEmpty: true, onFilledClick: binderKey === "wanted" ? "openPurchaseModalFor" : "openBinderCardDetail" })).join("");
  }

  const labelEl = document.getElementById(binderKey + "-page-label");
  if (labelEl) labelEl.textContent = `Page ${page} of ${totalPages}`;

  // Unlike Main Collection/custom binders, there's no "create a new page
  // by going past the end" here — this binder's pages are entirely
  // derived from however many Wanted/Pending cards currently exist, so
  // both buttons just disable at their real bound.
  const prevBtn = document.getElementById(binderKey + "-prev-btn");
  const nextBtn = document.getElementById(binderKey + "-next-btn");
  if (prevBtn) {
    prevBtn.classList.toggle("disabled", page <= 1);
    prevBtn.onclick = () => {
      if (binderKey === "pending") pendingBinderPage = Math.max(1, pendingBinderPage - 1);
      else wantedBinderPage = Math.max(1, wantedBinderPage - 1);
      renderAutoBinderGrid(binderKey, status);
    };
  }
  if (nextBtn) {
    nextBtn.classList.toggle("disabled", page >= totalPages);
    nextBtn.onclick = () => {
      if (binderKey === "pending") pendingBinderPage = Math.min(totalPages, pendingBinderPage + 1);
      else wantedBinderPage = Math.min(totalPages, wantedBinderPage + 1);
      renderAutoBinderGrid(binderKey, status);
    };
  }
}

function pendingSelectableSlotHtml(index, record) {
  if (!record) {
    return `<div class="slot auto-empty"><span class="slot-num">${index + 1}</span></div>`;
  }
  const selected = pendingSelectedIds.has(record.id);
  const market = computeMarketPrice(record).value;
  const purchase = purchasePriceSGD(record);
  const purchaseText = purchase != null ? formatMoney(purchase) : "—";
  const marketText = market != null ? formatMoney(market) : "—";
  const imgUrl = imageUrlFor(record);
  const bgStyle = imgUrl ? `background-image:url('${escapeAttr(imgUrl)}'); background-size:cover; background-position:center;` : "";
  return `<div class="slot filled${selected ? " selected" : ""}" style="cursor:pointer; ${bgStyle}" onclick="toggleCardSelection('${escapeAttr(record.id)}')">
      <span class="slot-num">${index + 1}</span>
      ${selected ? '<span class="slot-check-badge">✓</span>' : ""}
      <div class="slot-footer">
        <span class="slot-rarity-tag">${escapeHtml(record.rarity || "")}</span>
        <div class="slot-prices">
          <span class="slot-price-purchase">${purchaseText}</span>
          <span class="slot-price-market">${marketText}</span>
        </div>
      </div>
    </div>`;
}

// Re-ranks the whole Wanted list so the edited card lands at EXACTLY the
// typed position, shifting only the cards between its old and new spot —
// not a simple two-card swap. E.g. moving card #14 to priority 1 pushes
// cards 1-13 down to 2-14; moving card #20 to priority 6 leaves 1-5
// untouched and pushes (the old) 6-19 down to 7-20, with this card
// landing at exactly 6. Every currently-Wanted record's priority gets
// rewritten to match its resulting position (1..N, no gaps) so the
// order stays a clean total ordering even for cards that never had an
// explicit priority set before.
async function setWantedPriority(recordId, rawValue) {
  const newPriority = parseInt(rawValue, 10);
  const ordered = sortedRecordsForBinder("Wanted");
  const fromIndex = ordered.findIndex((r) => r.id === recordId);
  if (fromIndex === -1) return;

  const [moved] = ordered.splice(fromIndex, 1);
  const targetIndex = isNaN(newPriority) ? ordered.length : newPriority - 1;
  const clampedIndex = Math.max(0, Math.min(ordered.length, targetIndex));
  ordered.splice(clampedIndex, 0, moved);

  const updates = ordered.map((r, i) => ({ ...r, priority: i + 1 }));

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: updates }),
    });
    await refreshAll();
    // Jump the Wanted binder to wherever the card actually landed (9
    // per page, clampedIndex is 0-based) so the new ranking is visible
    // right away instead of leaving the view on whatever page it was
    // on before.
    wantedBinderPage = Math.floor(clampedIndex / 9) + 1;
    rerenderBinderScreen();
  } catch (err) {
    showToast("Couldn't update priority: " + err.message);
  }
}

// ---- Pending Delivery: mass selection & bulk status update ----
// pendingSelectedIds is the single source of truth for what's selected —
// both the binder-grid slots (pendingSelectableSlotHtml) and the list
// rows below read/toggle the same Set, so selecting a card either way
// stays in sync with the other.

let pendingSelectMode = false;
let pendingSelectedIds = new Set();

function toggleSelectMode(binderKey) {
  pendingSelectMode = !pendingSelectMode;
  if (!pendingSelectMode) pendingSelectedIds.clear();
  const container = document.getElementById("binder-view-" + binderKey);
  container.classList.toggle("select-mode", pendingSelectMode);
  document.getElementById(binderKey + "-select-toggle").classList.toggle("active", pendingSelectMode);
  document.getElementById(binderKey + "-select-toggle").textContent = pendingSelectMode ? "Cancel" : "Select";
  renderAutoBinderGrid(binderKey, "Pending Delivery");
  updateBulkBar(binderKey);
}

function toggleCardSelection(id) {
  if (pendingSelectedIds.has(id)) pendingSelectedIds.delete(id);
  else pendingSelectedIds.add(id);
  renderAutoBinderGrid("pending", "Pending Delivery");
  updateBulkBar("pending");
}

function updateBulkBar(binderKey) {
  const selected = binderKey === "pending" ? pendingSelectedIds.size : 0;
  const bar = document.getElementById(binderKey + "-bulk-bar");
  const countEl = document.getElementById(binderKey + "-bulk-count");
  countEl.textContent = selected + " selected";
  bar.classList.toggle("visible", selected > 0);
}

function showToast(message) {
  const toast = document.getElementById("binder-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function bulkUpdate(binderKey, action) {
  const ids = Array.from(pendingSelectedIds);
  if (ids.length === 0) return;

  const records = ids.map((id) => {
    const r = inventoryRecords.find((rec) => rec.id === id);
    if (action === "wanted") {
      return { ...r, purchasePrice: null, quantity: 0 };
    }
    return { ...r, quantity: 1 }; // delivered
  });

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });

    const verb = action === "delivered" ? "marked Delivered (now Purchased)" : "marked Wanted (purchase price cleared)";
    showToast(`${ids.length} card(s) ${verb}.`);
    toggleSelectMode(binderKey); // clears selection + exits select mode
    await refreshAll();
    rerenderBinderScreen();
  } catch (err) {
    showToast("Bulk update failed: " + err.message);
  }
}

// ---- Wanted: single-card purchase flow ----

let purchaseCardId = null;

function openPurchaseModalFor(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;
  purchaseCardId = recordId;
  document.getElementById("purchase-modal-title").textContent = record.cardName;
  document.getElementById("purchase-modal-sub").textContent = `${record.cardNumber} · ${record.language || ""}`;
  document.getElementById("purchase-priority-input").value = record.priority != null ? record.priority : "";
  document.getElementById("purchase-price-input").value = "";
  document.getElementById("purchase-currency-input").value = record.purchaseCurrency || "SGD";
  document.getElementById("purchase-modal").classList.add("open");
}

// Separate from resolvePurchase() below on purpose — setting a priority
// is just reordering the Wanted list, not a purchase decision, so it
// shouldn't force the card to become Purchased/Pending. Re-opens the
// same card's popup afterward (rather than closing outright) so the
// updated ranking is visible immediately if the person wants to keep
// adjusting it.
// Closes the pop-up and lands on whichever page the card actually moved
// to (see setWantedPriority) rather than reopening any card's detail —
// the person just wants to see the result of the reorder in place.
async function saveWantedPriorityFromModal() {
  const value = document.getElementById("purchase-priority-input").value;
  const recordId = purchaseCardId;
  await setWantedPriority(recordId, value);
  closePurchaseModal();
  showToast("Priority updated.");
}

function closePurchaseModal() {
  document.getElementById("purchase-modal").classList.remove("open");
}

async function resolvePurchase(newStatus) {
  const price = document.getElementById("purchase-price-input").value.trim();
  const currency = document.getElementById("purchase-currency-input").value.trim() || "SGD";
  if (!price) {
    showToast("Enter a purchase price first — Wanted cards need one to move status.");
    return;
  }
  const record = inventoryRecords.find((r) => r.id === purchaseCardId);
  if (!record) return;

  try {
    await apiJson(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...record,
        purchasePrice: Number(price),
        purchaseCurrency: currency,
        purchaseDate: new Date().toISOString().slice(0, 10),
        quantity: newStatus === "purchased" ? 1 : 0,
      }),
    });

    closePurchaseModal();
    showToast(`${record.cardName} saved as ${newStatus === "purchased" ? "Purchased (in hand)" : "Pending Delivery"}.`);
    await refreshAll();
    rerenderBinderScreen();
  } catch (err) {
    showToast("Couldn't save purchase: " + err.message);
  }
}

// ---- Binder switching + custom binder creation -----------------------------

function switchBinder(key, pillEl) {
  document.querySelectorAll(".binder-view").forEach((v) => v.classList.remove("active"));
  const target = document.getElementById("binder-view-" + key);
  if (target) target.classList.add("active");

  document.querySelectorAll("#binder-switcher .binder-pill").forEach((p) => p.classList.remove("active"));
  if (pillEl) pillEl.classList.add("active");
}

function renderCustomBinderSwitcher() {
  const switcher = document.getElementById("binder-switcher");
  const viewsContainer = document.getElementById("custom-binder-views");
  if (!switcher || !viewsContainer) return;

  switcher.querySelectorAll(".binder-pill[data-custom]").forEach((p) => p.remove());
  viewsContainer.innerHTML = "";

  const newPillBtn = switcher.querySelector(".new-binder-pill");
  customBinders.forEach((binder) => {
    const pill = document.createElement("div");
    pill.className = "binder-pill";
    pill.dataset.binder = binder.key;
    pill.dataset.custom = "1";
    pill.textContent = binder.name;
    pill.onclick = () => switchBinder(binder.key, pill);
    switcher.insertBefore(pill, newPillBtn);

    const view = document.createElement("div");
    view.className = "binder-view";
    view.id = "binder-view-" + binder.key;
    view.innerHTML = `
      <div class="binder-header">
        <div class="binder-nav-btn" id="${binder.key}-prev-btn">‹</div>
        <div><div class="page-label" style="text-align:center;" id="${binder.key}-page-label">Page 1</div><div class="page-sub" id="${binder.key}-page-sub">${escapeHtml(binder.name)}</div></div>
        <div class="binder-nav-btn" id="${binder.key}-next-btn">›</div>
      </div>
      <div style="text-align:center; margin:-6px 0 12px;">
        <span style="font-family:var(--mono); font-size:10px; letter-spacing:0.04em; color:var(--coral); cursor:pointer;" onclick="confirmDeleteBinder('${escapeAttr(binder.key)}', '${escapeAttr(binder.name)}')">🗑 Delete this binder</span>
      </div>
      <div class="binder-page">
        <div class="binder-grid" id="${binder.key}-grid"></div>
      </div>
    `;
    viewsContainer.appendChild(view);
    customBinderPage[binder.key] = 1;
    renderCustomBinder(binder.key);
  });
}

function renderCustomBinder(key) {
  renderManualBinder(
    key,
    `${key}-grid`,
    `${key}-page-label`,
    `${key}-page-sub`,
    `${key}-prev-btn`,
    `${key}-next-btn`,
    () => customBinderPage[key] || 1,
    (p) => { customBinderPage[key] = p; }
  );
}

function openNewBinderModal() {
  document.getElementById("new-binder-name").value = "";
  document.getElementById("new-binder-modal").classList.add("open");
}

function closeNewBinderModal() {
  document.getElementById("new-binder-modal").classList.remove("open");
}

async function createBinder() {
  const nameInput = document.getElementById("new-binder-name");
  const name = nameInput.value.trim() || "Untitled Binder";

  try {
    const data = await apiJson(`${API_BASE}/binders-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    customBinders = data.binders;
    renderCustomBinderSwitcher();
    closeNewBinderModal();

    const pill = document.querySelector(`.binder-pill[data-binder="${data.binder.key}"]`);
    switchBinder(data.binder.key, pill);
  } catch (err) {
    showToast("Couldn't create binder: " + err.message);
  }
}

function confirmDeleteBinder(key, name) {
  const ok = window.confirm(
    `Delete "${name}"? Any cards placed in it won't be deleted — they'll just need to be re-assigned to a binder (they'll still show up in Inventory).`
  );
  if (ok) deleteBinder(key);
}

async function deleteBinder(key) {
  try {
    const data = await apiJson(`${API_BASE}/binders-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, delete: true }),
    });

    customBinders = data.binders;
    renderCustomBinderSwitcher();
    const mainPill = document.querySelector('.binder-pill[data-binder="main"]');
    switchBinder("main", mainPill);
    showToast("Binder deleted.");
  } catch (err) {
    showToast("Couldn't delete binder: " + err.message);
  }
}

// ---- Screen navigation -------------------------------------------------------

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
  document.querySelectorAll(".nav-item[data-screen]").forEach((item) => {
    item.classList.toggle("active", item.dataset.screen === name);
  });
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

// ---- tiny helpers ---------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
