/**
 * Square SDK helpers
 *
 * Required env vars:
 *   SQUARE_ACCESS_TOKEN   – your Square OAuth / personal access token
 *   SQUARE_ENVIRONMENT    – "sandbox" | "production"
 */

import { Client, Environment, FileWrapper } from "square";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: Client | null = null;

export function getSquareClient(): Client {
  if (_client) return _client;

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) throw new Error("Missing SQUARE_ACCESS_TOKEN env var");

  const env =
    process.env.SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox;

  _client = new Client({ accessToken, environment: env });
  return _client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SquareCatalogItem {
  /** The catalog object ID (e.g. "ABCDEF123") */
  objectId: string;
  /** Item name */
  name: string;
  /** Whether the item already has at least one image attached */
  hasImage: boolean;
  /** Whether the item already has a description */
  hasDescription: boolean;
  /** Optional metadata extracted from custom attributes */
  meta: {
    year?: number;
    publisher?: string;
    upc?: string;
  };
  /** Category IDs this item belongs to */
  categoryIds: string[];
}

// ---------------------------------------------------------------------------
// Category discovery
// ---------------------------------------------------------------------------

/** Keywords that identify board / card game categories (case-insensitive). */
const GAME_CATEGORY_KEYWORDS = [
  "board game",
  "card game",
  "board games",
  "card games",
  "tabletop",
  "table top",
  "games",
];

/**
 * Fetch all CATEGORY objects from Square and return a Map of id → name
 * for categories whose name matches board / card game keywords.
 */
async function fetchGameCategoryIds(): Promise<Map<string, string>> {
  const client = getSquareClient();
  const gameCategories = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const { result } = await client.catalogApi.listCatalog(cursor, "CATEGORY");

    for (const obj of result.objects ?? []) {
      const name = obj.categoryData?.name ?? "";
      const nameLower = name.toLowerCase();

      if (GAME_CATEGORY_KEYWORDS.some((kw) => nameLower.includes(kw))) {
        gameCategories.set(obj.id!, name);
      }
    }

    cursor = result.cursor ?? undefined;
  } while (cursor);

  return gameCategories;
}

// ---------------------------------------------------------------------------
// List catalog items (board & card games with UPCs only)
// ---------------------------------------------------------------------------

/**
 * Retrieve catalog items that belong to board / card game categories.
 * If an item has a UPC barcode it will be used for more accurate BGG
 * matching, but items without a UPC are still included (name-based search).
 */
export async function listCatalogItems(): Promise<SquareCatalogItem[]> {
  const client = getSquareClient();

  // 1. Discover which category IDs are board / card game categories
  const gameCats = await fetchGameCategoryIds();
  console.log(
    `[Square] Found ${gameCats.size} game categories: ${[...gameCats.values()].join(", ") || "(none)"}`
  );

  if (gameCats.size === 0) {
    console.warn(
      "[Square] No board/card game categories found. " +
        "Make sure your Square catalog has categories with names containing: " +
        GAME_CATEGORY_KEYWORDS.join(", ")
    );
    return [];
  }

  // 2. Paginate through all ITEM objects
  const items: SquareCatalogItem[] = [];
  let cursor: string | undefined;
  let withUpc = 0;
  let withoutUpc = 0;

  do {
    const { result } = await client.catalogApi.listCatalog(cursor, "ITEM");

    for (const obj of result.objects ?? []) {
      const itemData = obj.itemData;
      if (!itemData) continue;

      // Collect all category IDs for this item
      const catIds: string[] = [];
      if (itemData.categoryId) catIds.push(itemData.categoryId);
      if ((itemData as any).categories) {
        for (const c of (itemData as any).categories) {
          if (c.id) catIds.push(c.id);
        }
      }

      // Only include items in a game category
      const isGame = catIds.some((id) => gameCats.has(id));
      if (!isGame) continue;

      // Try to extract a UPC from any variation (optional — helps matching)
      let upc: string | undefined;
      for (const variation of itemData.variations ?? []) {
        const varUpc = variation.itemVariationData?.upc;
        if (varUpc) {
          upc = varUpc;
          break;
        }
      }

      if (upc) {
        withUpc++;
      } else {
        withoutUpc++;
      }

      const hasImage = (obj.itemData?.imageIds?.length ?? 0) > 0;
      const desc = itemData.descriptionHtml ?? itemData.description ?? "";
      const hasDescription = desc.trim().length > 0;

      items.push({
        objectId: obj.id!,
        name: itemData.name ?? "",
        hasImage,
        hasDescription,
        meta: { upc },
        categoryIds: catIds,
      });
    }

    cursor = result.cursor ?? undefined;
  } while (cursor);

  console.log(
    `[Square] ${items.length} game items found (${withUpc} with UPC, ${withoutUpc} name-only)`
  );
  return items;
}

// ---------------------------------------------------------------------------
// Upload image to a catalog item
// ---------------------------------------------------------------------------

/**
 * Download the image from `imageUrl` and attach it to the Square catalog
 * item identified by `catalogObjectId`.
 */
export async function uploadImageToSquareItem(
  catalogObjectId: string,
  imageUrl: string,
  imageName: string
): Promise<{ imageObjectId: string }> {
  const client = getSquareClient();

  // 1. Download the image bytes from BGG
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download image: ${imgRes.status} ${imgRes.statusText}`);
  }
  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 2. Build the multipart request
  //    Square's Node SDK requires a FileWrapper (from @apimatic/core)
  //    wrapping a Node Readable stream – a plain Blob won't carry auth.
  const readable = Readable.from(buffer);
  const file = new FileWrapper(readable, {
    contentType: "image/jpeg",
    filename: `${imageName.replace(/[^a-zA-Z0-9_-]/g, "_")}.jpg`,
  });

  const { result } = await client.catalogApi.createCatalogImage(
    {
      idempotencyKey: `bgg-sync-${catalogObjectId}-${Date.now()}`,
      objectId: catalogObjectId,
      image: {
        type: "IMAGE",
        id: "#temp_image",
        imageData: {
          name: imageName,
          caption: `Imported from BoardGameGeek`,
        },
      },
    },
    file
  );

  const imageObjectId = result.image?.id;
  if (!imageObjectId) throw new Error("Square did not return an image ID");

  return { imageObjectId };
}

// ---------------------------------------------------------------------------
// Update item description
// ---------------------------------------------------------------------------

/**
 * Update the description of a Square catalog item using HTML.
 *
 * Retrieves the current object first (to get `version`), then upserts
 * with the updated `descriptionHtml` field.
 */
export async function updateItemDescription(
  catalogObjectId: string,
  descriptionHtml: string
): Promise<void> {
  const client = getSquareClient();

  // 1. Retrieve the current catalog object (need its `version`)
  const { result: getResult } = await client.catalogApi.retrieveCatalogObject(
    catalogObjectId
  );
  const existing = getResult.object;
  if (!existing) {
    throw new Error(`[Square] Could not retrieve object ${catalogObjectId}`);
  }

  // 2. Upsert with updated description
  await client.catalogApi.upsertCatalogObject({
    idempotencyKey: `bgg-desc-${catalogObjectId}-${Date.now()}`,
    object: {
      type: "ITEM",
      id: catalogObjectId,
      version: existing.version,
      itemData: {
        ...existing.itemData,
        descriptionHtml,
      },
    },
  });
}

