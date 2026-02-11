/**
 * Square SDK helpers
 *
 * Required env vars:
 *   SQUARE_ACCESS_TOKEN   – your Square OAuth / personal access token
 *   SQUARE_ENVIRONMENT    – "sandbox" | "production"
 *
 * Optional env var:
 *   EXCLUDE_CATEGORY_IDS  – comma-separated category IDs to skip (e.g. Drinks, Shirts)
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
// List all catalog items (paginated)
// ---------------------------------------------------------------------------

/**
 * Retrieve every ITEM object from the Square catalog, automatically
 * paginating through the full list.  Items whose category matches
 * an excluded ID are filtered out.
 */
export async function listCatalogItems(): Promise<SquareCatalogItem[]> {
  const client = getSquareClient();
  const excludeIds = (process.env.EXCLUDE_CATEGORY_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const items: SquareCatalogItem[] = [];
  let cursor: string | undefined;

  do {
    const { result } = await client.catalogApi.listCatalog(
      cursor,
      "ITEM"
    );

    for (const obj of result.objects ?? []) {
      const itemData = obj.itemData;
      if (!itemData) continue;

      // Filter by excluded categories
      const catIds = (itemData.categoryId ? [itemData.categoryId] : []) as string[];

      // Also check reportingCategory and categories array (newer SDK)
      if ((itemData as any).categories) {
        for (const c of (itemData as any).categories) {
          if (c.id) catIds.push(c.id);
        }
      }

      // Check category name-based exclusion (fallback: skip items whose
      // name contains "Drink" or "Shirt" if no EXCLUDE_CATEGORY_IDS set)
      const nameLower = (itemData.name ?? "").toLowerCase();
      if (excludeIds.length === 0) {
        if (
          nameLower.includes("drink") ||
          nameLower.includes("shirt")
        ) {
          continue;
        }
      } else {
        if (catIds.some((id) => excludeIds.includes(id))) continue;
      }

      // Check for existing images
      const hasImage =
        (obj.itemData?.imageIds?.length ?? 0) > 0;

      // Extract useful metadata from custom attribute values or description
      const meta: SquareCatalogItem["meta"] = {};

      // Try to find UPC in variations
      for (const variation of itemData.variations ?? []) {
        const upc = variation.itemVariationData?.upc;
        if (upc) {
          meta.upc = upc;
          break;
        }
      }

      items.push({
        objectId: obj.id!,
        name: itemData.name ?? "",
        hasImage,
        meta,
        categoryIds: catIds,
      });
    }

    cursor = result.cursor ?? undefined;
  } while (cursor);

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

