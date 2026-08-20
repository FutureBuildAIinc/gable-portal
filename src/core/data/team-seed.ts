// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { TeamMember } from '../domain/team';

/**
 * Summit Ridge Builders' people. Four seats, one per role, so the demo can
 * show what each role sees without anyone having to invent a coworker first.
 * Dana (the account's named contact) is the owner and the default actor.
 */
export const SEED_TEAM: TeamMember[] = [
  {
    id: 'tm_dana',
    name: 'Dana Reyes',
    role: 'owner',
    email: 'dana@summitridgebuilds.com',
    initials: 'DR',
    createdAt: '2026-07-01T14:00:00.000Z',
  },
  {
    id: 'tm_marcus',
    name: 'Marcus Webb',
    role: 'pm',
    email: 'marcus@summitridgebuilds.com',
    initials: 'MW',
    createdAt: '2026-07-01T14:05:00.000Z',
  },
  {
    id: 'tm_robin',
    name: 'Robin Alvarez',
    role: 'ap',
    email: 'robin@summitridgebuilds.com',
    initials: 'RA',
    createdAt: '2026-07-01T14:10:00.000Z',
  },
  {
    id: 'tm_ty',
    name: 'Ty Nguyen',
    role: 'field',
    initials: 'TN',
    createdAt: '2026-07-08T09:00:00.000Z',
  },
];
