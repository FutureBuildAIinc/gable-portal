// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { flushPersistence } from '@core/stores/persistence';
import { App } from '@ui/App';
import { ErrorBoundary } from '@ui/components/ErrorBoundary';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/theme.css';

// Store writes are debounced, so the last action before a tab closes could be
// lost. pagehide fires reliably on mobile Safari where beforeunload does not.
window.addEventListener('pagehide', flushPersistence);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
