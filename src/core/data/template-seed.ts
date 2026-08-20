// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import rawTemplates from './bom_templates.json';
import { productId } from './catalog-seed';

/**
 * Bill-of-materials starters. A contractor who builds decks builds the same
 * deck fifty times, so "start from a 10x12 deck" beats searching for eight SKUs
 * one at a time — this is the fastest path from empty order to priced scope.
 */

export interface BomTemplate {
  id: EntityId;
  name: string;
  description: string;
  category: string;
  items: { productId: EntityId; qty: number; notes?: string }[];
}

interface RawTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  items: { productId: number; quantity: number; notes?: string }[];
}

export function seedTemplates(): BomTemplate[] {
  return (rawTemplates as RawTemplate[]).map((raw) => ({
    id: raw.id,
    name: raw.name,
    description: raw.description,
    category: raw.category,
    items: raw.items.map((item) => ({
      productId: productId(item.productId),
      qty: item.quantity,
      ...(item.notes ? { notes: item.notes } : {}),
    })),
  }));
}
