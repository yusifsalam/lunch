export interface Coords {
  lat: number;
  lng: number;
}

/** "60.1699, 24.9384" (as copied from a maps app) → coords. Null when invalid. */
export function parseCoords(input: string): Coords | null {
  const m = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
