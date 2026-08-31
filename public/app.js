// public/app.js
//
// Full frontend logic for TangStash. Everything (Dashboard, Inventory,
// Binder, Add Card, xlsx import) lives here now — the old inline <script>
// in index.html that ran on hardcoded mock data has been removed.
//
// Pricing formula (mirrors netlify/functions/scrape-card.js's documented
// roles, see HANDOVER.md §5.2):
//   Singles = average of Toretoku + Yuyu-tei (whichever are available);
//             PriceCharting Ungraded is a last resort, used only when
//             neither Toretoku nor Yuyu-tei has data.
//   Slabs   = PriceCharting PSA10 price, sole reference.
//
// Currency: rawSources prices are always stored already-converted to SGD
// (the app's base reporting currency). The original-currency amount is
// kept in each source's `note` field for display, e.g. "(¥21,600)". The
// conversion happens once, at scrape/save time in the Add Card flow (see
// buildRawSourceEntry() below) — nothing re-converts on every render.

const API_BASE = "/.netlify/functions";

// ---- Global state --------------------------------------------------------

let inventoryRecords = [];
let customBinders = []; // [{ key, name, createdAt }]
let fxRates = null; // { base: "SGD", rates: { JPY, AUD, CNY, MYR, USD }, fetchedAt }
const currentFilters = { listing: "All", language: "All", set: "All", subset: "All", rarity: "All" };
let inventorySearchTerm = "";

// ---- Boot -----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
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
function setupBinderSwipe() {
  const screen = document.getElementById("screen-binder");
  if (!screen) return;
  let startX = null;
  screen.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".binder-page")) startX = e.clientX;
  });
  screen.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 40) {
      const activeView = screen.querySelector(".binder-view.active");
      if (activeView) {
        const nextBtn = activeView.querySelector(".binder-nav-btn:last-of-type");
        const prevBtn = activeView.querySelector(".binder-nav-btn:first-of-type");
        const btn = dx < 0 ? nextBtn : prevBtn;
        if (btn && !btn.classList.contains("disabled")) btn.click();
      }
    }
    startX = null;
  });
}

async function loadInventory() {
  try {
    const res = await fetch(`${API_BASE}/inventory-list`);
    if (!res.ok) throw new Error(`inventory-list returned ${res.status}`);
    const data = await res.json();
    inventoryRecords = data.records || [];
  } catch (err) {
    inventoryRecords = [];
    console.error("Failed to load inventory:", err);
  }
}

async function loadBinders() {
  try {
    const res = await fetch(`${API_BASE}/binders-list`);
    if (!res.ok) throw new Error(`binders-list returned ${res.status}`);
    const data = await res.json();
    customBinders = data.binders || [];
  } catch (err) {
    customBinders = [];
    console.error("Failed to load binders:", err);
  }
}

async function loadFxRates() {
  try {
    const res = await fetch(`${API_BASE}/fx-rate`);
    if (!res.ok) throw new Error(`fx-rate returned ${res.status}`);
    fxRates = await res.json();
  } catch (err) {
    fxRates = null;
    console.error("Failed to load FX rates:", err);
  }
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

function formatOriginal(amount, currency) {
  if (amount == null) return "";
  const symbols = { JPY: "¥", USD: "$", SGD: "S$", AUD: "A$", CNY: "¥", MYR: "RM" };
  const symbol = symbols[currency] || currency + " ";
  return symbol + Number(amount).toLocaleString();
}

// ---- Pricing ---------------------------------------------------------------

function computeMarketPrice(record) {
  const src = record.rawSources || {};
  const isSlab = record.conditionType === "Slabs";

  if (isSlab) {
    const psa10 = src.pricecharting?.psa10;
    return { value: psa10 ?? null, label: "PriceCharting PSA10 (Slab reference)" };
  }

  const vals = [];
  if (src.toretoku?.price != null) vals.push(src.toretoku.price);
  if (src.yuyutei?.price != null) vals.push(src.yuyutei.price);

  if (vals.length) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const label = vals.length === 2 ? "Average of Toretoku + Yuyu-tei" : `From ${src.toretoku ? "Toretoku" : "Yuyu-tei"} only`;
    return { value: avg, label };
  }

  const ungraded = src.pricecharting?.ungraded;
  return { value: ungraded ?? null, label: "PriceCharting Ungraded (last resort — no Toretoku/Yuyu-tei data)" };
}

