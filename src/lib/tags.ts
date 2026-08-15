/** "Terrace, quick,vegan-friendly" (as typed in a form) → clean tag list:
 * trimmed, lowercased, deduplicated, empties dropped. */
export function parseTagsInput(input: string): string[] {
  const tags = input
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  return [...new Set(tags)];
}

/** The place.tags column (JSON text) → tag list. Tolerates bad data. */
export function parseTagsJson(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}
