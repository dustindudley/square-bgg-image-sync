/**
 * Inngest functions – "Sync BGG Images to Square"
 *
 * Uses a fan-out pattern to avoid Vercel timeout issues:
 *
 *   1. syncImages (parent) — fetches the Square catalog, filters to
 *      board/card games with UPCs, and dispatches one event per item.
 *
 *   2. syncSingleItem (child) — processes a single item: resolves UPC,
 *      searches BGG, downloads image, uploads to Square.
 *
 * Each child runs as its own independent Inngest function invocation,
 * so there's no step-replay overhead that would cause timeouts on
 * large catalogs.
 */

import { inngest } from "../client";
import { listCatalogItems, uploadImageToSquareItem, SquareCatalogItem } from "../../lib/square";
import { findBestMatch } from "../../lib/bgg";

// ---------------------------------------------------------------------------
// Event schemas
// ---------------------------------------------------------------------------

export type SyncImagesEvent = {
  name: "sync/images.requested";
  data: {
    /** If true, also re-sync items that already have an image */
    force?: boolean;
    /** Process only items whose names match this substring (for testing) */
    filterName?: string;
  };
};

export type SyncSingleItemEvent = {
  name: "sync/item.process";
  data: {
    item: SquareCatalogItem;
  };
};

// ---------------------------------------------------------------------------
// Parent function – fetch catalog and fan out
// ---------------------------------------------------------------------------

export const syncImages = inngest.createFunction(
  {
    id: "sync-bgg-images-to-square",
    name: "Sync BGG Images → Square (Dispatcher)",
    cancelOn: [{ event: "sync/images.cancel" }],
  },
  { event: "sync/images.requested" },
  async ({ event, step, logger }) => {
    const force = event.data.force ?? false;
    const filterName = event.data.filterName;

    // -----------------------------------------------------------------------
    // Step 1 – Fetch catalog (board/card games with UPCs only)
    // -----------------------------------------------------------------------
    const allItems = await step.run("fetch-square-catalog", async () => {
      logger.info("Fetching Square catalog items (board/card games with UPCs)…");
      const items = await listCatalogItems();
      logger.info(`Found ${items.length} game items with UPCs`);
      return items;
    });

    // Filter
    let items = allItems;
    if (!force) {
      items = items.filter((i) => !i.hasImage);
    }
    if (filterName) {
      const lower = filterName.toLowerCase();
      items = items.filter((i) => i.name.toLowerCase().includes(lower));
    }

    logger.info(`Dispatching ${items.length} items for processing`);

    // -----------------------------------------------------------------------
    // Step 2 – Fan out: send one event per item (batched in groups of 100)
    // -----------------------------------------------------------------------
    const BATCH_SIZE = 100;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      await step.sendEvent(`dispatch-batch-${i}`, batch.map((item) => ({
        name: "sync/item.process" as const,
        data: { item },
      })));
    }

    return {
      message: `Dispatched ${items.length} items for image sync.`,
      totalItems: items.length,
    };
  }
);

// ---------------------------------------------------------------------------
// Child function – process a single item
// ---------------------------------------------------------------------------

export const syncSingleItem = inngest.createFunction(
  {
    id: "sync-single-item",
    name: "Sync Single Item (BGG → Square)",
    retries: 2,
    concurrency: {
      // Limit concurrent item syncs to be kind to BGG rate limits
      limit: 3,
    },
  },
  { event: "sync/item.process" },
  async ({ event, step, logger }) => {
    const { item } = event.data;

    // Step 1 – Search BGG
    const match = await step.run("search-bgg", async () => {
      logger.info(`🔍 Searching BGG for "${item.name}" (UPC: ${item.meta.upc})…`);

      const result = await findBestMatch(item.name, {
        year: item.meta.year,
        publisher: item.meta.publisher,
        upc: item.meta.upc,
      });

      if (!result || !result.imageUrl) {
        logger.warn(`❌ No BGG match found for "${item.name}"`);
        return null;
      }

      logger.info(
        `✅ Matched "${item.name}" → BGG #${result.bggId} "${result.name}" (${result.yearPublished ?? "??"})`
      );
      return result;
    });

    if (!match) {
      return {
        objectId: item.objectId,
        name: item.name,
        status: "no_match" as const,
      };
    }

    // Step 2 – Upload image to Square
    const uploadResult = await step.run("upload-to-square", async () => {
      logger.info(`📸 Uploading image for "${item.name}" from BGG #${match.bggId}…`);

      const { imageObjectId } = await uploadImageToSquareItem(
        item.objectId,
        match.imageUrl!,
        `${match.name} (BGG #${match.bggId})`
      );

      logger.info(`✅ Uploaded image ${imageObjectId} for "${item.name}"`);
      return { imageObjectId };
    });

    return {
      objectId: item.objectId,
      name: item.name,
      status: "synced" as const,
      bggId: match.bggId,
      imageObjectId: uploadResult.imageObjectId,
    };
  }
);
