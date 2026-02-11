/**
 * Inngest function – "Sync BGG Images to Square"
 *
 * This long-running background job:
 *   1. Fetches all Square catalog items (excluding Drinks / Shirts).
 *   2. For each item without an image, searches BGG by product name.
 *   3. Verifies the match (year, publisher) when possible.
 *   4. Downloads the high-res image from BGG.
 *   5. Uploads it to the Square catalog item via CreateCatalogImage.
 *
 * Inngest handles retries, timeouts, and step-level caching automatically,
 * so we can safely run this even if it takes tens of minutes.
 */

import { inngest } from "../client";
import { listCatalogItems, uploadImageToSquareItem } from "../../lib/square";
import { findBestMatch } from "../../lib/bgg";

// ---------------------------------------------------------------------------
// Event schema
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

// ---------------------------------------------------------------------------
// Function definition
// ---------------------------------------------------------------------------

export const syncImages = inngest.createFunction(
  {
    id: "sync-bgg-images-to-square",
    name: "Sync BGG Images → Square",
    // Allow up to 2 hours for very large catalogs
    cancelOn: [{ event: "sync/images.cancel" }],
  },
  { event: "sync/images.requested" },
  async ({ event, step, logger }) => {
    const force = event.data.force ?? false;
    const filterName = event.data.filterName;

    // -----------------------------------------------------------------------
    // Step 1 – Fetch catalog
    // -----------------------------------------------------------------------
    const allItems = await step.run("fetch-square-catalog", async () => {
      logger.info("Fetching Square catalog items…");
      const items = await listCatalogItems();
      logger.info(`Found ${items.length} items (after category exclusions)`);
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

    logger.info(`Processing ${items.length} items`);

    // -----------------------------------------------------------------------
    // Step 2 – Process each item individually (each is its own step)
    // -----------------------------------------------------------------------
    const results: {
      objectId: string;
      name: string;
      status: "synced" | "no_match" | "error";
      bggId?: number;
      error?: string;
    }[] = [];

    for (const item of items) {
      const result = await step.run(
        `sync-item-${item.objectId}`,
        async () => {
          try {
            logger.info(`🔍 Searching BGG for "${item.name}"…`);

            const match = await findBestMatch(item.name, {
              year: item.meta.year,
              publisher: item.meta.publisher,
              upc: item.meta.upc,
            });

            if (!match || !match.imageUrl) {
              logger.warn(`❌ No BGG match found for "${item.name}"`);
              return {
                objectId: item.objectId,
                name: item.name,
                status: "no_match" as const,
              };
            }

            logger.info(
              `✅ Matched "${item.name}" → BGG #${match.bggId} "${match.name}" (${match.yearPublished ?? "??"})`
            );

            // Upload to Square
            const { imageObjectId } = await uploadImageToSquareItem(
              item.objectId,
              match.imageUrl,
              `${match.name} (BGG #${match.bggId})`
            );

            logger.info(
              `📸 Uploaded image ${imageObjectId} for "${item.name}"`
            );

            return {
              objectId: item.objectId,
              name: item.name,
              status: "synced" as const,
              bggId: match.bggId,
            };
          } catch (err: any) {
            logger.error(
              `💥 Error syncing "${item.name}": ${err.message}`
            );
            return {
              objectId: item.objectId,
              name: item.name,
              status: "error" as const,
              error: err.message,
            };
          }
        }
      );

      results.push(result);
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    const synced = results.filter((r) => r.status === "synced").length;
    const noMatch = results.filter((r) => r.status === "no_match").length;
    const errored = results.filter((r) => r.status === "error").length;

    const summary = `Done! ${synced} synced, ${noMatch} no match, ${errored} errors out of ${results.length} items.`;
    logger.info(summary);

    return { summary, results };
  }
);

