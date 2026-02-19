# Square ↔ BGG Image & Description Sync — Project Status

> **Last updated:** February 18, 2026
> **Status:** ✅ COMPLETED
> **GitHub:** https://github.com/dustindudley/square-bgg-image-sync
> **Deployed to:** Vercel (imported from GitHub, auto-deploys on push)

---

## Project Goal

Automatically sync **product images** and **descriptions** from **BoardGameGeek (BGG)** to a **Square** point-of-sale catalog for a board game store. The app fetches board/card game items from Square, looks up each game on BGG by UPC barcode (resolved to full title) or product name, downloads the high-res image and description, and uploads them to the Square catalog item.

---

## Architecture Overview

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Dashboard   │────▶│  Vercel API  │────▶│  Inngest (Cloud) │
│  (Next.js)   │     │  /trigger    │     │  Background Job  │
└──────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │
                     ┌─────────────────────────────┼──────────────────────────┐
                     │  Parent dispatches one event per item (fan-out)        │
                     │                             ▼                          │
                     │  Child function per item:                              │
                     │  1. UPC → UPCitemdb → full title (if UPC available)    │
                     │  2. Title → BGG XML API2 → search + match              │
                     │  3. BGG Thing → high-res image URL + description       │
                     │  4. Download image → Square CreateCatalogImage         │
                     │  5. Description → Square UpsertCatalogObject           │
                     └────────────────────────────────────────────────────────┘
```

- **Framework:** Next.js 14 (App Router) on Vercel
- **Background jobs:** Inngest fan-out pattern (parent dispatches, children process independently)
- **BGG API:** XML API2 with Bearer token auth, exponential back-off on 429s
- **Square SDK:** v39, uses `FileWrapper` for multipart image uploads, `upsertCatalogObject` for descriptions
- **UPC resolution:** UPCitemdb.com free trial API (100 lookups/day, no key needed)

---

## Tech Stack & Dependencies

| Package            | Version  | Purpose                                    |
|--------------------|----------|--------------------------------------------|
| `next`             | ^14.2.21 | App framework, API routes, UI              |
| `react` / `react-dom` | ^18.3.1 | UI                                      |
| `square`           | ^39.1.0  | Square catalog API (list items, upload images, update descriptions) |
| `inngest`          | ^3.27.0  | Background job orchestration on Vercel     |
| `fast-xml-parser`  | ^4.5.1   | Parse BGG XML API2 responses               |
| `typescript`       | ^5.7.3   | Type safety                                |

---

## File Structure

```
src/
├── app/
│   ├── api/
│   │   ├── debug-catalog/route.ts  # GET /api/debug-catalog — catalog filtering diagnostics
│   │   ├── health/route.ts         # GET /api/health — env var diagnostics
│   │   ├── inngest/route.ts        # Inngest serve handler (GET/POST/PUT)
│   │   └── trigger-sync/route.ts   # POST /api/trigger-sync — kicks off sync
│   ├── layout.tsx                  # Root layout (dark theme)
│   └── page.tsx                    # Dashboard UI (trigger sync, filter, force)
├── inngest/
│   ├── client.ts                   # Inngest client singleton
│   └── functions/
│       └── sync-images.ts          # Parent dispatcher + child processor functions
└── lib/
    ├── bgg.ts                      # BGG XML API2 client (search, thing detail + description, matcher)
    ├── square.ts                   # Square SDK (list catalog, upload image, update description)
    └── upc.ts                      # UPC barcode → product title lookup
