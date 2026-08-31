# TangStash — Handover Document

**Purpose of this doc:** everything needed to take TangStash from its current
state to a fully functioning app. This supersedes the earlier SCOPE.md as the
authoritative reference — SCOPE.md described the mockup phase; this describes
what was actually built.

**Current build status:** fully wired to real data — Dashboard, Inventory,
Binder, and Add Card all read/write through the Netlify Functions below (no
screen still runs on hardcoded mock data). Built in a sandbox with **no
network access**, so nothing here has been run against a live Netlify deploy
or the real Toretoku/Yuyu-tei/PriceCharting markup yet — see §12 for exactly
what to verify first when you run this locally.

---

## 1. What TangStash Is

A personal, single-user web app for tracking a One Piece TCG collection —
mostly Japanese-language cards (~low thousands), with a smaller quantity in
English. Hosted privately on GitHub + Netlify, gated behind a single shared
site-wide password (not per-user auth).

---

## 2. Tech Stack (decided)

- **Frontend:** plain HTML/CSS/JS, no framework. `public/index.html` +
  `public/app.js`.
- **Backend:** Netlify Functions (serverless, Node.js).
- **Data storage:** Netlify Blobs — NOT a database. Card records live as
  **one JSON array in a single blob** (`inventory-index` key, in the
  `tangstash-data` store). No per-record blobs, no query engine — the app
  fetches the whole array and filters/sorts client-side. This is
  deliberate and considered fine at ~2,000 records; revisit only if the
  collection grows much larger.
- **Image storage:** also Netlify Blobs, separate store (`card-images`),
  one blob per card image, keyed by a card ID.
- **Auth:** a Netlify Edge Function (`password-gate.js`) checking a cookie
  against a `SITE_PASSWORD` env var. Not per-user login — a shared
  password gate. Chosen because Netlify's built-in password protection is
  Pro-plan only.
- **No paid subscriptions anywhere in the stack.** All pricing/image data
  comes from scraping public pages server-side, not from paid APIs
  (PriceCharting's own API and Parse.bot's SNKRDUNK/Yuyu-tei APIs were
  both evaluated and rejected in favor of scraping — see §5).

---

## 3. Data Model

### 3.1 The inventory record shape

```json
{
  "id": "TS-00184",
  "cardName": "Roronoa Zoro (Parallel)",
  "cardNumber": "OP01-025",
  "category": "Character",
  "printSource": "OP01",
  "rarity": "SR",
  "foilType": "Foil",
  "language": "Japanese",
  "quantity": 1,
  "purchasePrice": 7980,
  "purchaseCurrency": "JPY",
  "purchaseDate": "2026-08-24",
  "toretokuUrl": "https://www.toretoku.jp/item/details/158238",
  "yuyuteiUrl": "https://yuyu-tei.jp/sell/opc/card/op01/10033",
  "pricechartingUrl": "",
  "imageLink": "",
  "imageBlobKey": "op01-025-parallel-sr.jpg",
  "conditionType": "Singles",
  "subCondition": "",
  "gradingCompany": "",
  "certNumber": "",
  "rawSources": {
    "toretoku": { "price": 203, "grade": "A", "note": "¥22,100", "inStock": false },
    "yuyutei": { "price": 198, "note": "¥21,600", "inStock": true },
    "pricecharting": { "ungraded": 210, "psa10": null }
  },
  "binder": { "key": "main", "page": 4, "slot": 1 },
  "status": "Purchased",
  "createdAt": "2026-08-24T09:00:00.000Z",
  "updatedAt": "2026-08-24T09:00:00.000Z"
}
```

Key points:
- **`status` is computed, never set directly** — see §4.
- **`rawSources` holds each source's raw scraped values.** The displayed
  market price and the "?" breakdown are both derived from this at read
  time (see §5.3) — nothing pre-computes and stores a final "market
  price" field, so the formula can change later without a data migration.
- **`binder`** only applies to manually-arranged binders (`main` or a
  custom one). Pending Delivery/Wanted binders are virtual — computed by
  filtering on `status`, never stored as a binder assignment.
- **One row = one physical card.** `quantity` is a 0/1 "received" flag per
  row, not a multi-copy counter (this reintroduces a `quantity` field
  that an earlier design pass had dropped — reconciled this way
  deliberately, see §4).

