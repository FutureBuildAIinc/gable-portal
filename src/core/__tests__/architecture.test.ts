// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the load-bearing constraint of this codebase: src/core must stay
 * framework-free so a future Lit migration only rewrites src/ui. A lint rule
 * can be disabled inline; this test can't be, which is why it exists.
 */

const CORE_DIR = join(__dirname, '..');

const BANNED_IMPORTS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-router',
  'use-sync-external-store',
  'lit',
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Matches the module specifier of static imports and re-exports. */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

describe('src/core stays framework-free', () => {
  const files = collectTsFiles(CORE_DIR);

  it('finds core source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports no UI framework', () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const bare = specifier
          .split('/')
          .slice(0, specifier.startsWith('@') ? 2 : 1)
          .join('/');
        if (BANNED_IMPORTS.includes(specifier) || BANNED_IMPORTS.includes(bare)) {
          violations.push(`${relative(CORE_DIR, file)} imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('never reaches into src/ui', () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('@ui') || specifier.includes('../ui/')) {
          violations.push(`${relative(CORE_DIR, file)} imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