```

Additional root files:
- `vercel.json` — sets `maxDuration: 300` for the Inngest route
- `env.example` — documents all required environment variables
- `package.json`, `tsconfig.json`, `next.config.js`

---

## Environment Variables (Vercel)

| Variable               | Status  | Description                                                    |
|------------------------|---------|----------------------------------------------------------------|
| `SQUARE_ACCESS_TOKEN`  | ✅ Set  | Square API token (needs `ITEMS_READ`, `ITEMS_WRITE`, `IMAGES_WRITE` permissions) |
| `SQUARE_ENVIRONMENT`   | ✅ Set  | `"production"` or `"sandbox"`                                  |
| `BGG_API_TOKEN`        | ✅ Set  | Bearer token from BGG app registration                         |
| `INNGEST_EVENT_KEY`    | ✅ Set  | Auto-set by Inngest Vercel integration                         |
| `INNGEST_SIGNING_KEY`  | ✅ Set  | Auto-set by Inngest Vercel integration                         |

---

## Sync Logic (how it works)

### Inngest Fan-Out Pattern

The sync uses two Inngest functions to avoid Vercel timeout issues:

1. **Parent function** (`sync-bgg-images-to-square`) — Fetches the full Square catalog, filters to game items needing an image or description, and dispatches one event per item in batches of 100.
2. **Child function** (`sync-single-item`) — Processes a single item independently with 3 steps. Concurrency is capped at 3 to respect BGG rate limits. Each child has 2 retries for transient failures.

### Step 1 — Fetch Square Catalog
- `src/lib/square.ts` → `listCatalogItems()`
- Auto-discovers game categories by scanning all Square CATEGORY objects for names containing: `"board game"`, `"card game"`, `"board games"`, `"card games"`, `"tabletop"`, `"table top"`, `"games"`
- Returns all items that belong to one of those categories
- UPC barcodes are extracted when available (used for more accurate BGG matching) but are **not required**
- Tracks `hasImage` and `hasDescription` to skip items that already have both

### Step 2 — Match on BGG
- `src/lib/bgg.ts` → `findBestMatch(name, { upc, year, publisher })`
- If UPC available: resolves it via UPCitemdb (`src/lib/upc.ts`) to get the full product title
- Searches BGG XML API2 with the full title (or Square name as fallback)
- Scores results: exact name match (+10), partial (+5), year match (+8)
- Fetches top 3 candidates' details, checks publisher if hint is available
- Falls back to first result with an image if nothing scores well

### Step 3 — Upload Image to Square (if needed)
- `src/lib/square.ts` → `uploadImageToSquareItem()`
- Downloads image from BGG's CDN (`cf.geekdo-images.com`)
- Wraps in `FileWrapper` (from Square SDK) with a `Readable` stream
- Calls `createCatalogImage` to attach image to the Square catalog item
- **Skipped** if the item already has an image

### Step 4 — Update Description on Square (if needed)
- `src/lib/square.ts` → `updateItemDescription()`
- Retrieves the current catalog object (to get `version` for optimistic concurrency)
- BGG descriptions are decoded from XML entities into clean HTML with `<p>` and `<br>` tags
- Calls `upsertCatalogObject` to set the `descriptionHtml` field
- **Skipped** if the item already has a description

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Check deployment status and env var availability |
| `/api/debug-catalog` | GET | Diagnostic view of catalog filtering (categories, UPC counts, sample items) |
| `/api/trigger-sync` | POST | Trigger the image + description sync via Inngest |
| `/api/inngest` | GET/POST/PUT | Inngest webhook handler (auto-called by Inngest Cloud) |

### Trigger Sync Options

```json
POST /api/trigger-sync
{
  "force": false,         // true = re-sync ALL items, even those with images/descriptions
  "filterName": "catan"   // optional — only process items matching this substring
}
```

---

## Issues Encountered & Resolved

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Inngest "could not reach URL" | App not synced with Inngest Cloud | Added `servePath: "/api/inngest"`, installed Inngest Vercel integration |
| No tasks visible in Inngest after trigger | Functions not discovered | Synced app URL in Inngest dashboard |
| 401 on every Square image upload | Used `Blob` instead of `FileWrapper` for multipart | Import `FileWrapper` from `"square"`, wrap `Readable` stream |
| BGG returning 401 on all searches | Missing `User-Agent` header | Added `User-Agent` header (but this alone wasn't enough) |
| BGG still returning 401 | BGG now requires registered app + Bearer token | Added `Authorization: Bearer <token>` header, registered BGG app |
| Non-game items being processed | No category filtering | Auto-discover game categories by name keywords |
| Only 17 items found (should be ~1,200+) | Hard UPC requirement filtered 96% of items | Made UPC optional — items without UPC use name-based BGG search |
| "Table Top" category missed | Keyword `"tabletop"` didn't match `"Table Top"` (space) | Added `"table top"` to keyword list |
| Sync stopped after ~19 items | Inngest step-replay overhead in sequential loop | Refactored to fan-out pattern (parent dispatches, children process independently) |
| Child runs not appearing in Inngest | New child function not discovered after deploy | Re-synced app in Inngest dashboard to register the new function |

---

## Potential Future Improvements

- **Dry run mode** — preview BGG matches without uploading to Square
- **Match caching** — store BGG match results to avoid re-searching on subsequent runs
- **UPC API upgrade** — UPCitemdb free tier is limited to 100 lookups/day; a paid UPC API could improve accuracy for large catalogs
- **Progress tracking** — add a database/KV store to track sync progress across runs
- **Selective re-sync** — allow re-syncing only descriptions or only images independently

---

## How to Resume Development

```bash
# Clone the repo
git clone https://github.com/dustindudley/square-bgg-image-sync.git
cd square-bgg-image-sync

# Install dependencies
npm install

# Run locally (needs .env file with all vars set)
npm run dev

# In a separate terminal, run the Inngest dev server
npx inngest-cli@latest dev
```

The Inngest dev server provides a local dashboard at http://localhost:8288 where you can trigger and monitor function runs without needing the cloud service.

---

## Key API References

- **BGG XML API2:** https://boardgamegeek.com/wiki/page/BGG_XML_API2
- **BGG API Registration:** https://boardgamegeek.com/using_the_xml_api
- **BGG API Terms:** https://boardgamegeek.com/wiki/page/XML_API_Terms_of_Use
- **Square Catalog API:** https://developer.squareup.com/reference/square/catalog-api
- **Square CreateCatalogImage:** https://developer.squareup.com/reference/square/catalog-api/create-catalog-image
- **Square UpsertCatalogObject:** https://developer.squareup.com/reference/square/catalog-api/upsert-catalog-object
- **Inngest Docs:** https://www.inngest.com/docs
- **UPCitemdb API:** https://www.upcitemdb.com/wp/docs/main/development/
