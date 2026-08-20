// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import {
  CAPABILITY_VERBS,
  type Capability,
  ROLE_LABELS,
  type TeamMember,
  type TeamRole,
  can,
  initialsFor,
} from '../domain/team';
import { newId } from '../lib/ids';
import { type Result, err, ok } from '../lib/result';
import { teamStore } from '../stores/root';
import { listOf } from '../stores/store';

/**
 * The team, and the permission gate every other action calls.
 *
 * `requireCapability` lives here because the actions layer is the single
 * mutation path: gating it once gates the buttons, the board drag, and the AI
 * assistant identically — and the refusal sentence NAMES who can do the thing,
 * because "not allowed" teaches nothing and "ask Robin" solves the problem.
 */

export function teamMembers(): TeamMember[] {
  return listOf(teamStore.get().members);
}

export function activeMember(): TeamMember | undefined {
  const state = teamStore.get();
  return state.activeId ? state.members.byId[state.activeId] : undefined;
}

function membersWho(capability: Capability): TeamMember[] {
  return teamMembers().filter((member) => can(member.role, capability));
}

function nameList(members: TeamMember[]): string {
  const names = members.map((member) => member.name);
  if (names.length <= 1) return names[0] ?? 'the owner';
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

/**
 * The gate. Returns the acting member, or the sentence the UI shows and the
 * AI receives verbatim. With no team seeded (old tests, fresh core embeds)
 * everything is allowed — the gate exists once people exist.
 */
export function requireCapability(capability: Capability): Result<TeamMember | undefined> {
  const acting = activeMember();
  if (!acting) return ok(undefined);
  if (can(acting.role, capability)) return ok(acting);

  const able = membersWho(capability);
  return err(
    `Only ${nameList(able)} can ${CAPABILITY_VERBS[capability]} — you're in as ${acting.name} (${ROLE_LABELS[acting.role]}).`,
  );
}

export interface AddTeamMemberInput {
  name: string;
  role: TeamRole;
  email?: string;
}

export function addTeamMember(input: AddTeamMemberInput): Result<TeamMember> {
  const gate = requireCapability('manage-team');
  if (!gate.ok) return gate;

  const name = input.name.trim();
  if (name.length < 2) return err('Give this person a name.');
  if (teamMembers().some((member) => member.name.toLowerCase() === name.toLowerCase())) {
    return err(`${name} is already on the team.`);
  }

  const member: TeamMember = {
    id: newId('tm'),
    name,
    role: input.role,
    ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    initials: initialsFor(name),
    createdAt: getContext().clock.nowIso(),
  };

  const state = teamStore.get();
  teamStore.set({
    ...state,
    members: {
      byId: { ...state.members.byId, [member.id]: member },
      allIds: [...state.members.allIds, member.id],
    },
  });
  return ok(member);
}

export function setMemberRole(memberId: string, role: TeamRole): Result<TeamMember> {
  const gate = requireCapability('manage-team');
  if (!gate.ok) return gate;

  const state = teamStore.get();
  const member = state.members.byId[memberId];
  if (!member) return err('That person is no longer on the team.');

  // The company must always have an owner, or nobody can manage anything.
  if (member.role === 'owner' && role !== 'owner') {
    const owners = teamMembers().filter((entry) => entry.role === 'owner');
    if (owners.length === 1) {
      return err(`${member.name} is the only owner — make someone else an owner first.`);
    }
  }

  const updated = { ...member, role };
  teamStore.set({
    ...state,
    members: { ...state.members, byId: { ...state.members.byId, [memberId]: updated } },
  });
  return ok(updated);
}

export function removeTeamMember(memberId: string): Result<TeamMember> {
  const gate = requireCapability('manage-team');
  if (!gate.ok) return gate;

  const state = teamStore.get();
  const member = state.members.byId[memberId];
  if (!member) return err('That person is no longer on the team.');

  if (member.role === 'owner') {
    const owners = teamMembers().filter((entry) => entry.role === 'owner');
    if (owners.length === 1) return err(`${member.name} is the only owner and can't be removed.`);
  }
  if (state.activeId === memberId) {
    return err(`You're currently acting as ${member.name} — switch people first.`);
  }

  const { [memberId]: _, ...rest } = state.members.byId;
  teamStore.set({
    ...state,
    members: { byId: rest, allIds: state.members.allIds.filter((id) => id !== memberId) },
  });
  return ok(member);
}

/**
 * Who is acting. Ungated by design: in this demo there is no login, so the
 * switcher IS the authentication story — it exists to show role gating, not to
 * enforce it against a hostile user.
 */
export function switchActiveMember(memberId: string): Result<TeamMember> {
  const state = teamStore.get();
  const member = state.members.byId[memberId];
  if (!member) return err('That person is no longer on the team.');

  teamStore.set({ ...state, activeId: memberId });
  return ok(member);
}
