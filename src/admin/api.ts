// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { DealerConfig } from '@core/domain/config';

/**
 * The admin client.
 *
 * The admin token is a higher-privilege credential than a contractor's BYOK
 * key, so it is held in sessionStorage only — it dies with the tab, and a
 * dealer admin walking away from a machine does not leave a standing grant.
 * There is deliberately no "remember me".
 */

const TOKEN_KEY = 'gablenow.admin-token';

export interface AdminState {
  config: DealerConfig;
  /** Fingerprint of the saved config, echoed back on write as `if-match`. */
  revision: string;
  credential: { present: boolean; masked: string | null };
  usage: {
    total: number;
    /** Busiest contractor first. */
    byAccount: { accountId: string; count: number }[];
  };
}

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A browser refusing storage still allows a single session in memory.
  }
}

export function forgetToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken();
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new AdminError(body?.error?.message ?? 'That did not work.', response.status);
  }
  return body as T;
}

export const adminApi = {
  state: () => request<AdminState>('/state'),
  saveConfig: (config: DealerConfig, revision: string) =>
    request<AdminState>('/config', {
      method: 'PUT',
      body: JSON.stringify(config),
      headers: { 'if-match': revision },
    }),
  saveCredential: (key: string) =>
    request<AdminState>('/credential', { method: 'PUT', body: JSON.stringify({ key }) }),
  removeCredential: () => request<AdminState>('/credential', { method: 'DELETE' }),
};