### 3.2 Rarity/category/etc. option lists

Centralized in `config/card-options.json` — this is the single source of
truth for dropdown values (rarities, categories, foil types, languages,
purchase currencies, condition types, grading companies). Both the
frontend and any import/validation logic should read from this file
rather than hardcoding the lists twice.

### 3.3 Import template → data model mapping

The xlsx import template's columns map directly to the record shape
above. Column-to-field mapping:

| Template column | Record field |
|---|---|
| Listing UID | `id` |
| Card Name | `cardName` |
| Card Number | `cardNumber` |
| Category | `category` |
| Print Source | `printSource` |
| Rarity | `rarity` |
| Foil Type | `foilType` |
| Language | `language` |
| Quantity | `quantity` |
| Purchase Price | `purchasePrice` |
| Purchase Currency | `purchaseCurrency` |
| Purchase Date | `purchaseDate` |
| Toretoku URL | `toretokuUrl` |
| Yuyu-tei URL | `yuyuteiUrl` |
| PriceCharting URL | `pricechartingUrl` |
| Image Link | `imageLink` (fallback only) |
| Condition Type | `conditionType` |
| Sub-Condition | `subCondition` |
| Grading Company | `gradingCompany` |
| Cert Number | `certNumber` |

**Mass-update behavior:** if a row's Listing UID matches an existing
record's `id`, `inventory-save.js` replaces that record in place rather
than creating a duplicate. Blank Listing UID = new card, gets a
freshly-generated ID (format: `TS-` + 5 random alphanumeric characters,
see `lib/inventory-helpers.js`).

**Built:** `public/tangstash-import-template.xlsx` (generated by
`build_scripts/make_template.py` — re-run that script if the column list
ever changes, rather than hand-editing the xlsx) and the client-side
import handler in `app.js` (`handleImportFile`, via SheetJS loaded from
a CDN `<script>` tag in `index.html`) that reads the uploaded file, maps
rows to this record shape per the table above, and POSTs them as a
`{ records: [...] }` bulk upsert. Reachable from the Inventory screen's
⇅ header icon; the template is linked for download right below the
search bar. Note this only *imports metadata* — it does not scrape
prices for the URLs it stores. Use the "↻ Refresh price from saved URLs"
button in a card's price breakdown sheet (or re-run Add Card) to pull
live pricing for an imported card.

---

## 4. Listing Status Rule

Status is **derived**, never stored as its own editable field:

| Quantity | Purchase Price | → Status |
|---|---|---|
| > 0 | set | **Purchased** |
| 0 | set | **Pending Delivery** |
| 0 | not set | **Wanted** |

Implemented in `lib/inventory-helpers.js::computeListingStatus()`, called
by `inventory-save.js` on every write so `status` is always fresh.

**Status-change workflows:**
- **Pending Delivery → mass update.** The Pending Delivery binder supports
  multi-select (checkbox mode via a "Select" toggle) with a bulk action
  bar offering:
  - **Mark as Wanted** → clears `purchasePrice`, `quantity` stays 0
  - **Mark Delivered** → `quantity` → 1, `purchasePrice` unchanged
- **Wanted → single update.** Tapping an individual Wanted card opens a
  purchase-entry sheet: enter a Purchase Price, then choose:
  - **Save as Pending Delivery** → `quantity` stays 0
  - **Save as Purchased** → `quantity` → 1
  - A price is required before either save proceeds.

Both are wired to real `inventory-save.js` POSTs in `app.js`
(`bulkUpdate()` and `resolvePurchase()`).

---

## 5. Pricing & Image Scraping

### 5.1 Sources and their roles

| Source | Role | Currency | Notes |
|---|---|---|---|
| **Toretoku** | Primary (Singles) | JPY | Multiple condition ranks per listing |
| **Yuyu-tei** | Primary (Singles) | JPY | Single price per listing |
| **PriceCharting** | Last resort (Singles) / Sole reference (Slabs) | USD | eBay US sold-listing data, NOT Japan domestic market |

Both official-API and unofficial-API routes were evaluated and rejected:
- **TCGPlayer's official API** is closed to new developer applicants.
- **PriceCharting's own API** requires a paid subscription.
- **Free third-party pricing APIs** (JustTCG, TCG Price Lookup, tcgfast,
  tcgapi.dev, tcggo, OPTCG API, APITCG) were all checked — none confirmed
  genuine Japanese-market pricing; most are English/TCGPlayer-sourced.
