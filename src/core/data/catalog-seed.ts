// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type {
  Brand,
  Category,
  Location,
  Presentation,
  Product,
  StockLevel,
  Uom,
} from '../domain/catalog';
import { newId } from '../lib/ids';
import { toCents } from '../lib/money';
import { rngFor } from '../lib/rng';
import rawBrands from './brands.json';
import rawCategories from './categories.json';
import rawProducts from './products.json';

/**
 * Converts the salvaged catalog JSON into the domain model.
 *
 * Two things worth knowing about this data:
 *
 * 1. Prices arrive as float dollars. They are converted to integer cents ONCE,
 *    here, at the boundary. Nothing downstream ever sees a float price.
 *
 * 2. The source has almost no inventory data — `inStock` on 8 of 25 products,
 *    and `leadTime` is free text that describes stock status ("Low Stock —
 *    Order Soon"), not a lead time. But lead-time risk and stock visibility are
 *    core to the product: warning a contractor that a special-order door misses
 *    their Friday delivery is a headline feature. So the missing data is
 *    manufactured here, deterministically from a seeded RNG keyed by SKU, which
 *    means a given seed always produces the same catalog and demos replay
 *    exactly. When a real ERP connects this whole file is replaced by a sync.
 */

interface RawProduct {
  id: number;
  sku: string;
  name: string;
  description: string;
  categoryId: number;
  imageUrl: string;
  baseUom: string;
  isActive: boolean;
  brand: string;
  price: number;
  msrp: number;
  tags: string[];
  relatedSkus: string[];
  coverageSqFt?: number;
  coverageLf?: number;
  inStock?: number;
  leadTime?: string;
}

interface RawCategory {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
}

interface RawBrand {
  id: number;
  name: string;
  description?: string;
  logoUrl?: string;
  website?: string;
}

export const MAIN_YARD_ID = 'loc_yard';
export const DC_ID = 'loc_dc';

export const LOCATIONS: Location[] = [
  { id: MAIN_YARD_ID, name: 'Main Yard', kind: 'yard' },
  { id: DC_ID, name: 'Distribution Center', kind: 'warehouse' },
];

const KNOWN_UOMS: readonly Uom[] = ['EA', 'LF', 'BF', 'SQ', 'SHT', 'BD', 'BG', 'BX', 'RL', 'CY'];

function normalizeUom(raw: string): Uom {
  const upper = raw.toUpperCase() as Uom;
  return KNOWN_UOMS.includes(upper) ? upper : 'EA';
}

export function productId(rawId: number): string {
  return `p_${rawId}`;
}
export function categoryId(rawId: number): string {
  return `c_${rawId}`;
}
export function brandId(rawId: number): string {
  return `b_${rawId}`;
}

/**
 * Groups interchangeable products so value engineering can offer swaps. Derived
 * from tags + category because the source data has no such field; two products
 * sharing a specClass are treated as substitutable.
 */
function deriveSpecClass(raw: RawProduct): string | undefined {
  const tags = raw.tags.map((tag) => tag.toLowerCase());
  if (tags.includes('composite') && tags.includes('decking')) return 'decking-composite';
  if (tags.includes('decking')) return 'decking-wood';
  if (tags.includes('treated') || tags.includes('pressure-treated')) return 'lumber-treated';
  if (tags.includes('framing') || tags.includes('dimensional')) return 'lumber-dimensional';
  if (tags.includes('sheathing') || tags.includes('plywood') || tags.includes('osb')) {
    return 'panel-sheathing';
  }
  if (tags.includes('fastener') || tags.includes('screws') || tags.includes('nails')) {
    return 'fastener';
  }
  if (tags.includes('roofing') || tags.includes('shingles')) return 'roofing-shingle';
  if (tags.includes('concrete')) return 'concrete-mix';
  if (tags.includes('insulation')) return 'insulation';
  return undefined;
}

/**
 * Would a homeowner recognise this as something they picked?
 *
 * Anything they see and touch when the job is finished is a selection; anything
 * buried in the wall is a commodity. Getting this wrong in either direction
 * hurts: hero images on joist hangers is noise, and burying the decking colour
 * in a commodity list hides the decision they agonised over.
 */
function derivePresentation(raw: RawProduct): Presentation {
  const name = raw.name.toLowerCase();
  const text = `${name} ${raw.tags.join(' ')}`.toLowerCase();

  // Dimensional lumber ("2x6x8'") is structure, and the NAME is the reliable
  // signal — tags are not. Pressure-treated joists are tagged 'deck' because
  // they frame one, which would otherwise put a hero image of a 2x6 on a
  // homeowner's proposal next to the decking they actually chose.
  const isDimensional = /\b\d+x\d+/.test(name);
  const isVisibleMillwork = /deck(ing)?|trim|fascia|siding|rail/.test(name);
  if (isDimensional && !isVisibleMillwork) return 'commodity';

  const buried =
    /stud|joist|rafter|plate|sheathing|osb|plywood|nail|screw|fastener|hanger|bracket|concrete|rebar|insulation|felt|underlayment|house ?wrap|vapor|post\b/.test(
      text,
    );
  // Buried wins ties: roofing felt mentions 'roofing' but nobody chose it.
  if (buried) return 'commodity';

  const visible =
    /deck|railing|baluster|siding|shingle|roofing|door|window|trim|cabinet|vanity|counter|fixture|paint|stain|stone|pave/.test(
      text,
    );
  return visible ? 'selection' : 'commodity';
}