function formatMoney(value) {
  if (value == null) return "—";
  return "S$" + value.toFixed(2).replace(/\.00$/, "");
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
  if (record.imageBlobKey) {
    return `${API_BASE}/serve-card-image?key=${encodeURIComponent(record.imageBlobKey)}`;
  }
  return null;
}

// ---- Dashboard --------------------------------------------------------------

function renderDashboard() {
  const heroValueEl = document.getElementById("dash-hero-value");
  if (!heroValueEl) return; // dashboard not in DOM

  const purchased = inventoryRecords.filter((r) => r.status === "Purchased");
  const pending = inventoryRecords.filter((r) => r.status === "Pending Delivery");
  const wanted = inventoryRecords.filter((r) => r.status === "Wanted");
  const slabs = inventoryRecords.filter((r) => r.conditionType === "Slabs");

  let totalValue = 0;
  let totalCost = 0;
  purchased.forEach((r) => {
    const market = computeMarketPrice(r).value;
    const cost = purchasePriceSGD(r);
    if (market != null) totalValue += market;
    if (cost != null) totalCost += cost;
  });
  pending.forEach((r) => {
    const cost = purchasePriceSGD(r);
    if (cost != null) totalCost += cost; // money already spent, counts toward "in the collection"
  });

  const profit = totalValue - totalCost;

  heroValueEl.textContent = formatMoney(totalValue);
  const profitEl = document.getElementById("dash-hero-profit");
  if (profitEl) {
    profitEl.textContent = (profit >= 0 ? "+ " : "\u2212 ") + formatMoney(Math.abs(profit)) + (profit >= 0 ? " profit" : " loss");
    profitEl.classList.toggle("down", profit < 0);
  }

  const uniqueCardNumbers = new Set(inventoryRecords.map((r) => r.cardNumber)).size;

  setText("dash-stat-total", purchased.reduce((n, r) => n + (Number(r.quantity) || 0), 0) + pending.length);
  setText("dash-stat-unique", uniqueCardNumbers);
  setText("dash-stat-slabs", slabs.length);
  setText("dash-stat-pending", pending.length);

  // "Top by value" replaces the old "Biggest movers" — no price history is
  // tracked (see HANDOVER.md §9), so a real "movers" list isn't possible.
  // Highest-value purchased cards is the useful, honest substitute.
  const topByValue = [...purchased]
    .map((r) => ({ record: r, value: computeMarketPrice(r).value }))
    .filter((x) => x.value != null)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  renderDashRows("dash-top-value", topByValue.map((x) => x.record), (r) => formatMoney(computeMarketPrice(r).value));

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

  listEl.innerHTML = sorted.map(renderInventoryRow).join("");
}

function renderInventoryRow(record) {
  const market = computeMarketPrice(record);
  const priceText = market.value != null ? formatMoney(market.value) : "—";
  const { set, subset } = parseCardNumber(record.cardNumber);
  const qtyBadge =
    record.status === "Wanted" ? "On wishlist" :
    record.status === "Pending Delivery" ? "Pending arrival" :
    "×1 copy"; // v1: quantity is a 0/1 received-flag per row, not a multi-copy count

  const img = imageUrlFor(record);
  const thumbInner = img
    ? `<img src="${escapeAttr(img)}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:5px;">`
    : "";

  return `
    <div class="inv-item"
         data-listing="${escapeAttr(record.status)}"
         data-language="${escapeAttr(record.language)}"
         data-set="${escapeAttr(set)}"
         data-subset="${escapeAttr(subset)}"
         data-rarity="${escapeAttr(record.rarity)}">
      <div class="inv-thumb">${thumbInner}<span class="rarity-tag">${escapeHtml(record.rarity || "")}</span></div>
      <div class="inv-mid">
        <div class="inv-name">${escapeHtml(record.cardName)}</div>
        <div class="inv-meta">${escapeHtml(record.cardNumber)} · ${escapeHtml(record.language || "")} · ${escapeHtml(record.category || "")}</div>
        <div class="inv-qty-badge">${qtyBadge}</div>
      </div>
      <div class="inv-right">
        <div class="price-line">
          <div class="inv-price">${priceText}</div>
          <div class="info-btn" onclick="event.stopPropagation(); showPriceBreakdownFor('${escapeAttr(record.id)}')">?</div>
        </div>
      </div>
    </div>
  `;
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
  const fieldValue = { listing: record.status, language: record.language, set, subset, rarity: record.rarity };

  return Object.keys(currentFilters).every((key) => {
    const wanted = currentFilters[key];
    return wanted === "All" || fieldValue[key] === wanted;
  });
}

