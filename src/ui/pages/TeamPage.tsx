// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  activeMember,
  addTeamMember,
  removeTeamMember,
  setMemberRole,
  teamMembers,
} from '@core/actions/team';
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type TeamMember,
  type TeamRole,
  can,
} from '@core/domain/team';
import { teamStore } from '@core/stores/root';
import { Avatar } from '@ui/components/team/Avatar';
import { PersonSwitcher } from '@ui/components/team/PersonSwitcher';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

/**
 * The team, under More.
 *
 * A contractor's company is a handful of people wearing specific hats, so the
 * screen is a list of faces with hats — not an admin console. Role changes and
 * removals are owner-only through the same actions the assistant would use,
 * so the refusals read identically everywhere.
 */

const ROLE_ORDER: TeamRole[] = ['owner', 'pm', 'ap', 'field'];

export function TeamPage() {
  useStore(teamStore, (state) => state);
  const [switching, setSwitching] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const acting = activeMember();
  const members = teamMembers();
  const canManage = acting ? can(acting.role, 'manage-team') : true;

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3600);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4 pb-24">
      {/* Who you are right now — the demo's stand-in for login. */}
      {acting ? (
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <div className="flex items-center gap-3">
            <Avatar initials={acting.initials} role={acting.role} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-[15px]">{acting.name}</p>
              <p className="truncate text-[12.5px] text-text-muted">
                {ROLE_LABELS[acting.role]} — {ROLE_DESCRIPTIONS[acting.role]}
              </p>
            </div>
          </div>
          <Button variant="outline" full className="mt-3" onClick={() => setSwitching(true)}>
            <ArrowLeftRight size={15} strokeWidth={2} />
            Switch person
          </Button>
        </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-semibold text-[15px]">Team</h2>
          <span className="text-[12px] text-text-subtle">
            {members.length} {members.length === 1 ? 'person' : 'people'}
          </span>
        </div>

        <ul className="divide-y divide-border rounded-[var(--radius-card)] border border-border bg-surface">
          {members.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => canManage && setEditing(member)}
                className={cn(
                  'flex min-h-16 w-full items-center gap-3 px-3 text-left',
                  canManage && 'transition-colors hover:bg-surface-2',
                )}
              >
                <Avatar initials={member.initials} role={member.role} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-[14px]">{member.name}</span>
                    {member.id === acting?.id ? (
                      <span className="rounded-full bg-brand-tint px-2 py-0.5 font-medium text-[10.5px] text-brand">
                        you
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[12px] text-text-muted">
                    {ROLE_LABELS[member.role]}
                    {member.email ? ` · ${member.email}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {canManage ? (
          <Button variant="secondary" full className="mt-2" onClick={() => setAdding(true)}>
            <Plus size={15} strokeWidth={2.5} />
            Add a teammate
          </Button>
        ) : (
          <p className="mt-2 text-[12px] text-text-subtle">
            Only an owner can add people or change roles.
          </p>
        )}
      </section>

      {/* What the hats mean — the legend that makes the roles self-explaining. */}
      <section className="rounded-[var(--radius-card)] border border-border bg-surface-inset p-4">
        <h3 className="mb-2 font-medium text-[13px]">What each role can do</h3>
        <ul className="space-y-2">
          {ROLE_ORDER.map((role) => (
            <li key={role} className="flex gap-2.5 text-[12.5px] leading-snug">
              <Avatar initials={ROLE_LABELS[role][0] ?? '?'} role={role} size="sm" />
              <span>
                <span className="font-medium">{ROLE_LABELS[role]}.</span>{' '}
                <span className="text-text-muted">{ROLE_DESCRIPTIONS[role]}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <PersonSwitcher open={switching} onOpenChange={setSwitching} />
      <EditMemberSheet member={editing} onClose={() => setEditing(null)} onFlash={flash} />
      <AddMemberSheet open={adding} onOpenChange={setAdding} onFlash={flash} />

      {toast ? (
        <div className="fixed inset-x-4 bottom-20 z-40 rounded-lg bg-text px-4 py-3 text-center text-[13px] text-surface shadow-[var(--shadow-lifted)] lg:left-auto lg:w-96">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function EditMemberSheet({
  member,
  onClose,
  onFlash,
}: {
  member: TeamMember | null;
  onClose: () => void;
  onFlash: (message: string) => void;
}) {
  return (
    <Sheet
      open={member !== null}
      onOpenChange={(next) => !next && onClose()}
      title={member?.name ?? ''}
      description="Change what they can do, or remove them."
    >
      {member ? (
        <div className="space-y-2">
          {ROLE_ORDER.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => {
                const result = setMemberRole(member.id, role);
                if (!result.ok) onFlash(result.error);
                else onClose();
              }}
              className={cn(
                'flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors',
                member.role === role
                  ? 'border-brand bg-brand-tint'
                  : 'border-border hover:bg-surface-2',
              )}
            >
              <Avatar initials={ROLE_LABELS[role][0] ?? '?'} role={role} size="sm" />
              <span className="min-w-0">
                <span className="block font-medium text-[13.5px]">{ROLE_LABELS[role]}</span>
                <span className="block text-[11.5px] leading-snug text-text-muted">
                  {ROLE_DESCRIPTIONS[role]}
                </span>
              </span>
            </button>
          ))}

          <Button
            variant="outline"
            full
            className="mt-2 text-danger"
            onClick={() => {
              const result = removeTeamMember(member.id);
              onFlash(result.ok ? `${member.name} removed` : result.error);
              if (result.ok) onClose();
            }}
          >
            <Trash2 size={15} strokeWidth={2} />
            Remove from team
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}

function AddMemberSheet({
  open,
  onOpenChange,
  onFlash,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFlash: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<TeamRole>('pm');

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add a teammate"
      description="They show up in the switcher with the permissions of their role."
      footer={
        <Button
          full
          size="lg"
          onClick={() => {
            const result = addTeamMember({ name, role });
            if (!result.ok) {
              onFlash(result.error);
              return;
            }
            onFlash(`${result.value.name} added as ${ROLE_LABELS[role]}`);
            setName('');
            setRole('pm');
            onOpenChange(false);
          }}
        >
          Add to team
        </Button>
      }
    >
      <label className="block">
        <span className="mb-1 block font-medium text-[13px]">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Sam Ortiz"
          className="min-h-12 w-full rounded-lg border border-border bg-surface px-3 text-[15px] outline-none focus:border-brand"
        />
      </label>

      <p className="mt-4 mb-1 font-medium text-[13px]">Role</p>
      <div className="space-y-2">
        {ROLE_ORDER.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setRole(candidate)}
            className={cn(
              'flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors',
              role === candidate
                ? 'border-brand bg-brand-tint'
                : 'border-border hover:bg-surface-2',
            )}
          >
            <Avatar initials={ROLE_LABELS[candidate][0] ?? '?'} role={candidate} size="sm" />
            <span className="min-w-0">
              <span className="block font-medium text-[13.5px]">{ROLE_LABELS[candidate]}</span>
              <span className="block text-[11.5px] leading-snug text-text-muted">
                {ROLE_DESCRIPTIONS[candidate]}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
