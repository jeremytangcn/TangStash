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

> **⚠️ Superseded by §19: PriceCharting was removed entirely.** Everything
> below describing PriceCharting as a source is the ORIGINAL design
> rationale, kept as historical record — the Toretoku/Yuyu-tei content is
> still accurate. See §19 for what actually shipped and why.

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

> **⚠️ Partly superseded — see §17, §18, §19, §21.** The host allow-list
> described below moved into a shared `lib/image-sources.js` (and lost
> its PriceCharting entry), a new `preview-image-proxy.js` and
> `store-external-image.js` were added, and blob keys are no longer
> deterministic (§18 — they must be unique per store call). The core
> "download server-side into Blobs, serve back via a proxy function"
> shape below is still accurate.

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
  page/slot. Tapping a filled slot opens the price breakdown sheet with
  an added **"Remove from this binder"** action (`removeCardFromBinder()`
  — clears `binder` back to `null`, doesn't touch the card itself). If a
  page's card order isn't explicitly set, fall back to sorting by card
  number.
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
- **Deleting a custom binder:** a "🗑 Delete this binder" link under each
  custom binder's header (`confirmDeleteBinder()` → `deleteBinder()`,
  POSTs `{ key, delete: true }` to `binders-save.js`). Confirms first.
  Only removes the binder's *name* from the switcher — cards that had
  `binder.key` set to it are left as-is (not deleted, not
  auto-unassigned) and won't show up in the slot-picker's "unplaced
  cards" list until manually cleared. Documented trade-off in
  `binders-save.js`'s own comment — fine for a single-user app, worth
  revisiting only if it gets confusing in practice.

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
- Dragging a card BETWEEN pages of the same binder (same-page
  drag-to-reposition is supported — see §7 — but the drag gesture is
  scoped to the visible page grid, since cross-page drag would fight
  with the page-swipe gesture on the same surface)

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

---

## 13. Second-Pass Fixes (bug reports from a real deploy)

The first handover was built with zero network access, so it hadn't run
anywhere. This round came from actual bug reports against a live
deploy (`tangstash.netlify.app`) and fixed several real issues:

- **Root cause of "The string did not match the expected pattern"
  errors** on both Add Card scraping AND xlsx import (two unrelated code
  paths throwing the identical error was the tell): `fetch()` calls were
  built from a relative path (`API_BASE = "/.netlify/functions"`), which
  the reporting environment's webview apparently couldn't resolve.
  Fixed by building `API_BASE` from `window.location.origin` instead.
  Every fetch call in `app.js` now also goes through a shared
  `apiJson()` helper for consistent, specific error messages — if this
  wasn't the *entire* root cause, whatever's left should now surface a
  clear message instead of a generic browser string. **Worth
  double-checking against the live deploy that scraping and import both
  actually work now.**
- **xlsx template bug**: the generated template had a real-looking
  example row baked into the actual "Cards" sheet (row 2), which would
  silently import as a duplicate card. Fixed — the example now lives
  only in the Legend tab as reference text. If you already have a copy
  of the old template downloaded, re-download it from the Inventory
  screen to get the fixed version.
- **Removed the phone-mockup chrome** (fake bezel, fake statusbar,
  fixed-height inner-scrolling `.screen`) in favor of a normal responsive
  page: `.app-shell` (max-width, centered, natural document scroll) plus
  a real `position:fixed` bottom nav/modals/toast. `showScreen()` no
  longer takes a `btn` param — nav-item active state is driven by
  `data-screen` attributes instead of button text-matching.
- **Multiple images per card** (`imageBlobKeys` array, `imageBlobKey`
  kept as `imageBlobKeys[0]` for back-compat) — a new
  `upload-card-image.js` function accepts a base64-encoded photo
  directly from the device (Add Card screen, "Additional photos"), since
  a Slab's back photo is typically the user's own phone photo, not
  something scrapeable, and `store-card-image.js`'s host allow-list
  deliberately won't fetch arbitrary URLs.
- **Purchase currency is now a `<select>`** (Add Card + the Wanted→
  Purchased purchase modal), not free text — options match
  `card-options.json`'s `purchaseCurrencies` list.