function toggleFilterMenu(key) {
  document.querySelectorAll(".filter-dropdown").forEach((d) => {
    if (d.id !== "fd-" + key) d.classList.remove("open");
  });
  document.getElementById("fd-" + key).classList.toggle("open");
}

function selectFilter(key, value, optionEl) {
  currentFilters[key] = value;
  document.getElementById("fp-" + key).textContent = { listing: "Listing", language: "Language", set: "Set", subset: "Sub-Set", rarity: "Rarity" }[key] + ": " + value;
  document.getElementById("fp-" + key).classList.toggle("active-filter", value !== "All");

  const menu = document.getElementById("fd-" + key);
  menu.querySelectorAll(".filter-option").forEach((o) => o.classList.remove("selected"));
  optionEl.classList.add("selected");
  menu.classList.remove("open");

  renderInventory();
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".filter-item")) {
    document.querySelectorAll(".filter-dropdown").forEach((d) => d.classList.remove("open"));
  }
});

// ---- Price breakdown modal -------------------------------------------------

function showPriceBreakdownFor(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;

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
    const noPrimarySources = !src.toretoku && !src.yuyutei;
    rows.push(
      isSlab
        ? { dotType: "lastresort", name: "PriceCharting · PSA10", tag: "Slab reference price", priceText: src.pricecharting.psa10 != null ? formatMoney(src.pricecharting.psa10) : "—", muted: false }
        : { dotType: "lastresort", name: "PriceCharting · Ungraded", tag: noPrimarySources ? "Used as last resort" : "Not used (Toretoku/Yuyu-tei available)", priceText: src.pricecharting.ungraded != null ? formatMoney(src.pricecharting.ungraded) : "—", muted: !noPrimarySources }
    );
  }

  document.getElementById("pm-title").textContent = record.cardName;
  document.getElementById("pm-sub").textContent = record.cardNumber;
  const hasAnyUrl = record.toretokuUrl || record.yuyuteiUrl || record.pricechartingUrl;
  document.getElementById("pm-rows").innerHTML = `
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
    ? `<button class="save-btn" id="pm-refresh-btn" style="margin-top:12px; width:100%;" onclick="refreshPriceFor('${escapeAttr(record.id)}')">↻ Refresh price from saved URLs</button>`
    : "");

  document.getElementById("price-modal").classList.add("open");
}

// Re-scrapes whichever of toretokuUrl/yuyuteiUrl/pricechartingUrl are saved
// on a record (e.g. from an xlsx import, or an older Add Card save) and
// updates its rawSources + image in place. Same conversion/priority rules
// as the Add Card flow (buildRawSourceEntry, image priority Toretoku >
// Yuyu-tei > PriceCharting).
async function refreshPriceFor(recordId) {
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;
  const btn = document.getElementById("pm-refresh-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }

  const sourceUrls = { toretoku: record.toretokuUrl, yuyutei: record.yuyuteiUrl, pricecharting: record.pricechartingUrl };
  const fetched = {};
  const rawSources = { ...(record.rawSources || {}) };

  for (const [key, rawUrl] of Object.entries(sourceUrls)) {
    if (!rawUrl) continue;
    try {
      const res = await fetch(`${API_BASE}/scrape-card?url=${encodeURIComponent(normalizeUrl(rawUrl))}`);
      const data = await res.json();
      if (res.ok) {
        fetched[key] = data;
        rawSources[key] = buildRawSourceEntry(key, data);
      }
    } catch (err) {
      console.warn(`Refresh failed for ${key}:`, err.message);
    }
  }

  const updated = { ...record, rawSources };

  const imageUrl = (fetched.toretoku && fetched.toretoku.imageUrl)
    || (fetched.yuyutei && fetched.yuyutei.imageUrl)
    || (fetched.pricecharting && fetched.pricecharting.imageUrl);
  if (imageUrl) {
    try {
      const tempId = "tmp-" + String(record.cardNumber || record.id).replace(/[^a-z0-9]/gi, "-").toLowerCase();
      const imgRes = await fetch(`${API_BASE}/store-card-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, cardId: tempId }),
      });
      const imgData = await imgRes.json();
      if (imgRes.ok) updated.imageBlobKey = imgData.blobKey;
    } catch (err) {
      console.warn("Image refresh failed:", err.message);
    }
  }

  try {
    const res = await fetch(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");
    await refreshAll();
    showPriceBreakdownFor(recordId);
    showToast("Price refreshed.");
  } catch (err) {
    showToast("Refresh failed: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh price from saved URLs"; }
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
  ["Card Number", "cardNumber"],
  ["Category", "category"],
  ["Print Source", "printSource"],
  ["Rarity", "rarity"],
  ["Foil Type", "foilType"],
  ["Language", "language"],
  ["Quantity", "quantity"],
  ["Purchase Price", "purchasePrice"],
  ["Purchase Currency", "purchaseCurrency"],
  ["Purchase Date", "purchaseDate"],
  ["Toretoku URL", "toretokuUrl"],
  ["Yuyu-tei URL", "yuyuteiUrl"],
  ["PriceCharting URL", "pricechartingUrl"],
  ["Image Link", "imageLink"],
  ["Condition Type", "conditionType"],
  ["Sub-Condition", "subCondition"],
  ["Grading Company", "gradingCompany"],
  ["Cert Number", "certNumber"],
];

function triggerImport() {
  document.getElementById("import-file-input").click();
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
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

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
          if (value !== undefined) rec[field] = value;
        });
        if (!rec.id) delete rec.id; // blank Listing UID -> new card
        return rec;
      });

    if (records.length === 0) {
      if (statusEl) statusEl.textContent = "No valid rows found (need at least Card Name + Card Number).";
      return;
    }

    if (statusEl) statusEl.textContent = `Uploading ${records.length} card(s)…`;

    const res = await fetch(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `inventory-save returned ${res.status}`);

    if (statusEl) statusEl.textContent = `Imported ${data.saved.length} card(s). Total inventory: ${data.count}.`;
    await refreshAll();
  } catch (err) {
    if (statusEl) statusEl.textContent = "Import failed: " + err.message;
    console.error(err);
  } finally {
    input.value = ""; // allow re-selecting the same file later
  }
}

