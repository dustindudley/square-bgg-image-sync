/**
 * Inngest function – "Sync BGG Images to Square"
 *
 * This long-running background job:
 *   1. Fetches all board/card game items with UPCs from Square catalog.
 *   2. For each item without an image, resolves the UPC to a full name
 *      and searches BGG.
 *   3. Verifies the match (year, publisher) when possible.
 *   4. Downloads the high-res image from BGG.
 *   5. Uploads it to the Square catalog item via CreateCatalogImage.
 *
 * Circuit breaker: the run is aborted after 10 cumulative 401 errors
 * to avoid burning through retries on a bad token.
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

    const MAX_401_ERRORS = 10;

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

    logger.info(`Processing ${items.length} items`);

    // -----------------------------------------------------------------------
    // Step 2 – Process each item individually (each is its own step)
    //          with a 401 circuit breaker
    // -----------------------------------------------------------------------
    const results: {
      objectId: string;
      name: string;
      status: "synced" | "no_match" | "error";
      bggId?: number;
      error?: string;
    }[] = [];

    let authErrorCount = 0;

    for (const item of items) {
      // Circuit breaker: stop the entire run after 10 cumulative 401s
      if (authErrorCount >= MAX_401_ERRORS) {
        logger.error(
          `🛑 Stopping: ${authErrorCount} cumulative 401 errors reached. ` +
            "Check your SQUARE_ACCESS_TOKEN — it may be expired or have insufficient permissions."
        );
        break;
      }

      const result = await step.run(
        `sync-item-${item.objectId}`,
        async () => {
          try {
            logger.info(`🔍 Searching BGG for "${item.name}" (UPC: ${item.meta.upc})…`);

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
            const is401 = err.message?.includes("401") || err.statusCode === 401;
            logger.error(
              `💥 Error syncing "${item.name}": ${err.message}${is401 ? " [AUTH ERROR]" : ""}`
            );
            return {
              objectId: item.objectId,
              name: item.name,
              status: "error" as const,
              error: err.message,
              _is401: is401,
            };
          }
        }
      );

      // Track 401s outside the step so we can break the loop
      if ((result as any)._is401) {
        authErrorCount++;
      }

      results.push(result);
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    const synced = results.filter((r) => r.status === "synced").length;
    const noMatch = results.filter((r) => r.status === "no_match").length;
    const errored = results.filter((r) => r.status === "error").length;
    const aborted = authErrorCount >= MAX_401_ERRORS;

    const summary = aborted
      ? `⛔ ABORTED after ${authErrorCount} auth (401) errors. ${synced} synced, ${noMatch} no match, ${errored} errors out of ${results.length}/${items.length} items processed.`
      : `Done! ${synced} synced, ${noMatch} no match, ${errored} errors out of ${results.length} items.`;
    logger.info(summary);

    return { summary, aborted, authErrorCount, results };
  }
);

