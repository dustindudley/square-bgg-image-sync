# Square ↔ BGG Image Sync — Project Status & Handoff

> **Last updated:** February 12, 2026
> **Status:** ⏸️ PAUSED — Waiting for BGG API application approval
> **GitHub:** https://github.com/dustindudley/square-bgg-image-sync
> **Deployed to:** Vercel (imported from GitHub, auto-deploys on push)

---

## Project Goal

Automatically sync product images from **BoardGameGeek (BGG)** to a **Square** point-of-sale catalog for a board game store. The app fetches board/card game items from Square, looks up each game on BGG by UPC barcode (resolved to full title) or product name, downloads the high-res image, and uploads it to the Square catalog item.

---

## Architecture Overview

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Dashboard   │────▶│  Vercel API  │────▶│  Inngest (Cloud) │
│  (Next.js)   │     │  /trigger    │     │  Background Job  │
└──────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │
                     ┌─────────────────────────────┼─────────────────────┐
                     │  For each Square item:      ▼                     │
                     │  1. UPC → UPCitemdb → full title                  │
                     │  2. Title → BGG XML API2 → search + match         │
                     │  3. BGG Thing → high-res image URL                │
                     │  4. Download image → Square CreateCatalogImage    │
                     └───────────────────────────────────────────────────┘
```

- **Framework:** Next.js 14 (App Router) on Vercel
- **Background jobs:** Inngest (each item is its own step for resilience/resumability)
- **BGG API:** XML API2 with Bearer token auth, exponential back-off on 429s
- **Square SDK:** v39, uses `FileWrapper` for multipart image uploads
- **UPC resolution:** UPCitemdb.com free trial API (100 lookups/day, no key needed)

---

## Tech Stack & Dependencies

| Package            | Version  | Purpose                                    |
|--------------------|----------|--------------------------------------------|
| `next`             | ^14.2.21 | App framework, API routes, UI              |
| `react` / `react-dom` | ^18.3.1 | UI                                      |
| `square`           | ^39.1.0  | Square catalog API (list items, upload images) |
| `inngest`          | ^3.27.0  | Background job orchestration on Vercel     |
| `fast-xml-parser`  | ^4.5.1   | Parse BGG XML API2 responses               |
| `typescript`       | ^5.7.3   | Type safety                                |

---

## File Structure

```
src/
├── app/
│   ├── api/
│   │   ├── health/route.ts        # GET /api/health — env var diagnostics
│   │   ├── inngest/route.ts       # Inngest serve handler (GET/POST/PUT)
│   │   └── trigger-sync/route.ts  # POST /api/trigger-sync — kicks off sync
│   ├── layout.tsx                 # Root layout (dark theme)
│   └── page.tsx                   # Dashboard UI (trigger sync, filter, force)
├── inngest/
│   ├── client.ts                  # Inngest client singleton
│   └── functions/
│       └── sync-images.ts         # Main background sync function
└── lib/
    ├── bgg.ts                     # BGG XML API2 client (search, thing, matcher)
    ├── square.ts                  # Square SDK (list catalog, upload image)
    └── upc.ts                     # UPC barcode → product title lookup
```

Additional root files:
- `vercel.json` — sets `maxDuration: 300` for the Inngest route
- `env.example` — documents all required environment variables
- `package.json`, `tsconfig.json`, `next.config.js`

---

## Environment Variables (Vercel)

| Variable               | Status     | Description                                                    |
|------------------------|------------|----------------------------------------------------------------|
| `SQUARE_ACCESS_TOKEN`  | ✅ Set     | Square API token (needs `ITEMS_READ`, `ITEMS_WRITE`, `IMAGES_WRITE` permissions) |
| `SQUARE_ENVIRONMENT`   | ✅ Set     | `"production"` or `"sandbox"`                                  |
| `BGG_API_TOKEN`        | ⏳ Pending | Bearer token from BGG app registration (see blocker below)     |
| `INNGEST_EVENT_KEY`    | ✅ Set     | Auto-set by Inngest Vercel integration                         |
| `INNGEST_SIGNING_KEY`  | ✅ Set     | Auto-set by Inngest Vercel integration                         |

---

## Current Blocker — BGG API Token

BGG now requires all XML API users to register an application and use a Bearer token.

**What was done:**
- Application submitted at https://boardgamegeek.com/applications
- BGG says approval may take **a week or more**

**What to do once approved:**
1. Go to https://boardgamegeek.com/applications
2. Click **"Tokens"** under the approved app
3. Generate a Bearer token (looks like `e3f8c3ff-9926-4efc-863c-3b92acda4d32`)
4. Add it in **Vercel → Settings → Environment Variables** as `BGG_API_TOKEN`
5. **Redeploy** the app in Vercel
6. Verify at `https://YOUR-APP.vercel.app/api/health` — `hasBggApiToken` should be `true`
7. Trigger a sync from the dashboard or test with a filter (e.g. `filterName: "Catan"`)