- **Bottom nav "Search" renamed to "Inventory"**.
- **Settings sheet** (Dashboard gear icon): dark/light theme toggle
  (`data-theme="light"` on `<html>`, CSS variable overrides, applied
  pre-paint via an inline `<head>` script to avoid a flash) and a
  display-currency picker. Both persist via `localStorage` — legitimate
  here since this is a real deployed site, not a sandboxed artifact
  preview. Everything is still computed/stored in SGD internally
  (`convertFromSGD()` is purely a display-time conversion inside
  `formatMoney()`).
- **Drag-to-reposition within a binder page** — pointer events (not
  native HTML5 drag-and-drop, which doesn't fire reliably for touch on
  mobile Safari) on `.slot.filled` elements, in `attachSlotDragHandlers()`.
  A short tap still opens the price breakdown (moved out of a plain
  `onclick` so it can be told apart from a drag by movement distance).
  Dropping on another filled slot swaps the two cards; dropping on an
  empty slot moves it; either action also "commits" every other card on
  that page to an explicit `binder.page`/`binder.slot` if it was still
  in the computed-fallback-sort state (see `pagesForBinder()`), so an
  untouched card can't appear to jump position on the next render.
  Same-page only — cross-page drag would conflict with the page-swipe
  gesture on the same surface.

---

## 14. Third-Pass Fixes (more bug reports from the live deploy)

