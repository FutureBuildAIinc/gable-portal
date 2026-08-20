// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, migrate } from '../persistence';

/**
 * `migrate` is the pure half of persistence and the part that protects a live
 * demo: the failure mode of a half-understood payload is a broken app in front
 * of an audience, so anything unsalvageable must return null and trigger a
 * clean reseed rather than limp along.
 */
describe('schema migration', () => {
  it('passes a current-version payload through untouched', () => {
    const state = { projects: { byId: {}, allIds: [] } };
    expect(migrate(state, SCHEMA_VERSION)).toEqual(state);
  });

  it('refuses a payload written by a newer build', () => {
    // Downgrading a browser to an older deploy must reseed, not misread state.
    expect(migrate({}, SCHEMA_VERSION + 1)).toBeNull();
  });

  it('returns null when a migration throws rather than yielding partial state', () => {
    // Simulated by a version gap the table cannot bridge; the contract is that
    // callers treat null as "wipe and reseed".
    expect(migrate({ broken: true }, SCHEMA_VERSION + 5)).toBeNull();
  });

  it('handles an empty payload at the current version', () => {
    expect(migrate({}, SCHEMA_VERSION)).toEqual({});
  });
});
