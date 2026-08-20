// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Prefixed ids: readable in DevTools and in AI tool payloads ("job_x7f2a1"
 * tells you what it is; a bare uuid doesn't). Not cryptographically strong —
 * these name local demo entities, they don't guard anything.
 *
 * Share tokens are the exception and use crypto.getRandomValues.
 */

export type EntityId = string;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

export function newId(prefix: string): EntityId {
  return `${prefix}_${randomSuffix(6)}`;
}

/** Longer and unguessable — customer quote links are the only public surface. */
export function newShareToken(): string {
  return randomSuffix(24);
}

/**
 * Human-facing sequential numbers (Q-1001, SO-5001, INV-9001). The caller owns
 * the counter so numbering stays stable across a seeded demo replay.
 */
export function formatSequence(prefix: string, n: number): string {
  return `${prefix}-${n}`;
}
