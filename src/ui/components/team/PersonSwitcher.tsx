// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { switchActiveMember, teamMembers } from '@core/actions/team';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@core/domain/team';
import { teamStore } from '@core/stores/root';
import { Avatar } from '@ui/components/team/Avatar';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { Check } from 'lucide-react';

/**
 * Who's acting. In the demo this stands in for login: pick Robin and the whole
 * app — buttons, board drags, the assistant — behaves as A/P. Full-width rows,
 * one tap, because switching hats happens standing in a yard.
 */

export function PersonSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const activeId = useStore(teamStore, (state) => state.activeId);
  useStore(teamStore, (state) => state.members);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Who's using this?">
      <ul className="space-y-1">
        {teamMembers().map((member) => {
          const active = member.id === activeId;
          return (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => {
                  switchActiveMember(member.id);
                  onOpenChange(false);
                }}
                className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-surface-2"
              >
                <Avatar initials={member.initials} role={member.role} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[14px]">{member.name}</span>
                  <span className="block truncate text-[12px] text-text-muted">
                    {ROLE_LABELS[member.role]} · {ROLE_DESCRIPTIONS[member.role]}
                  </span>
                </span>
                {active ? (
                  <Check size={18} strokeWidth={2.5} style={{ color: 'var(--brand)' }} />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11.5px] leading-relaxed text-text-subtle">
        Acting as someone applies their permissions everywhere — the board, the buttons, and the
        assistant all follow the same rules.
      </p>
    </Sheet>
  );
}
