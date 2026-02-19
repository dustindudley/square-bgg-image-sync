/**
 * Debug endpoint — shows exactly how Square catalog items are being
 * filtered so we can tune the category / UPC logic.
 *
 * GET /api/debug-catalog
 */

import { NextResponse } from "next/server";
import { Client, Environment } from "square";

function getSquareClient(): Client {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) throw new Error("Missing SQUARE_ACCESS_TOKEN env var");

  const env =
    process.env.SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox;

  return new Client({ accessToken, environment: env });
}

const GAME_CATEGORY_KEYWORDS = [
  "board game",
  "card game",
  "board games",
  "card games",
  "tabletop",
  "table top",
  "games",
];

export async function GET() {
  try {
    const client = getSquareClient();

    // -----------------------------------------------------------------------
    // 1. Fetch ALL categories
    // -----------------------------------------------------------------------
    const allCategories: { id: string; name: string; isGame: boolean }[] = [];
    let cursor: string | undefined;

    do {
      const { result } = await client.catalogApi.listCatalog(cursor, "CATEGORY");
      for (const obj of result.objects ?? []) {
        const name = obj.categoryData?.name ?? "(unnamed)";
        const nameLower = name.toLowerCase();
        const isGame = GAME_CATEGORY_KEYWORDS.some((kw) => nameLower.includes(kw));
        allCategories.push({ id: obj.id!, name, isGame });
      }
      cursor = result.cursor ?? undefined;
    } while (cursor);

    const gameCatIds = new Set(allCategories.filter((c) => c.isGame).map((c) => c.id));

    // -----------------------------------------------------------------------
    // 2. Fetch ALL items and classify them
    // -----------------------------------------------------------------------
    let totalItems = 0;
    let itemsWithNoCategory = 0;
    let itemsInGameCategory = 0;
    let itemsNotInGameCategory = 0;
    let gameItemsWithUpc = 0;
    let gameItemsWithoutUpc = 0;
    let gameItemsAlreadyHaveImage = 0;

    const skippedNoCategory: string[] = [];   // first 20
    const skippedNonGame: string[] = [];       // first 20
    const skippedNoUpc: string[] = [];         // first 20
    const includedItems: string[] = [];        // first 30

    cursor = undefined;
    do {
      const { result } = await client.catalogApi.listCatalog(cursor, "ITEM");

      for (const obj of result.objects ?? []) {
        const itemData = obj.itemData;
        if (!itemData) continue;
        totalItems++;

        const name = itemData.name ?? "(unnamed)";

        // Collect category IDs
        const catIds: string[] = [];
        if (itemData.categoryId) catIds.push(itemData.categoryId);
        if ((itemData as any).categories) {
          for (const c of (itemData as any).categories) {
            if (c.id) catIds.push(c.id);
          }
        }

        if (catIds.length === 0) {
          itemsWithNoCategory++;
          if (skippedNoCategory.length < 20) skippedNoCategory.push(name);
          continue;
        }

        const isGame = catIds.some((id) => gameCatIds.has(id));
        if (!isGame) {
          itemsNotInGameCategory++;
          if (skippedNonGame.length < 20) {
            const catNames = catIds
              .map((id) => allCategories.find((c) => c.id === id)?.name ?? id)
              .join(", ");
            skippedNonGame.push(`${name} [categories: ${catNames}]`);
          }
          continue;
        }

        itemsInGameCategory++;

        // Check for UPC
        let upc: string | undefined;
        for (const variation of itemData.variations ?? []) {
          const varUpc = variation.itemVariationData?.upc;
          if (varUpc) {
            upc = varUpc;
            break;
          }
        }

        if (upc) {
          gameItemsWithUpc++;
          const hasImage = (obj.itemData?.imageIds?.length ?? 0) > 0;
          if (hasImage) gameItemsAlreadyHaveImage++;
          if (includedItems.length < 30) {
            includedItems.push(`${name} (UPC: ${upc})${hasImage ? " [HAS IMAGE]" : ""}`);
          }
        } else {
          gameItemsWithoutUpc++;
          if (skippedNoUpc.length < 20) skippedNoUpc.push(name);
        }
      }

      cursor = result.cursor ?? undefined;
    } while (cursor);

    return NextResponse.json({
      summary: {
        totalItems,
        totalCategories: allCategories.length,
        gameCategoriesFound: allCategories.filter((c) => c.isGame).length,
        itemsWithNoCategory,
        itemsInGameCategory,
        itemsNotInGameCategory,
        gameItemsWithUpc,
        gameItemsWithoutUpc,
        gameItemsAlreadyHaveImage,
        wouldProcess: gameItemsWithUpc - gameItemsAlreadyHaveImage,
      },
      allCategories,
      samples: {
        skippedNoCategory: skippedNoCategory.length > 0 ? skippedNoCategory : "(none)",
        skippedNonGame: skippedNonGame.length > 0 ? skippedNonGame : "(none)",
        skippedNoUpc: skippedNoUpc.length > 0 ? skippedNoUpc : "(none)",
        includedItems: includedItems.length > 0 ? includedItems : "(none)",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