- **Parse.bot's SNKRDUNK/Yuyu-tei wrapper APIs** were evaluated — SNKRDUNK's
  API genuinely offers real JPY pricing including graded-slab tiers, but
  at ~2,000 listings the free tier (200 credits/month, shared across all
  Parse APIs) would need ~4,000 credits for one full refresh pass across
  both APIs — roughly 20x over the free allowance. Would require their
  $100/mo Developer tier. Rejected in favor of direct scraping (free).
- **SNKRDUNK direct scraping** was attempted and **blocked by bot
  detection** on two separate fetch attempts. Not currently in the
  scraper. If revisited, test from an actual deployed Netlify Function
  first (serverless IPs sometimes fare differently than ad hoc fetches) —
  don't assume it'll work without re-testing live.
- **Limitless TCG** (onepiece.limitlesstcg.com) was evaluated as a
  possible 4th source — good card metadata, but same USD/EUR-not-JPY
  caveat as PriceCharting, PLUS a real matching risk: **the same card
  number can have several differently-priced prints/variants on one page**
  (confirmed via live testing — e.g. OP13-037 had 3 different prints
  sharing that number, prices ranging $0.34–$227.07). Matching would
  require pinning the exact `?v=N` variant per listing URL, same
  discipline as the other sources, plus verifying language-path (`/en/`
  vs `/jp/`) doesn't silently point to a different priced product (spot
  checks were inconsistent — see conversation history for the raw
  findings). **Held off for v1.**

### 5.2 The pricing formula

- **Singles:** market price = **average of Toretoku + Yuyu-tei**. If only
  one has data, use that one alone. If neither has data, fall back to
  **PriceCharting's Ungraded price** (last resort).
- **Slabs:** market price = **PriceCharting's PSA10 price**, used as the
  sole reference regardless of Toretoku/Yuyu-tei availability (those two
  sites rarely carry graded slabs).
- **Toretoku grade priority:** when a listing has multiple condition-rank
  rows, use the best available in order **S > A > B > C > D**. Show which
  grade was used in the UI, e.g. "Toretoku (Grade A)".
- **Image scrape priority:** try **Toretoku → Yuyu-tei → PriceCharting**
  in that order; store whichever image is found first.

This logic is implemented twice right now and **must be kept in sync**:
once in `netlify/functions/scrape-card.js` (documented in comments) and
once in `public/app.js::computeMarketPrice()` (client-side, operates on
already-saved `rawSources`). If the formula changes, both need updating.

### 5.3 Variant-matching risk (important, cross-source)

**Card number alone is not a safe match key.** Confirmed via live testing
across Toretoku/Yuyu-tei/PriceCharting with 6 real examples — in some
cases all 3 sources' URLs pointed to the same physical card despite very
different naming (e.g. a PRB02 DON!! card called "パラレル(スーパーパラレル)"
on Yuyu-tei, "金枠/影絵" on Toretoku, "Gold Frame" on PriceCharting — all
the same card). In other cases, **the same card number pointed to
genuinely different prints** — e.g. PriceCharting's OP02-034 page was
explicitly the Promotion Pack reprint, while Yuyu-tei/Toretoku's OP02-034
was the original booster pack UC — an ~8x price difference between two
"same card number" listings.

**Mitigation already in place:** the app never searches a catalog by card
number — every scrape targets the **exact listing URL the user supplies
per physical card** (per Toretoku URL / Yuyu-tei URL / PriceCharting URL
fields on each record). This sidesteps the matching problem entirely, but
puts the burden on the user to grab the *correct* URL per variant when
adding a card. Worth a UI affordance later (not yet designed) to help
users double-check they've got matching variants across their 2–3 scrape
URLs for a given card, since nothing currently catches a mismatch.

### 5.4 Known scraper risks

- **PriceCharting's parser is unconfirmed against real page markup.** It
  was built from a markdown-converted fetch, not inspected raw HTML —
  treat its selectors as higher-risk than Toretoku/Yuyu-tei's until
  spot-checked against a live deploy.
- **Toretoku/Yuyu-tei pages are heavy** with site-wide category-menu
  content unrelated to the actual listing — not a functional problem, but
  worth knowing if scrape responses seem bloated.