/**
 * Fills in stock and lead time. Honours whatever the source provided, and
 * invents the rest deterministically so every demo run agrees.
 *
 * The shape aims at realism a contractor would recognise: most commodity stock
 * is deep and same-day, a few items are thin, and a couple are genuinely out
 * and weeks away — which is what makes the lead-time warnings meaningful.
 */
function deriveAvailability(
  raw: RawProduct,
  seed: number,
): { stock: StockLevel[]; leadTimeDays: number } {
  const rng = rngFor(seed, `avail:${raw.sku}`);
  const declaredStock = raw.inStock;
  const status = (raw.leadTime ?? '').toLowerCase();

  // Respect an explicit low-stock signal from the source data.
  const isLowStock = status.includes('low stock');

  let yardQty: number;
  if (declaredStock !== undefined) {
    yardQty = declaredStock;
  } else if (rng.next() < 0.12) {
    yardQty = 0; // genuinely out — drives the special-order / lead-time story
  } else if (isLowStock) {
    yardQty = rng.int(4, 20);
  } else {
    yardQty = rng.int(30, 400);
  }

  const dcQty = yardQty === 0 ? (rng.next() < 0.5 ? rng.int(10, 60) : 0) : rng.int(0, 120);

  const stock: StockLevel[] = [
    { locationId: MAIN_YARD_ID, onHand: yardQty, onOrder: yardQty === 0 ? rng.int(0, 50) : 0 },
    { locationId: DC_ID, onHand: dcQty, onOrder: 0 },
  ];

  // Stocked anywhere => effectively immediate. Nothing on hand => a real wait.
  const anyOnHand = yardQty > 0 || dcQty > 0;
  const leadTimeDays = anyOnHand ? (yardQty > 0 ? 0 : 2) : rng.int(7, 24);

  return { stock, leadTimeDays };
}

export function seedBrands(): Brand[] {
  return (rawBrands as RawBrand[]).map((raw) => ({
    id: brandId(raw.id),
    name: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.logoUrl ? { logoUrl: raw.logoUrl } : {}),
    ...(raw.website ? { website: raw.website } : {}),
  }));
}

export function seedCategories(): Category[] {
  return (rawCategories as RawCategory[]).map((raw) => ({
    id: categoryId(raw.id),
    name: raw.name,
    slug: raw.slug,
    ...(raw.parentId !== null ? { parentId: categoryId(raw.parentId) } : {}),
  }));
}

export function seedProducts(seed: number): Product[] {
  const brands = seedBrands();
  // Source products reference their brand by name, not id.
  const brandByName = new Map(brands.map((brand) => [brand.name.toLowerCase(), brand.id]));

  return (rawProducts as RawProduct[]).map((raw) => {
    const { stock, leadTimeDays } = deriveAvailability(raw, seed);
    const specClass = deriveSpecClass(raw);
    const resolvedBrandId = brandByName.get(raw.brand.toLowerCase()) ?? newId('b');

    const specs = [
      { label: 'Brand', value: raw.brand },
      { label: 'Sold by', value: raw.baseUom },
      ...(raw.coverageSqFt ? [{ label: 'Coverage', value: `${raw.coverageSqFt} sq ft` }] : []),
      ...(raw.coverageLf ? [{ label: 'Length', value: `${raw.coverageLf} ft` }] : []),
    ];

    return {
      id: productId(raw.id),
      sku: raw.sku,
      name: raw.name,
      description: raw.description,
      categoryId: categoryId(raw.categoryId),
      brandId: resolvedBrandId,
      imageUrl: raw.imageUrl,
      baseUom: normalizeUom(raw.baseUom),
      isActive: raw.isActive,
      listPrice: toCents(raw.price),
      msrp: toCents(raw.msrp),
      tags: raw.tags,
      relatedSkus: raw.relatedSkus,
      specs,
      leadTimeDays,
      stock,
      ...(raw.coverageSqFt !== undefined ? { coverageSqFt: raw.coverageSqFt } : {}),
      ...(raw.coverageLf !== undefined ? { coverageLf: raw.coverageLf } : {}),
      ...(specClass ? { specClass } : {}),
      presentation: derivePresentation(raw),
    } satisfies Product;
  });
}

export interface SeededCatalog {
  products: Product[];
  categories: Category[];
  brands: Brand[];
  locations: Location[];
}

export function seedCatalog(seed: number): SeededCatalog {
  return {
    products: seedProducts(seed),
    categories: seedCategories(),
    brands: seedBrands(),
    locations: LOCATIONS,
  };
}