// ---- Add Card ----------------------------------------------------------------

const scrapeResults = { toretoku: null, yuyutei: null, pricecharting: null };

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
    const res = await fetch(`${API_BASE}/scrape-card?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) {
      scrapeResults[source] = null;
      box.classList.remove("pending");
      box.querySelector(".source-price").textContent = "—";
      box.querySelector(".source-cond").textContent = data.error || `Fetch failed (${res.status})`;
      return;
    }

    scrapeResults[source] = data;
    box.classList.remove("pending");
    box.querySelector(".source-thumb").textContent = "";
    if (data.imageUrl) {
      box.querySelector(".source-thumb").style.background = `center/cover no-repeat url('${data.imageUrl}')`;
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
  if (source === "pricecharting") {
    const amount = data.ungraded ?? data.price;
    return amount != null ? convertToSGD(amount, data.currency || "USD") : null;
  }
  return data.price != null ? convertToSGD(data.price, data.currency || "JPY") : null;
}

function maybeFillCardDetails(data) {
  const nameEl = document.getElementById("add-card-name");
  const numberEl = document.getElementById("add-card-number");
  const rarityEl = document.getElementById("add-card-rarity");
  if (nameEl && !nameEl.value && data.cardName) nameEl.value = data.cardName;
  if (numberEl && !numberEl.value && data.cardNumber) numberEl.value = data.cardNumber;
  if (rarityEl && !rarityEl.value && data.rarity) rarityEl.value = data.rarity;
}

async function fetchAll() {
  await Promise.all([fetchSource("toretoku"), fetchSource("yuyutei"), fetchSource("pricecharting")]);
}

// Builds the rawSources.<source> entry the record shape expects, from a
// raw scrape-card.js response, converting to SGD once here.
function buildRawSourceEntry(source, data) {
  if (!data) return null;
  if (source === "pricecharting") {
    return {
      ungraded: data.ungraded != null ? convertToSGD(data.ungraded, "USD") : null,
      psa10: data.psa10 != null ? convertToSGD(data.psa10, "USD") : null,
    };
  }
  const sgd = data.price != null ? convertToSGD(data.price, data.currency || "JPY") : null;
  return {
    price: sgd,
    grade: data.condition || undefined,
    note: data.price != null ? formatOriginal(data.price, data.currency || "JPY") : undefined,
    inStock: true,
    conditionBreakdown: data.conditionBreakdown || undefined,
  };
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
    pricechartingUrl: getAddCardUrl("pricecharting"),
    imageLink: valueOf("add-image-link"),
    purchasePrice: purchasePriceRaw ? Number(purchasePriceRaw) : null,
    purchaseCurrency,
    purchaseDate: new Date().toISOString().slice(0, 10),
    quantity: purchasePriceRaw ? (received ? 1 : 0) : 0,
    rawSources: {
      toretoku: buildRawSourceEntry("toretoku", scrapeResults.toretoku),
      yuyutei: buildRawSourceEntry("yuyutei", scrapeResults.yuyutei),
      pricecharting: buildRawSourceEntry("pricecharting", scrapeResults.pricecharting),
    },
  };
  // Drop null source entries so rawSources only holds sources actually fetched
  Object.keys(record.rawSources).forEach((k) => {
    if (!record.rawSources[k]) delete record.rawSources[k];
  });

  setStatus("Saving image…");
  try {
    const imageUrl = pickBestImageUrl();
    if (imageUrl) {
      const tempId = "tmp-" + cardNumber.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      const imgRes = await fetch(`${API_BASE}/store-card-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, cardId: tempId }),
      });
      const imgData = await imgRes.json();
      if (imgRes.ok) {
        record.imageBlobKey = imgData.blobKey;
      } else {
        console.warn("Image storage failed:", imgData.error);
      }
    }

    setStatus("Saving card…");
    const res = await fetch(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `inventory-save returned ${res.status}`);

    setStatus("Saved!");
    await refreshAll();
    resetAddCardForm();
    showScreen("inventory");
  } catch (err) {
    setStatus("Save failed: " + err.message);
    console.error(err);
  }
}

