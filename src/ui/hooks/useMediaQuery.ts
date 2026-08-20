// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { useSyncExternalStore } from 'react';

/**
 * Reactive media query.
 *
 * Used to render exactly ONE board layout at a time. Tailwind's `hidden lg:grid`
 * approach keeps both in the DOM, which on this screen would double the node
 * count on a phone and — worse — register the mobile and desktop drop targets
 * under the same dnd-kit ids simultaneously, making drop resolution ambiguous.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false, // no SSR; assume mobile-first on the server snapshot
  );
}

/** Matches Tailwind's `lg` breakpoint, where the board becomes a kanban. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
