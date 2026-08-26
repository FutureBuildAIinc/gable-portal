// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEASE_TTL_MS,
  releaseLeadership,
  renewLeadership,
  tryAcquireLeadership,
} from '../persistence';

/**
 * The cross-tab leadership lease, which had no tests at all.
 *
 * Its one job is stated in `persistence.ts`: exactly one tab pumps the
 * simulator. It exists because two tabs each running their own scheduler over
 * one persisted queue fired every piece of supplier work twice and clobbered
 * each other's writes per key — including a signed QuoteAcceptance.
 *
 * The hole these tests close: the heartbeat used to write the lease
 * UNCONDITIONALLY. A background tab is throttled by the browser to roughly one
 * timer tick a minute, so its 2.5s heartbeat sails past the 7s TTL, a
 * foreground tab correctly takes over — and then the sleeping tab's late tick
 * wrote its own id back over the lease. Neither tab knew it had lost, both kept
 * their scheduler running, and the exact failure the lease was added to prevent
 * came back through the most ordinary user action there is.
 */

const LEADER_KEY = 'gn:leader';

function currentLeader(): string | undefined {
  const raw = localStorage.getItem(LEADER_KEY);
  return raw ? (JSON.parse(raw) as { tabId: string }).tabId : undefined;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-26T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('acquiring the lease', () => {
  it('grants it to the first tab and refuses the second', () => {
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    expect(tryAcquireLeadership('tab-b')).toBe(false);
    expect(currentLeader()).toBe('tab-a');
  });

  it('lets the holder re-acquire its own lease', () => {
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    expect(tryAcquireLeadership('tab-a')).toBe(true);
  });

  it('hands the lease over once the holder has gone quiet for the TTL', () => {
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    vi.advanceTimersByTime(LEASE_TTL_MS + 1);
    expect(tryAcquireLeadership('tab-b')).toBe(true);
    expect(currentLeader()).toBe('tab-b');
  });

  it('releases only its own lease, never someone else’s', () => {
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    releaseLeadership('tab-b');
    expect(currentLeader()).toBe('tab-a');
    releaseLeadership('tab-a');
    expect(currentLeader()).toBeUndefined();
  });
});

describe('renewing the lease', () => {
  it('keeps the lease alive for the holder', () => {
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    vi.advanceTimersByTime(2_500);
    expect(renewLeadership('tab-a')).toBe(true);
    // Renewal has to move the timestamp forward, or the lease still lapses.
    vi.advanceTimersByTime(LEASE_TTL_MS - 1);
    expect(tryAcquireLeadership('tab-b')).toBe(false);
  });

  it('does not let a lapsed leader steal the lease back', () => {
    // tab-a leads, then is backgrounded and throttled past the TTL.
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    vi.advanceTimersByTime(LEASE_TTL_MS + 1_000);

    // tab-b legitimately takes over.
    expect(tryAcquireLeadership('tab-b')).toBe(true);
    expect(currentLeader()).toBe('tab-b');

    // tab-a's throttled heartbeat finally fires. It must report the loss and
    // leave the lease alone — otherwise both tabs pump the simulator.
    expect(renewLeadership('tab-a')).toBe(false);
    expect(currentLeader()).toBe('tab-b');

    // And it must keep reporting the loss, not flip back on the next tick.
    vi.advanceTimersByTime(2_500);
    expect(renewLeadership('tab-a')).toBe(false);
    expect(currentLeader()).toBe('tab-b');
  });

  it('lets a lapsed leader take the lease back when nobody else claimed it', () => {
    // The other half: standing down must not mean standing down forever. If no
    // tab took over, the woken tab is still the only candidate.
    expect(tryAcquireLeadership('tab-a')).toBe(true);
    vi.advanceTimersByTime(LEASE_TTL_MS + 1_000);
    expect(renewLeadership('tab-a')).toBe(true);
    expect(currentLeader()).toBe('tab-a');
  });
});