// Image scrape priority per HANDOVER.md §5.2/§6: Toretoku > Yuyu-tei > PriceCharting
function pickBestImageUrl() {
  if (scrapeResults.toretoku && scrapeResults.toretoku.imageUrl) return scrapeResults.toretoku.imageUrl;
  if (scrapeResults.yuyutei && scrapeResults.yuyutei.imageUrl) return scrapeResults.yuyutei.imageUrl;
  if (scrapeResults.pricecharting && scrapeResults.pricecharting.imageUrl) return scrapeResults.pricecharting.imageUrl;
  return null;
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function resetAddCardForm() {
  ["url-toretoku", "url-yuyutei", "url-pricecharting", "add-card-name", "add-card-number",
   "add-card-rarity", "add-purchase-price", "add-image-link", "add-sub-condition",
   "add-cert-number"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  ["add-card-category", "add-foil-type", "add-language", "add-condition-type", "add-grading-company", "add-purchase-currency"]
    .forEach((id) => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  const receivedEl = document.getElementById("add-received-checkbox");
  if (receivedEl) receivedEl.checked = true;

  scrapeResults.toretoku = null;
  scrapeResults.yuyutei = null;
  scrapeResults.pricecharting = null;
  ["toretoku", "yuyutei", "pricecharting"].forEach((source) => {
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
  return `<div class="slot filled"${onClick} style="cursor:${opts.onFilledClick ? "pointer" : "default"};">
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

  let current = getPage();
  if (!pageNumbers.includes(current)) current = pageNumbers[0];
  setPage(current);

  const slots = pages[current] || Array(9).fill(null);
  gridEl.innerHTML = slots.map((rec, i) => {
    if (!rec) {
      return `<div class="slot empty" onclick="openSlotPicker('${binderKey}', ${current}, ${i})"><span class="slot-num">${i + 1}</span><span class="slot-icon">＋</span></div>`;
    }
    return slotHtml(i, rec, { onFilledClick: "openBinderCardDetail" });
  }).join("");

  const labelEl = document.getElementById(labelId);
  const subEl = document.getElementById(subId);
  if (labelEl) labelEl.textContent = "Page " + current;
  if (subEl) subEl.textContent = cardsForBinder(binderKey).length + " card(s) in this binder";

  const idx = pageNumbers.indexOf(current);
  const prevBtn = document.getElementById(prevBtnId);
  const nextBtn = document.getElementById(nextBtnId);
  if (prevBtn) {
    prevBtn.classList.toggle("disabled", idx <= 0);
    prevBtn.onclick = () => { if (idx > 0) { setPage(pageNumbers[idx - 1]); renderManualBinder(binderKey, gridId, labelId, subId, prevBtnId, nextBtnId, getPage, setPage); } };
  }
  if (nextBtn) {
    const atEnd = idx >= pageNumbers.length - 1;
    nextBtn.onclick = () => {
      const nextPage = atEnd ? pageNumbers[pageNumbers.length - 1] + 1 : pageNumbers[idx + 1];
      setPage(nextPage);
      renderManualBinder(binderKey, gridId, labelId, subId, prevBtnId, nextBtnId, getPage, setPage);
    };
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

  listEl.innerHTML = unplaced.map((r) => `
    <div class="row-card" style="cursor:pointer; margin:0 0 8px;" onclick="assignCardToSlot('${escapeAttr(r.id)}')">
      <div class="thumb"></div>
      <div>
        <div class="row-title">${escapeHtml(r.cardName)}</div>
        <div class="row-sub">${escapeHtml(r.cardNumber)} · ${escapeHtml(r.rarity || "")}</div>
      </div>
    </div>
  `).join("");
}

async function assignCardToSlot(recordId) {
  if (!pendingSlotAssignment) return;
  const { binderKey, page, slot } = pendingSlotAssignment;
  const record = inventoryRecords.find((r) => r.id === recordId);
  if (!record) return;

  try {
    const res = await fetch(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...record, binder: { key: binderKey, page, slot } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");
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

function rerenderBinderScreen() {
  renderMainBinder();
  renderAutoBinders();
  customBinders.forEach((b) => renderCustomBinder(b.key));
}

// ---- Binder: Pending Delivery / Wanted (auto, virtual) ---------------------

function renderAutoBinders() {
  renderAutoBinderGrid("pending", "Pending Delivery");
  renderAutoBinderGrid("wanted", "Wanted");
  renderAutoBinderList("pending");
  renderAutoBinderList("wanted");
}

function renderAutoBinderGrid(binderKey, status) {
  const gridEl = document.querySelector(`#binder-view-${binderKey} .binder-grid`);
  if (!gridEl) return;
  const records = statusFilteredRecords(status);
  const slots = Array(9).fill(null);
  records.slice(0, 9).forEach((r, i) => { slots[i] = r; });
  gridEl.innerHTML = slots.map((rec, i) => slotHtml(i, rec, { autoEmpty: true, onFilledClick: binderKey === "wanted" ? "openPurchaseModalFor" : "openBinderCardDetail" })).join("");
}

function renderAutoBinderList(binderKey) {
  const status = binderKey === "pending" ? "Pending Delivery" : "Wanted";
  const container = document.getElementById(`${binderKey}-list`);
  if (!container) return;
  const records = statusFilteredRecords(status);

  if (records.length === 0) {
    container.innerHTML = `<div class="inv-loading" style="margin:0 0 14px;">Nothing here right now.</div>`;
    return;
  }

  if (binderKey === "wanted") {
    container.innerHTML = records.map((r) => `
      <div class="row-card" onclick="openPurchaseModalFor('${escapeAttr(r.id)}')" style="cursor:pointer;">
        <div class="thumb"></div>
        <div>
          <div class="row-title">${escapeHtml(r.cardName)}</div>
          <div class="row-sub">${escapeHtml(r.cardNumber)} · ${escapeHtml(r.language || "")}</div>
        </div>
        <div class="row-value"><div class="amt">${formatMoney(computeMarketPrice(r).value)}</div></div>
      </div>
    `).join("");
  } else {
    container.innerHTML = records.map((r) => `
      <div class="selectable-row" data-id="${escapeAttr(r.id)}">
        <div class="select-check" onclick="toggleCardSelect(this)"></div>
        <div class="row-card" style="margin:0; flex:1;">
          <div class="thumb"></div>
          <div>
            <div class="row-title">${escapeHtml(r.cardName)}</div>
            <div class="row-sub">${escapeHtml(r.cardNumber)} · ${escapeHtml(r.language || "")}</div>
          </div>
          <div class="row-value"><div class="amt">${formatMoney(computeMarketPrice(r).value)}</div></div>
        </div>
      </div>
    `).join("");
  }
}

// ---- Pending Delivery: mass selection & bulk status update ----

let pendingSelectMode = false;

function toggleSelectMode(binderKey) {
  pendingSelectMode = !pendingSelectMode;
  const container = document.getElementById("binder-view-" + binderKey);
  container.classList.toggle("select-mode", pendingSelectMode);
  document.getElementById(binderKey + "-select-toggle").classList.toggle("active", pendingSelectMode);
  document.getElementById(binderKey + "-select-toggle").textContent = pendingSelectMode ? "Cancel" : "Select";
  if (!pendingSelectMode) {
    container.querySelectorAll(".select-check.checked").forEach((c) => c.classList.remove("checked"));
    updateBulkBar(binderKey);
  }
}

function toggleCardSelect(checkEl) {
  checkEl.classList.toggle("checked");
  updateBulkBar("pending");
}

function updateBulkBar(binderKey) {
  const container = document.getElementById("binder-view-" + binderKey);
  const selected = container.querySelectorAll(".select-check.checked").length;
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
  const container = document.getElementById("binder-view-" + binderKey);
  const selectedRows = container.querySelectorAll(".selectable-row .select-check.checked");
  const ids = Array.from(selectedRows).map((check) => check.closest(".selectable-row").dataset.id);
  if (ids.length === 0) return;

  const records = ids.map((id) => {
    const r = inventoryRecords.find((rec) => rec.id === id);
    if (action === "wanted") {
      return { ...r, purchasePrice: null, quantity: 0 };
    }
    return { ...r, quantity: 1 }; // delivered
  });

  try {
    const res = await fetch(`${API_BASE}/inventory-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");

    toggleSelectMode(binderKey);
    const verb = action === "delivered" ? "marked Delivered (now Purchased)" : "marked Wanted (purchase price cleared)";
    showToast(`${ids.length} card(s) ${verb}.`);
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
  document.getElementById("purchase-price-input").value = "";
  document.getElementById("purchase-currency-input").value = record.purchaseCurrency || "SGD";
  document.getElementById("purchase-modal").classList.add("open");
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
    const res = await fetch(`${API_BASE}/inventory-save`, {
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");

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
    const res = await fetch(`${API_BASE}/binders-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");

    customBinders = data.binders;
    renderCustomBinderSwitcher();
    closeNewBinderModal();

    const pill = document.querySelector(`.binder-pill[data-binder="${data.binder.key}"]`);
    switchBinder(data.binder.key, pill);
  } catch (err) {
    showToast("Couldn't create binder: " + err.message);
  }
}

// ---- Screen navigation -------------------------------------------------------

function showScreen(name, btn) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
  document.querySelectorAll(".ctrl-btn").forEach((b) => b.classList.remove("active"));
  if (btn) {
    btn.classList.add("active");
  } else {
    document.querySelectorAll(".ctrl-btn").forEach((b) => {
      if (b.textContent.toLowerCase().replace(" card", "") === name) b.classList.add("active");
    });
  }
}

// ---- tiny helpers ---------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
