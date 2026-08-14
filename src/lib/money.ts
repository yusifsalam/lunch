// Prices are stored as integer cents — no floating point money.

const MAX_CENTS = 100_000; // €1000: nobody's lunch costs more

/** "12.50", "12,50", "12" → 1250 | 1250 | 1200. Null when unparseable or out of range. */
export function parsePriceCents(input: string): number | null {
  const normalized = input.trim().replace(",", ".").replace(/€|\s/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  if (cents <= 0 || cents > MAX_CENTS) return null;
  return cents;
}

export function formatPrice(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}
