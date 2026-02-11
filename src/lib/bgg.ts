/**
 * BoardGameGeek (BGG) XML API2 client
 *
 * Endpoints used:
 *   Search:  https://boardgamegeek.com/xmlapi2/search?query=NAME&type=boardgame
 *   Thing:   https://boardgamegeek.com/xmlapi2/thing?id=ID
 *
 * Rate-limiting: BGG returns 429 when you hit too many requests.
 * We implement exponential back-off with jitter.
 */

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BggSearchResult {
  bggId: number;
  name: string;
  yearPublished: number | null;
}

export interface BggThingDetail {
  bggId: number;
  name: string;
  yearPublished: number | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  publishers: string[];
}

// ---------------------------------------------------------------------------
// XML Parser (shared instance)
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Ensure arrays for items that can repeat
  isArray: (name) => ["item", "name", "link"].includes(name),
});

// ---------------------------------------------------------------------------
// Back-off fetch wrapper
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 2_000;
const MAX_RETRIES = 6;

/**
 * Fetch a URL with exponential back-off on 429 / 5xx responses.
 * Adds a small base delay between every request to be kind to BGG.
 */
async function fetchWithBackoff(
  url: string,
  attempt = 0
): Promise<string> {
  // Small courtesy delay on every call (even the first)
  await sleep(800 + Math.random() * 400);

  const res = await fetch(url);

  if (res.ok) {
    return res.text();
  }

  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 1_000;
    console.warn(
      `[BGG] ${res.status} on ${url} – retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
    );
    await sleep(delay);
    return fetchWithBackoff(url, attempt + 1);
  }

  throw new Error(`[BGG] Request failed: ${res.status} ${res.statusText} – ${url}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search BGG for board games matching `query`.
 * Returns an array of lightweight search results.
 */
export async function searchBgg(query: string): Promise<BggSearchResult[]> {
  const encoded = encodeURIComponent(query.trim());
  const url = `https://boardgamegeek.com/xmlapi2/search?query=${encoded}&type=boardgame`;
  const xml = await fetchWithBackoff(url);
  const data = parser.parse(xml);

  const items = data?.items?.item;
  if (!items || !Array.isArray(items)) return [];

  return items.map((item: any) => {
    // The name can be an array; pick the primary one
    const names: any[] = Array.isArray(item.name) ? item.name : [item.name];
    const primary = names.find((n: any) => n?.["@_type"] === "primary") ?? names[0];

    return {
      bggId: Number(item["@_id"]),
      name: primary?.["@_value"] ?? "",
      yearPublished: item.yearpublished?.["@_value"]
        ? Number(item.yearpublished["@_value"])
        : null,
    } satisfies BggSearchResult;
  });
}

// ---------------------------------------------------------------------------
// Thing detail (image + publishers)
// ---------------------------------------------------------------------------

/**
 * Fetch full details for a single BGG thing (board game).
 */
export async function fetchBggThing(bggId: number): Promise<BggThingDetail | null> {
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${bggId}`;
  const xml = await fetchWithBackoff(url);
  const data = parser.parse(xml);

  const item = data?.items?.item?.[0] ?? data?.items?.item;
  if (!item) return null;

  const names: any[] = Array.isArray(item.name) ? item.name : [item.name];
  const primary = names.find((n: any) => n?.["@_type"] === "primary") ?? names[0];

  const links: any[] = Array.isArray(item.link) ? item.link : item.link ? [item.link] : [];
  const publishers = links
    .filter((l: any) => l["@_type"] === "boardgamepublisher")
    .map((l: any) => l["@_value"] as string);

  return {
    bggId,
    name: primary?.["@_value"] ?? "",
    yearPublished: item.yearpublished?.["@_value"]
      ? Number(item.yearpublished["@_value"])
      : null,
    imageUrl: item.image ?? null,
    thumbnailUrl: item.thumbnail ?? null,
    publishers,
  };
}

// ---------------------------------------------------------------------------
// Smart matcher
// ---------------------------------------------------------------------------

/**
 * Given a product name (and optional year / publisher from Square metadata),
 * search BGG and return the best-matching thing detail, or null.
 */
export async function findBestMatch(
  productName: string,
  hints?: { year?: number; publisher?: string; upc?: string }
): Promise<BggThingDetail | null> {
  // 1. Search by name
  const results = await searchBgg(productName);
  if (results.length === 0) return null;

  // 2. Score each result
  type Scored = BggSearchResult & { score: number };
  const scored: Scored[] = results.map((r) => {
    let score = 0;

    // Exact-ish name match (case-insensitive)
    if (r.name.toLowerCase() === productName.toLowerCase()) {
      score += 10;
    } else if (r.name.toLowerCase().includes(productName.toLowerCase())) {
      score += 5;
    }

    // Year match
    if (hints?.year && r.yearPublished === hints.year) {
      score += 8;
    }

    return { ...r, score };
  });

  // Sort descending by score, then prefer lower BGG id (older = more canonical)
  scored.sort((a, b) => b.score - a.score || a.bggId - b.bggId);

  // 3. Fetch full details for top candidate(s) and verify publisher if we have a hint
  for (const candidate of scored.slice(0, 3)) {
    const detail = await fetchBggThing(candidate.bggId);
    if (!detail || !detail.imageUrl) continue;

    // If publisher hint, check it
    if (hints?.publisher) {
      const pubLower = hints.publisher.toLowerCase();
      const pubMatch = detail.publishers.some((p) =>
        p.toLowerCase().includes(pubLower)
      );
      if (!pubMatch) continue; // skip – publisher mismatch
    }

    return detail;
  }

  // Fallback: return the first result that has an image, skipping publisher check
  for (const candidate of scored.slice(0, 5)) {
    const detail = await fetchBggThing(candidate.bggId);
    if (detail?.imageUrl) return detail;
  }

  return null;
}

