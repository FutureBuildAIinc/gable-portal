// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Seeded PRNG so demos replay identically. Everything stochastic in the sim
 * (special-order price jitter, delivery flavor text, offline invoice contents)
 * draws from here, never Math.random.
 *
 * Sub-streams are keyed by entity id, so a value doesn't shift just because
 * another entity was created first.
 */

export interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Jitter a value by +/- percent, e.g. jitter(1000, 15) => 850..1150 */
  jitter(value: number, percent: number): number;
}

/** mulberry32 — small, fast, good enough for demo variation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int(minInclusive, maxInclusive) {
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick() needs a non-empty array');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    jitter(value, percent) {
      const delta = value * (percent / 100);
      return value - delta + next() * delta * 2;
    },
  };
}

/**
 * Deterministic sub-stream for one entity. Same (seed, key) always yields the
 * same sequence regardless of call order elsewhere.
 */
export function rngFor(seed: number, key: string): Rng {
  return createRng((seed ^ hashString(key)) >>> 0);
}

export function randomSeed(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] as number;
}
