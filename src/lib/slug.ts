import { randomInt } from "node:crypto";

import type { Rng } from "./lunch";

// Readable but not guessable: two words narrow nothing down (the lists are
// public), the 4-char suffix over a 31-char alphabet carries the entropy —
// ~30 bits total, plenty for an internal tool that is also passcode-gated.
const ADJECTIVES = [
  "brave",
  "crispy",
  "curious",
  "dapper",
  "eager",
  "fluffy",
  "gentle",
  "glossy",
  "golden",
  "hungry",
  "jolly",
  "lucky",
  "mellow",
  "nimble",
  "peppy",
  "plucky",
  "quirky",
  "rustic",
  "salty",
  "savory",
  "smoky",
  "snappy",
  "spicy",
  "sunny",
  "tangy",
  "toasty",
  "witty",
  "zesty",
];

const NOUNS = [
  "bagel",
  "burrito",
  "falafel",
  "gnocchi",
  "gyoza",
  "kebab",
  "noodle",
  "nugget",
  "olive",
  "omelet",
  "pickle",
  "pierogi",
  "pretzel",
  "ramen",
  "risotto",
  "samosa",
  "schnitzel",
  "scone",
  "taco",
  "tapas",
  "toastie",
  "waffle",
];

// No 0/1/i/l/o — nothing to misread over the shoulder or mistype from a shout.
const SUFFIX_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SUFFIX_LENGTH = 4;

const cryptoRng: Rng = () => randomInt(2 ** 31) / 2 ** 31;

/**
 * Deterministic slug from a display name: "Café Motörhead & Co." → "cafe-motorhead-co".
 * Uniqueness is the caller's job (see uniquePlaceSlug in lunchService).
 */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "place";
}

/** e.g. "zesty-taco-7k2m". Pass an rng only for deterministic tests. */
export function generateSlug(rng: Rng = cryptoRng): string {
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rng() * arr.length)]!;
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += pick(SUFFIX_ALPHABET.split(""));
  }
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}
