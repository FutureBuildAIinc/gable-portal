// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * The GableNow mark: a gable roof over a stack of boards.
 *
 * It has to survive being 20px in a header on a phone in daylight, so it is
 * three strokes and nothing else — no gradient, no enclosing shape, no
 * lettering inside. The stack widens toward the base so the silhouette reads
 * as a pile of lumber under a roofline rather than as a generic house icon,
 * which is what a plain pentagon would have been.
 *
 * Drawn in `currentColor` so it inherits whatever it sits on: the dealer's
 * brand on a light surface, and the on-brand ink when it sits on a filled one.
 * The dealer's colour is configurable, so the mark must never hardcode it.
 */
export function GableMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* the gable */}
      <path d="M3.2 11.4 L12 4.2 L20.8 11.4" />
      {/* the stack, widening toward the ground */}
      <path d="M7.4 15.6 H16.6" />
      <path d="M5.2 19.6 H18.8" />
    </svg>
  );
}

/**
 * Mark plus name. The name is set tight and semibold because it is read at a
 * glance in a sidebar, not admired.
 */
export function Wordmark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span className={className}>
      <span className="flex items-center gap-2">
        <GableMark size={size} className="shrink-0 text-brand" />
        <span className="font-semibold text-[15px] tracking-tight">GableNow</span>
      </span>
    </span>
  );
}