- **PriceCharting 403s**: the old User-Agent literally self-identified as
  a bot (`"compatible; TangStash/1.0..."`), which some basic bot-filters
  block outright. Switched to a realistic Chrome UA + a fuller header set
  (`buildHeaders()` in `scrape-card.js`) for all 3 scrapers. This won't
  help against anything backed by a real challenge service (e.g.
  Cloudflare's managed challenge) — there's no fix for that short of a
  headless browser — but it's the right first fix and may well be enough.
- **Toretoku "could not parse a price"** on listings that don't use the
  ranked S/A/B/C/D table (single-print promos, mainly) — the parser only
  ever looked for table rows. Added a fallback chain (price-labeled
  element → bare "X,XXX円" text-scan) matching what `parseYuyuTei()`
  already had, so a flat-price listing with no rank table now parses.
- **New**: Card Details now has a separate "Name" (English) and
  "Original Name" (native language) field, plus a manual-only "Artist"
  field. `translate-text.js` auto-translates the scraped native-language
  name into English via Google Translate's unofficial `translate_a/single`
  endpoint (no API key, but NOT an official/stable API — see the caveat
  comment at the top of that file; the fix if it ever breaks outright is
  swapping in an official paid translation API, nothing else changes).
  Translation only fires if the Name field is still empty when a scrape
  completes, so it never overwrites something the user typed. Both new
  fields (`cardNameOriginal`, `artist`) flow through to xlsx import/export
  and the price breakdown sheet's subtitle line.

---

## 15. CRITICAL FIX — `MissingBlobsEnvironmentError` on every Blobs call

**This was the actual root cause of xlsx import, inventory list/save, and
image storage all failing** (`"MissingBlobsEnvironmentError: The
environment has not been configured to use Netlify Blobs..."`), and it
was a real code bug, not a deploy/account configuration issue.

**Root cause:** every function here uses the classic
`exports.handler = async (event) => {...}` signature — what Netlify's
own docs call **"Lambda compatibility mode"**. Per `@netlify/blobs`'s own
documentation: *"The environment is not configured automatically when
running functions in the Lambda compatibility mode. To use Netlify
Blobs, you must initialize the environment manually by calling the
`connectLambda` method with the Lambda event as a parameter... immediately
before calling `getStore`."* None of the 8 functions that call
`getStore()` were doing this.

**Fix:** every one of them now imports `connectLambda` alongside
`getStore` and calls `connectLambda(event)` as the very first line
inside the handler, before anything else:
`binders-list.js`, `binders-save.js`, `fx-rate.js`, `inventory-list.js`,
`inventory-save.js`, `serve-card-image.js`, `store-card-image.js`,
`upload-card-image.js`. (`fx-rate.js` previously took no `event`
parameter at all — one was added purely to have something to pass in.)
`scrape-card.js` and `translate-text.js` don't touch Blobs, so they
didn't need this.

**If this pattern ever needs to be applied to a new function**: add
`getStore` to any handler and forget `connectLambda(event)` first, and
it will silently work in `netlify dev` (which doesn't need it — see the
GitHub issue below) but throw this exact error in production. That gap
between working locally and failing in prod is *why* this shipped
broken in the first place, and it's the thing to double check every
time a new Blobs-using function gets added:
https://github.com/netlify/blobs/issues/175

**This should be verified against the live deploy first**, before
spending more time on the scraper issues (§13/§14) — with Blobs
non-functional, cards can't be saved at all, so nothing past "fetch a
price" was actually testable until this fix.

---

## 16. Scraper fixes verified against real page content

Unlike every earlier round, these two fixes were made by actually
fetching the real, live listing pages (via a web-fetch tool available in
chat, separate from this sandbox's own no-network-access bash
environment) rather than guessing at markup blind. Both confirmed real
bugs, not flukes of one listing:

- **Toretoku**: the real price table (verified on
  `toretoku.jp/item/details/171978`, e.g. "A 4,280円" / "B 1,880円") is
  NOT necessarily inside a `<table><tr>` or `.price-row`-classed element
  — the old parser assumed one of those and found nothing on listings
  that use a div/grid layout instead. It also had a `\b` word-boundary
  regex bug that would silently fail to pair a rank letter with its
  price if the cell text had no gap between them. `parseToretoku()` now
  scans the page's full visible text directly for the
  `<rank letter> <price>円` pattern, which works regardless of the
  underlying markup. Verified against both a "tight spacing" and a
  "newline-separated" reconstruction of the real text — see the inline
  regex test in the fix's commit if this ever needs re-verifying.
- **PriceCharting parsing** (separate from the 403 below): the real
  price table has condition labels (Ungraded / Grade 7 / .../ PSA 10) in
  one row and their $ values in the row directly below, aligned by
  column position — NOT "label near its price" in raw text order, which
  is what the old regex assumed (and would've been hundreds of
  characters off on the real page). `parsePriceCharting()` now parses
  the actual `<table>` structure: match a header cell's text to find its
  column index, then read that same column index from the values row.
  Also fixed a related latent bug this surfaced: a second, smaller
  "estimate" table further down the same page reuses the same column
  headers but shows `$0.00` placeholders for grades with no real data —
  a naive scan could have grabbed that table's `$0.00` and reported it
  as a real PSA 10 price. Zero-value matches are now treated as "no
  data" and skipped.
- **PriceCharting 403 — NOT fixed, and likely can't be from here.**
  Fetching the exact same URL via the web-fetch tool (different network
  origin than Netlify's Functions runtime) worked fine and returned the
  real page — so the previous header fix's failure to resolve the 403 in
  production isn't a markup/parsing problem, it's PriceCharting blocking
  requests at the network level, almost certainly by IP range (a common
  defense against traffic from cloud/datacenter IPs, which is exactly
  what Netlify Functions' outbound requests come from). No amount of
  header tweaking fixes an IP-range block. The realistic options if this
  needs to actually work:
  - Accept it as best-effort/unavailable, same as it's already treated
    as a "last resort" pricing source (see §5) — Singles pricing already
    doesn't depend on it when Toretoku/Yuyu-tei have data, and every
    field in Add Card is manually editable regardless of scrape success.
  - Route PriceCharting requests through a third-party scraping proxy
    (e.g. ScraperAPI, ScrapingBee, Bright Data) that provides
    residential/rotating IPs — requires a paid API key and account setup
    that's a decision for whoever's running this, not something to wire
    in silently.

---

## 17. More fixes: image hotlinking, and a bulk "refresh all" action

- **Toretoku preview thumbnail was blank in Add Card** (even though
  price fetched fine, and the image DOES save correctly once a card is
  saved). Root cause: the preview thumbnail set its CSS
  `background: url(...)` directly to the scraped `imageUrl`
  (`toretoku.jp/img/itemMini/...`) — i.e. the **browser** fetched it
  directly from Toretoku's own server, with the app's domain as
  referrer. Toretoku's image server appears to reject that (common
  anti-hotlinking measure). The actual saved copy was never affected,
  since `store-card-image.js` fetches server-side with no referrer to
  check against — this was purely a preview-thumbnail bug.
  **Fixed** with a new `preview-image-proxy.js` function: the Add Card
  preview now routes through our own domain instead of hotlinking the
  source site directly. Not persisted to Blobs (short cache only) —
  that still only happens on actual save, via `store-card-image.js`.
- **Found a related latent bug while building that fix**:
  `store-card-image.js` (the PERMANENT image-storage path, used on
  every actual save) was still using the same self-identifying bot
  User-Agent that had already been fixed in `scrape-card.js` — the two
  had drifted out of sync. If any image source ever starts blocking
  that UA the way PriceCharting blocks it on the price-fetch side, this
  would have silently broken every future image save. Fixed by
  extracting the allow-list AND the request headers into a shared
  `lib/image-sources.js`, used by both `store-card-image.js` and the
  new `preview-image-proxy.js`, so they can't drift apart again.
- **xlsx import doesn't fetch images** (or prices) — this was already
  documented as a known limitation (§3.3, §16.15), not a bug: import
  only stores metadata (including the 3 source URLs), and getting a
  price/image for each row means a live scrape per card, which isn't
  something a bulk import should do inline. The fix is the new bulk
  action below, which is exactly what closes that gap in one action
  after an import.
- **New: bulk "refresh all" action.** A "↻" icon next to the Inventory
  screen's import icon (`refreshAllPrices()` in `app.js`) re-scrapes
  price + image for every card that has at least one saved source URL —
  exactly what an xlsx import leaves needing to happen next. Refactored
  the single-card refresh (`refreshPriceFor()`, the "?" price sheet's
  button) to share its core scrape-and-rebuild logic
  (`buildRefreshedRecord()`) with this bulk version, so there's one
  place that logic lives. Deliberately **sequential, not parallel** —
  firing many simultaneous scrape requests is more likely to trip a
  site's bot detection than pacing them one at a time, and this isn't
  time-critical — with a single bulk `inventory-save` call at the end
  rather than one save per card.

---

## 18. CRITICAL FIX — stored images never updating (bulk refresh especially)

**Symptom:** bulk refresh updated prices correctly but images never
changed — not in Inventory, not in Binder, not even for cards that had
never shown an image before.

**Root cause:** `serve-card-image.js` sets an aggressive
`Cache-Control: public, max-age=31536000, immutable` (cache forever),
under the documented assumption that *"a given blobKey's bytes never
change once written."* That assumption was TRUE when the function was
first built, but was silently broken when the refresh feature (§17) was
added: `buildRefreshedRecord()`/`saveCard()` were generating a
**deterministic** `tempId` from the card's `cardNumber`, specifically so
a refresh would overwrite the same blob key in place rather than
accumulate a new one every time. That's exactly what a "cache forever,
immutable" response header is designed to prevent from ever being
noticed — once any client (browser, or Netlify's own CDN edge) had
fetched that URL once, it would keep serving the original response
forever, no matter how many times the underlying blob was overwritten.

This also meant two cards sharing the same `cardNumber` (not unusual —
promos are often just `"P"` with no specific number, see the Inventory
screenshot that surfaced this) would silently share/overwrite the same
stored image.

**Fix:** rather than weaken the caching (which is the *correct* header
for genuinely immutable content), made image keys **actually** unique
per store call. `app.js::uniqueImageId(base)` appends a
timestamp+random suffix to every `cardId` passed to
`store-card-image.js` / `upload-card-image.js` / `store-external-image.js`
(§19), so every store call gets a brand-new key and the "immutable,
cache forever" header is honest again. This does mean old blobs from
previous saves/refreshes are simply orphaned rather than overwritten —
acceptable storage-cost-wise at this app's scale (a personal collection
tracker, small JPEGs), not something a cleanup job was built for.

---

## 19. PriceCharting removed entirely

Per explicit request, after confirming (§16) that its 403 is an
IP-level block on Netlify's infrastructure with no code-side fix
available. Removed from:
- `scrape-card.js` — `parsePriceCharting()` and its `PARSERS` entry gone.
  yuyu-tei/toretoku remain, comments updated to describe the two-source
  (not three-source) pricing model.
- `lib/image-sources.js` — the Google Cloud Storage allow-list entry
  (`storage.googleapis.com/images.pricecharting.com/...`) removed, since
  nothing fetches from it anymore.
- Add Card screen — URL field, Fetch button, and result card gone.
- `app.js` — every `pricecharting`-keyed branch removed from
  `computeScrapedSGD()`, `buildRawSourceEntry()`, `pickBestImageUrl()`,
  `fetchAll()`, `buildRefreshedRecord()`'s source list, and the "eligible
  for bulk refresh" filter.
- xlsx import/template — "PriceCharting URL" column gone from
  `IMPORT_COLUMN_MAP` and `build_scripts/make_template.py`.

**Consequence worth knowing:** PriceCharting was the *only* source for
Slab (graded card) reference pricing (PSA10) and the Singles
last-resort fallback. Removing it means:
- **Singles**: unaffected in the common case (still average of
  Toretoku + Yuyu-tei) — just loses the last-resort fallback for the
  rare card neither of those two has listed.
- **Slabs**: `computeMarketPrice()` now returns `{ value: null, label:
  "No pricing source available for Slabs" }` — Slabs have NO
  auto-scraped reference price at all until/unless a replacement source
  gets added. This isn't hidden or silently wrong, just genuinely empty.

**Backward compatibility:** any record that already has legacy
`rawSources.pricecharting` data (saved before this removal) still
displays it in the price breakdown sheet, explicitly labeled "legacy —
source removed." Nothing was deleted from existing data, and old
records aren't broken by this — they just stop being able to refresh
that specific source going forward.

---

## 20. Add Card: new fields (Sealed, Color/Family Type/Collection, Camera/Link uploads)

- **Condition Type gained a third option: "Sealed"** (alongside Singles
  and Slabs), in `card-options.json`'s `conditionTypes` and the Add Card
  dropdown. No special pricing logic added for it — a Sealed item falls
  through to the same "Singles" pricing path (average of
  Toretoku/Yuyu-tei, or "No pricing data yet"), which is an honest
  default since neither scraper targets sealed product listings; sealed
  items are expected to be priced manually via Purchase Price.
- **Three new card-detail fields**: Color, Family Type, Collection.
  - **Color** is a fixed multi-select — a row of toggle chips
    (`toggleColorChip()`) built from `card-options.json`'s new `colors`
    list (Red/Green/Blue/Purple/Black/Yellow). Cards can be more than
    one color (e.g. Red + Green), so this is genuinely multi-select, not
    a dropdown.
  - **Family Type** and **Collection** are free-text multi-value tag
    inputs (`addTagFrom()`/`removeTag()`/`renderTagChips()`) — type a
    value, press Enter, it becomes a removable chip; repeat for more
    values. Deliberately NOT a fixed list like Color: Family Type covers
    the game's many crew/faction "Feature" tags (dozens of them, e.g.
    "Straw Hat Crew", "Supernovas", "FILM"), too numerous and prone to
    drift to hardcode correctly without authoritative game data;
    Collection is open-ended by nature.
  - All three store as arrays on the record (`color`, `familyType`,
    `collection`) even with only one value, and show up in the price
    breakdown sheet's subtitle line. In xlsx import/export they're a
    single cell, values joined with `" + "` (e.g. "Red + Green") — see
    `MULTI_VALUE_FIELDS` in `app.js` and the Legend tab's notes in the
    generated template. Color is deliberately NOT a dropdown-validated
    column in the xlsx template even though it has a fixed list — Excel's
    list validation only allows picking one value per cell, which can't
    represent "Red + Green".
- **Additional photos now has three ways to add one**, not just file
  upload:
  - **Upload** — unchanged, file picker (`add-extra-photos-file`).
  - **Camera** — new: a second file input with `capture="environment"`
    (`add-extra-photos-camera`), which opens the device's rear camera
    directly on mobile instead of the gallery/file picker.
  - **Image link** — new: paste a URL (`add-extra-photo-link` +
    `addExtraPhotoLink()`). This is why `store-external-image.js` (§21)
    exists — `store-card-image.js`'s strict scraper allow-list would
    reject basically any URL a user would actually paste here (a Slab
    back photo isn't hosted on Toretoku).
  - All three feed into one unified `extraPhotos` array
    (`{type:'file', file} | {type:'link', url}`) with a shared preview
    row (`renderExtraPhotosPreview()`) that has a per-photo ✕ to remove
    it before saving. At save time, `file` entries go through
    `upload-card-image.js`, `link` entries through
    `store-external-image.js`.

---

## 21. New function: `store-external-image.js`

A third, deliberately more lenient image-storage path (see §20) for
"additional photo" links the user explicitly pastes in — as opposed to
`store-card-image.js` (strict host allow-list, for auto-scraped URLs
nothing chose to trust) and `upload-card-image.js` (bytes come straight
from the user's device, no URL involved at all). Guardrails that DO
still apply here, since it's a URL-fetching endpoint reachable by anyone
with the site password: https:// only, a basic hostname blocklist against
localhost/private-IP ranges (not exhaustive — a real SSRF defense needs
DNS-resolution-time checking, which a string check on the hostname can't
do, but it blocks the obvious cases), a content-type check that the
response is actually an image, and the same size cap as the other
image-storage functions. Uses `uniqueImageId()`-generated keys like
everywhere else (§18), and shares `imageFetchHeaders()` with
`store-card-image.js` / `preview-image-proxy.js` via `lib/image-sources.js`.

---

## 22. Inventory: swipe-to-delete / swipe-to-clone

Each Inventory row is now wrapped in a `.swipe-row` — a fixed clone
action (teal, left) and delete action (coral, right) sit behind the
row's normal content (`.swipe-content`), revealed by dragging the
content left or right past a threshold. Pointer events again (not
native HTML5 drag), same reasoning as the binder drag-to-reposition
feature — reliable touch support needs it. `attachAllSwipeHandlers()`
runs after every `renderInventory()`; `openSwipeRowId` tracks which row
(if any) is currently revealed so opening a new one closes the last,
and tapping anywhere outside an open row closes it too.

- **Delete**: `confirmDeleteInventoryCard()` → confirm dialog →
  `deleteInventoryCard()` → new `inventory-delete.js` function (POST
  `{ id }`, filters that id out of the inventory index and re-saves the
  array — same "read whole blob, filter, write it back" pattern as
  everything else). Single-id only for now; no bulk-delete endpoint
  exists yet. Doesn't clean up the deleted card's stored image blob(s)
  — same accepted orphaned-blobs trade-off as §18.
- **Clone**: `cloneInventoryCard()` copies the record with one
  explicitly-requested set of resets — Quantity → 0, Purchase Price →
  null, Purchase Currency → null, and no `id` (so `inventory-save.js`
  mints a fresh one) — plus two resets that weren't explicitly asked for
  but were necessary to avoid a broken result: Purchase Date (no
  purchase has happened for the clone, so keeping the original's date
  would misrepresent it) and binder placement (copying `binder.page`/
  `binder.slot` literally would make both cards claim the same slot,
  which is a rendering conflict — the clone lands unplaced instead,
  ready to be placed via the slot picker). Net effect: a clone always
  lands as a new **Wanted** listing — the obvious semantics for "I want
  another copy of this card."

---

## 23. Binder: multi-select directly on the Pending Delivery grid

Mass-select previously only worked on the list of cards below the grid
(§4/§9). Now the 3×3 grid itself is selectable too, and both share one
source of truth: `pendingSelectedIds` (a `Set`). Tapping a filled grid
slot while in select mode (`pendingSelectableSlotHtml()`) toggles
membership the same way tapping a list checkbox does
(`toggleCardSelection()`) — selecting a card either way shows as
selected in both places, since both re-render from the same Set on every
toggle. Visually: a teal outline + tint on the slot, plus a small ✓
badge (`.slot.selected` / `.slot-check-badge`). Outside select mode, the
grid behaves exactly as before (tap opens the price breakdown). Bulk
actions (`bulkUpdate()`) and the bulk bar count read the same Set — no
change to what they do, just where selection can happen.

---

## 24. Fourth-Pass Fixes (real scraping + binder UX bugs, fixed against real pages)

All of these were diagnosed against actual live pages (fetched directly,
not guessed), same approach as §16.

- **Toretoku name/image extraction was broken** on some listings —
  confirmed against `toretoku.jp/item/details/182709`. Two separate
  bugs, both fixed in `parseToretoku()`:
  - **Image**: the old selector looked for an `<img src>` containing
    "itemMini". The real image *is* at that path, but likely only
    reaches `src` via client-side lazy-loading — a scraper that doesn't
    execute JS can't see it. Switched to the `og:image` meta tag as
    primary (always present in raw server HTML, confirmed on two real
    listings), with the old `<img>` selector kept as a fallback.
  - **Name**: the old selector grabbed the page's first `<h1>` or `<h2>`
    — which turned out to be the SITE'S OWN HEADER ("トレカ専門店トレト
    ク ワンピースカード販売"), not the card title, which sits in a
    later `<h2>` after a huge category-nav block. Switched to parsing
    the `<title>` tag instead (format is consistently "【ワンピースカ
    ード】 &lt;name&gt; | トレカの激安通販 トレトク【公式】" — far more
    reliable than guessing at heading order).
- **Images silently failing to save even with a valid, allow-listed
  URL** (confirmed: a real Yuyu-tei image URL that matched the host
  allow-list exactly still didn't save). Root cause: `store-card-image.js`
  never sent a `Referer` header, and these CDNs likely enforce
  Referer-based hotlink protection (accept requests that look like they
  came from a page on the site, reject everything else) — the same
  general class of problem as the preview-thumbnail hotlinking bug in
  §17, just on the permanent-save path instead of the live-preview path,
  and silent because the failure was caught and only `console.warn`'d,
  never shown to the user. Fixed: `lib/image-sources.js` gained
  `refererForHost()`, and `imageFetchHeaders()` now takes an optional
  referer to send. Applied in both `store-card-image.js` and
  `preview-image-proxy.js`.
- **Binder slots never showed the card's actual photo** — `slotHtml()`,
  `manualSlotHtml()`, and `pendingSelectableSlotHtml()` only ever
  rendered a rarity tag and price text, no image, even when the record
  had one. Fixed by setting the slot's `background-image` to
  `imageUrlFor(record)` when present. This needed a new scrim overlay
  (`.slot.filled::after`, a bottom-heavy dark gradient) so the number/
  rarity/price text stays legible over a busy photo instead of plain
  text with no backing.
- **Binder swipe-to-change-page was effectively broken.** Two combined
  causes:
  - `setupBinderSwipe()` explicitly refused to start tracking a swipe
    if it began on a `.slot.filled` element — meant to avoid conflicting
    with `attachSlotDragHandlers()`'s own drag-to-reposition. But cards
    cover most of the visible grid, so almost any natural swipe attempt
    starts on a card, meaning the exclusion ate almost every swipe
    attempt regardless of direction.
  - The direction mapping was also inverted from what users actually
    expect: swipe left triggered "next page." Explicit feedback: swipe
    RIGHT should mean next page (turning a page forward), not left.
  - **Fixed both together**: removed the target exclusion, flipped the
    direction (`dx > 0` → next), and resolved the conflict with
    drag-to-reposition differently — `attachSlotDragHandlers()` now
    requires a brief hold (`SLOT_HOLD_MS`, 180ms) before a drag arms at
    all (visually cued by a gold outline + slight scale, `.drag-armed`),
    the same "press and hold, then drag" pattern as rearranging
    home-screen icons. A quick swipe never triggers the hold, so it's
    always free to reach the page-swipe handler; a genuine hold+drag
    sets a shared `slotDragEngaged` flag that the swipe handler checks
    before acting, so one continuous gesture can't be interpreted as
    both a reposition AND a page change.
- **New: "Change card in this slot."** Previously, swapping a card
  already placed in a binder slot for a different one took two separate
  trips (open detail → Remove from binder → tap the now-empty slot →
  pick a replacement). The price-breakdown sheet now has a "⇄ Change
  card in this slot" button (only shown for manually-arranged binders,
  same condition as "Remove from this binder") — `changeCardInSlot()`
  clears the current occupant's placement first (same effect as Remove),
  then immediately opens the slot picker targeted at that exact page/
  slot. Clearing first matters: `assignCardToSlot()` doesn't check
  whether a slot is already occupied, so skipping this step would leave
  both cards claiming the same slot.
- **New: full card detail view.** Tapping an Inventory row (not just its
  "?" button, which still works too) now opens the same sheet used for
  the price breakdown, but it's been expanded into a real detail view: a
  status badge (Purchased/Pending Delivery/Wanted, color-coded), and a
  `pm-details` grid covering every field the old view didn't show —
  Category, Rarity, Foil Type, Language, Condition Type (+ Sub-
  Condition/Grading Co./Cert Number for Slabs), Purchase Price/Date (for
  non-Wanted cards), and current binder placement if any. `.modal-sheet`
  gained `max-height: 85vh; overflow-y: auto` since this made the sheet
  meaningfully taller — applies to every modal, not just this one, but
  none of the others were close to needing it before. Tapping a row that's
  currently swiped open (§22) closes the swipe instead of opening the
  detail sheet, matching how swipe-action lists are generally expected
  to behave.
