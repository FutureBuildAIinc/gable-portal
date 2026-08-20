// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import type { IsoDateTime } from '../lib/time';

/**
 * The record of what happened, and the only notification channel.
 *
 * `actor` is what makes it useful: 'system' entries are the supplier moving
 * without you — a quote coming back, a truck dispatching — and those are
 * exactly the ones worth a badge. 'assistant' entries (M8) let a contractor
 * audit anything the AI did on their behalf.
 */

export type Actor = 'user' | 'assistant' | 'system';

export interface ActivityEntry {
  id: EntityId;
  at: IsoDateTime;
  actor: Actor;
  kind: string;
  /** Written for a contractor to read, not for a log. */
  message: string;
  orderId?: EntityId;
  projectId?: EntityId;
}

export interface ActivityState {
  entries: ActivityEntry[];
  /** Everything after this timestamp counts as unread. */
  readWatermark: IsoDateTime;
}

/** Bounded so a long demo at 600x can't grow state without limit. */
export const MAX_ACTIVITY_ENTRIES = 400;

export function unreadCount(state: ActivityState): number {
  return state.entries.filter((entry) => entry.actor === 'system' && entry.at > state.readWatermark)
    .length;
}