**Reference:** https://boardgamegeek.com/using_the_xml_api

---

## Sync Logic (how it works)

### Step 1 — Fetch Square Catalog
- `src/lib/square.ts` → `listCatalogItems()`
- Auto-discovers game categories by scanning all Square CATEGORY objects for names containing: `"board game"`, `"card game"`, `"board games"`, `"card games"`, `"tabletop"`, `"games"`
- Only returns items that belong to one of those categories **AND** have a UPC barcode
- Items without a UPC are skipped (logged to console)

### Step 2 — Match on BGG
- `src/lib/bgg.ts` → `findBestMatch(name, { upc, year, publisher })`
- If UPC available: resolves it via UPCitemdb (`src/lib/upc.ts`) to get the full product title
- Searches BGG XML API2 with the full title (or Square name as fallback)
- Scores results: exact name match (+10), partial (+5), year match (+8)
- Fetches top 3 candidates' details, checks publisher if hint is available
- Falls back to first result with an image if nothing scores well

### Step 3 — Upload to Square
- `src/lib/square.ts` → `uploadImageToSquareItem()`
- Downloads image from BGG's CDN (`cf.geekdo-images.com`)
- Wraps in `FileWrapper` (from Square SDK) with a `Readable` stream — **critical:** plain `Blob` causes 401 errors because auth headers aren't attached to the multipart request
- Calls `createCatalogImage` to attach image to the Square catalog item

### Circuit Breaker
- The Inngest function tracks 401 errors across all steps
- After **10 cumulative 401 errors**, the run is aborted with a clear error message
- Prevents wasting API calls on expired/invalid tokens

---

## Issues Encountered & Resolved

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Inngest "could not reach URL" | App not synced with Inngest Cloud | Added `servePath: "/api/inngest"`, installed Inngest Vercel integration |
| No tasks visible in Inngest after trigger | Functions not discovered | Had to sync app URL in Inngest dashboard |
| 401 on every Square image upload | Used `Blob` instead of `FileWrapper` for multipart | Import `FileWrapper` from `"square"`, wrap `Readable` stream |
| BGG returning 401 on all searches | Missing `User-Agent` header | Added `User-Agent` header (but this alone wasn't enough) |
| BGG still returning 401 | BGG now requires registered app + Bearer token | Added `Authorization: Bearer <token>` header, awaiting app approval |
| Non-game items being processed | No category filtering | Auto-discover game categories by name, require UPC barcode |

---

## What's Left To Do (after BGG approval)

1. **Set `BGG_API_TOKEN`** in Vercel env vars and redeploy
2. **Test with a single item** — use the filter field (e.g. `"Catan"`) to sync just one product
3. **Run full sync** — click "Start Image Sync" without a filter
4. **Monitor in Inngest** — watch for errors at https://app.inngest.com
5. **Potential improvements:**
   - UPCitemdb free tier is limited to 100 lookups/day; if catalog is larger, consider a paid UPC API or batch across days
   - Could add a "dry run" mode that previews matches without uploading
   - Could store BGG match results to avoid re-searching on subsequent runs
   - The game category keyword list in `square.ts` (`GAME_CATEGORY_KEYWORDS`) may need adjusting to match the store's actual Square category names

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
- **Inngest Docs:** https://www.inngest.com/docs
- **UPCitemdb API:** https://www.upcitemdb.com/wp/docs/main/development/