- None of the three scrapers have been tested against a live Netlify
  environment yet — only against ad hoc fetches during design.

---

## 6. Image Storage

- `scrape-card.js` returns an `imageUrl` per source it successfully
  parses.
- `store-card-image.js` takes one `imageUrl` + a `cardId`, downloads the
  bytes, and stores them in the `card-images` Blobs store under a key
  derived from the card ID.
- **Caller is responsible for priority order** (Toretoku → Yuyu-tei →
  PriceCharting) — try each URL in turn, call `store-card-image.js` once
  with the first one that succeeds. Built in `app.js`: `pickBestImageUrl()`
  (Add Card flow) and the equivalent inline logic in `refreshPriceFor()`.
- **Host allow-listing:** `store-card-image.js` only accepts image URLs
  from known hosts, to prevent the endpoint being used as an open image
  proxy. PriceCharting's images are served from a shared Google Cloud
  Storage bucket (`storage.googleapis.com`), so that host is allow-listed
  with a **required path prefix** (`/images.pricecharting.com/`), not just
  the bare hostname — the bare hostname is shared by unrelated buckets.
- **Image-serving route: built as a proxy function**
  (`serve-card-image.js`), not a direct Blob URL — Netlify Blobs doesn't
  expose a stable public URL without extra config, and a proxy behaves
  identically in `netlify dev` and production. `GET
  /.netlify/functions/serve-card-image?key=<blobKey>` streams the bytes
  back with a long `Cache-Control` (a given blobKey's bytes never change —
  a re-scrape writes a new key). `app.js::imageUrlFor()` builds this URL
  from a record's `imageBlobKey` for Inventory thumbnails and Dashboard
  rows.

---

## 7. Binder Rules

- **Multiple binders supported.** A pill-based switcher at the top of the
  Binder screen.
- **Two default binders, auto-created, cannot be deleted:**
  - **Pending Delivery** — auto-populated from records where
    `status === "Pending Delivery"`. Cannot be manually rearranged. Supports
    mass-select + bulk status update (see §4).
  - **Wanted** — auto-populated from records where `status === "Wanted"`.
    Cannot be manually rearranged. Supports single-card purchase-entry
    (see §4).
- **Main Collection + any user-created binders** are manually arranged:
  page number + 3×3 slot grid (slots 1–9), matching physical binder
  placement. Empty slots render blank and are tappable to open a search
  picker (`openSlotPicker()`) that assigns an unplaced card to that exact
  page/slot. If a page's card order isn't explicitly set, fall back to
  sorting by card number.
- **Page navigation:** swipe left/right on the binder page (pointer
  events, works for touch and mouse — `setupBinderSwipe()` in `app.js`,
  works generically for whichever binder-view is active), plus ‹ ›
  buttons for non-touch use. Next always allows paging past the last
  populated page, to start filling a new one. **No "jump to page"
  strip** — this was explicitly removed.
- **Slot display:** rarity tag bottom-left; pricing bottom-right in two
  stacked rows — **Purchase Price above, Market Price below**. A Wanted
  card's slot shows "—" for purchase price (not bought yet) but still
  shows market price.
- **Creating a custom binder:** a "+ New Binder" pill opens a small modal
  to name it, then adds it to the switcher with a fresh, empty,
  manually-arrangeable page. Persisted via `binders-list.js` /
  `binders-save.js` (a small metadata array blob — see below), so it
  survives reloads, unlike the earlier mockup's browser-session-only
  version.

**Custom binder persistence (data model):** a single JSON array blob
(`binders-index` key, `tangstash-data` store) holding `{ key, name,
createdAt }` per custom binder — same "one blob, no query engine"
pattern as the inventory index. Main Collection always exists implicitly
(`key: "main"`, never stored in this list); Pending Delivery/Wanted are
virtual and also never stored here. A card's placement in ANY manually
arranged binder (main or custom) lives on the card record itself, as
`binder: { key, page, slot }` — so `binders-index` only ever holds
*names*, never card placement.

---

## 8. Inventory Rules

- **Default sort:** Card Number (ascending), then Price (low → high) as
  tie-break. No user-facing sort selector — this is fixed.
