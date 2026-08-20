// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { type IsoDateTime, toIso } from '../lib/time';

/**
 * Sim time. Nothing in core reads the wall clock directly — everything asks
 * the clock — so a demo can run at 600x, jump a day forward, and survive a
 * reload with orders having progressed "while you were away".
 *
 * M2 uses it only to stamp created/updated timestamps. M4 adds the scheduler
 * that drives quote-desk replies and delivery progression off the same clock.
 */

export interface SimClock {
  now(): number;
  nowIso(): IsoDateTime;
  speed(): number;
  setSpeed(multiplier: number): void;
  /** Jump forward — "skip to tomorrow" in the demo controls. */
  advance(ms: number): void;
  snapshot(): ClockAnchor;
  /** Adopt another tab's persisted anchor so both tabs read the same sim time. */
  restore(anchor: ClockAnchor): void;
}

/**
 * Persisted so sim time keeps moving across reloads instead of resetting to
 * the moment the tab opened.
 */
export interface ClockAnchor {
  anchorSim: number;
  anchorReal: number;
  speed: number;
}

export function createClock(anchor?: ClockAnchor): SimClock {
  let state: ClockAnchor = anchor ?? {
    anchorSim: Date.now(),
    anchorReal: Date.now(),
    speed: 1,
  };

  function now(): number {
    return state.anchorSim + (Date.now() - state.anchorReal) * state.speed;
  }

  /** Re-anchor so a speed or offset change doesn't retroactively move history. */
  function reanchor(nextSpeed: number, offsetMs = 0): void {
    state = {
      anchorSim: now() + offsetMs,
      anchorReal: Date.now(),
      speed: nextSpeed,
    };
  }

  return {
    now,
    nowIso: () => toIso(now()),
    speed: () => state.speed,
    setSpeed: (multiplier) => reanchor(multiplier),
    advance: (ms) => reanchor(state.speed, ms),
    snapshot: () => ({ ...state }),
    restore: (next) => {
      state = { ...next };
    },
  };
}
