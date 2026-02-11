/**
 * UPC Barcode Lookup
 *
 * Uses UPCitemdb.com free trial API to resolve a UPC/EAN barcode
 * to a full product title. No API key required (rate-limited to
 * 100 lookups/day on the trial endpoint).
 *
 * Endpoint: https://api.upcitemdb.com/prod/trial/lookup?upc=BARCODE
 */

export interface UpcLookupResult {
  title: string;
  brand: string | null;
  description: string | null;
}

/**
 * Look up a UPC/EAN barcode and return the product title.
 * Returns null if the barcode is not found or the service is unavailable.
 */
export async function lookupUpc(upc: string): Promise<UpcLookupResult | null> {
  try {
    const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc.trim())}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.warn(`[UPC] Lookup failed for ${upc}: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    const items = data?.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      console.warn(`[UPC] No results for barcode ${upc}`);
      return null;
    }

    const item = items[0];
    return {
      title: item.title ?? "",
      brand: item.brand ?? null,
      description: item.description ?? null,
    };
  } catch (err: any) {
    console.warn(`[UPC] Error looking up ${upc}: ${err.message}`);
    return null;
  }
}