- **Filters** (dropdown pills below the search bar, combine as AND):
  - **Listing** — All / Purchased / Pending Delivery / Wanted (matches
    computed `status`)
  - **Language** — All / English / Japanese / Chinese
  - **Set** — All / OP / ST / EB / Others (parsed from `cardNumber` prefix
    via regex in `app.js::parseCardNumber()`)
  - **Sub-Set** — All / 01 / 02 / 03 / etc. (parsed the same way)
  - **Rarity** — All / C / UC / R / SR / SEC / L / etc.
- **"?" price breakdown**: tapping it opens a bottom sheet showing the
  computed market price (with which formula produced it) plus each raw
  source's price, muted (dimmed) when that source's listing is out of
  stock or wasn't the one used in the calculation.

This is the pattern every other screen now follows too (`public/app.js`):
fetch from the relevant list function, derive everything client-side, no
server-side filtering.

---

## 9. Buttons/Actions Inventory (now wired to real data)

| Action | Wiring |
|---|---|
| Fetch price/image from Toretoku/Yuyu-tei/PriceCharting (Add Card screen) | `app.js::fetchSource()` calls `scrape-card.js` for real and populates the result cards from the actual response, converted to SGD for display |
| Save to inventory (Add Card screen) | `app.js::saveCard()` assembles a record from the form + scrape results, calls `store-card-image.js` for the priority-order image, then POSTs to `inventory-save.js` |
| Mark Delivered / Mark as Wanted (Pending Delivery binder, mass action) | `app.js::bulkUpdate()` POSTs updated `quantity`/`purchasePrice` for each selected record to `inventory-save.js` |
| Save as Pending Delivery / Save as Purchased (Wanted binder, single card) | `app.js::resolvePurchase()` POSTs the entered price + new `quantity` to `inventory-save.js` |
| Create new binder | `app.js::createBinder()` POSTs to `binders-save.js`, persisted (see §7) |
| Dashboard "Top by value" / "Recently added" | Real records, computed client-side in `renderDashboard()`. "Biggest movers" was dropped for v1 (explicit decision — no price-over-time history is tracked) and replaced with "Top by value": the 5 highest-market-value Purchased cards, which needs no history to compute |
| xlsx import (Inventory screen) | `app.js::handleImportFile()` reads the uploaded file via SheetJS, maps rows per §3.3, POSTs as a bulk upsert |
| Refresh price for an existing card | New, beyond the original scope list: `app.js::refreshPriceFor()`, reachable from the "?" price breakdown sheet whenever a record has a saved Toretoku/Yuyu-tei/PriceCharting URL (e.g. after an xlsx import, which stores URLs but doesn't auto-scrape). Re-scrapes and updates `rawSources` + image in place |

---

## 10. Local Development Setup

### Prerequisites
- Node.js v18+
- A GitHub account with the repo cloned locally (see the GitHub setup
  walkthrough already covered separately if needed — summary: `git clone`
  your repo, don't hand-upload files through the GitHub web UI, since that
  disconnects your local folder from git tracking)
- A free Netlify account
- Netlify CLI installed globally: `npm install -g netlify-cli`

### One-time setup
```
cd tangstash-app
npm install                # installs @netlify/blobs and cheerio
netlify link                # connects this folder to your Netlify site
                             # (choose "Create & configure a new site" if
                             # you haven't created one on Netlify yet, or
                             # select your existing one)
```

### Environment variables
- **`SITE_PASSWORD`** — required. The password-gate edge function fails
  closed (blocks everything, including local dev) if this isn't set.
  - For local dev: create a `.env` file in the project root (already
    gitignored — never commit this) containing:
    ```
    SITE_PASSWORD=your-chosen-password
    ```
    `netlify dev` reads `.env` automatically.
  - For production: set the same variable in the Netlify dashboard under
    Site configuration → Environment variables, or via
    `netlify env:set SITE_PASSWORD your-chosen-password`.

### Netlify Blobs — no setup required
Zero-config. `@netlify/blobs`'s `getStore()` works automatically both in
`netlify dev` and in production, with no dashboard toggle or credentials
needed. If a function errors trying to read/write a blob, the cause is
something else (check function logs).

### Running locally
```
netlify dev
```
Serves the app at `http://localhost:8888`, running all functions and
Blobs locally.

### Seeding test data
The Blobs store starts empty. With `netlify dev` running in one terminal:
```
node scripts/seed-sample-data.js
```
Posts 4 sample cards (one of each status) so Inventory has something real
to filter/sort/inspect. Point it at a deployed site instead of local via:
```
SEED_TARGET=https://your-site.netlify.app node scripts/seed-sample-data.js
```

### Deploying
Push to `main` on GitHub — Netlify auto-deploys on every push, once the
site is connected (via `netlify link` or the dashboard's "Import an
existing project" flow). No build command needed (`public` is the publish
directory, set in `netlify.toml`).

---

## 11. What's Built (as of this handover)

**Everything is wired to real data — no screen runs on mock/hardcoded
data.**

- Dashboard — real totals, profit/loss, Top by value, Recently added
- Inventory — list, filters, default sort, "?" price breakdown, xlsx
  import, card thumbnails
- Binder — Main Collection + custom binders (manual placement via a
  slot-tap picker, persisted), Pending Delivery + Wanted (virtual,
  computed from `status`), mass-update and single-update purchase flows
- Add Card — real scrape calls, SGD conversion, image storage, save
- `inventory-list.js`, `inventory-save.js` (data layer)
- `scrape-card.js` (Toretoku/Yuyu-tei/PriceCharting scraping)
- `store-card-image.js` + `serve-card-image.js` (image download → Blobs
  → served back via a proxy function)
- `binders-list.js` + `binders-save.js` (custom binder metadata,
  persisted)
- `fx-rate.js` (cached daily FX rates, SGD base, via Frankfurter — free,
  no key)
- `password-gate.js` (site-wide password edge function)
- `public/tangstash-import-template.xlsx` (generated by
  `build_scripts/make_template.py`) + the client-side import handler
- `config/card-options.json` (shared dropdown values)

**Explicitly out of scope for v1** (revisit later if wanted):
- SNKRDUNK (blocked by bot detection)
- Limitless TCG (variant-matching risk, USD/EUR not JPY)
- Rarity auto-detection from card image
- Price-over-time history (and therefore "biggest movers" — dropped,
  see §9)
- Any paid API/subscription in the pricing pipeline
- Deleting a custom binder from the UI (the backend endpoint supports it
  — `binders-save.js` with `{ delete: true }` — but no button calls it
  yet)
- Reordering/removing a card already placed in a manual binder slot (you
  can place a card into an empty slot, but there's no "remove from
  binder" action yet — workaround: edit the record's `binder` field
  directly, or re-import it via xlsx with a blank placement)

---

## 12. What to Verify First (built with no network access)

This was built and syntax-checked in a sandbox with **no network
access** — no `npm install`, no `netlify dev`, no live requests to
Toretoku/Yuyu-tei/PriceCharting. Everything is wired end-to-end and
internally consistent (every `onclick`/`getElementById` reference was
cross-checked against what actually exists, every backend response
shape was checked against what the frontend reads), but none of it has
actually run. In rough order of what to check first:

1. **`npm install && netlify dev`, then `node scripts/seed-sample-data.js`**
   — confirms Dashboard/Inventory/Binder render correctly against real
   (seeded) data before touching any live scraping.
2. **Add Card against one real Toretoku URL, then one Yuyu-tei URL.**
   The parsers' CSS selectors (`.price, [class*='Price']` etc.) were
   written from general knowledge of these sites' markup, not verified
   against a live fetch — see the "Selectors are unconfirmed" note
   already in `scrape-card.js` for PriceCharting specifically, but treat
   Toretoku/Yuyu-tei as needing the same check. If a selector has
   drifted, the price should come back `null` and `scrape-card.js`
   returns a 422 rather than a wrong number — but confirm that's really
   what happens.
3. **`store-card-image.js`'s host allow-list** — confirm the actual image
   URLs these sites return still match `card.yuyu-tei.jp` /
   `www.toretoku.jp` / `storage.googleapis.com/images.pricecharting.com/`.
4. **The xlsx import**, using the generated template — fill in 2-3 real
   rows, import, confirm they land correctly in Inventory before relying
   on it for a bulk migration.
5. **FX rates** — confirm `fx-rate.js` actually returns `CNY`/`JPY`/etc.
   from Frankfurter as expected; RMB is normalized to CNY client-side
   (see `app.js::fxCode()`) since the app's currency picker and the FX
   provider use different codes for the same currency.
