// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { AdminApp } from '@/admin/AdminApp';
import { ErrorBoundary } from '@ui/components/ErrorBoundary';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/styles/theme.css';

/**
 * The admin console's own entry point.
 *
 * Separate from the contractor app on purpose: different user, different
 * privileges, and — the load-bearing reason — the contractor bundle is the one
 * headed for embeddable web components on a dealer's site. Admin code has no
 * business shipping inside it.
 */

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <AdminApp />
    </ErrorBoundary>
  </StrictMode>,
);
