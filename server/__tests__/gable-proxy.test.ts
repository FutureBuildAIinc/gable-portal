// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORTAL_API_PREFIX,
  createGableProxy,
  renderGableRuntimeTag,
  stripSecureAttribute,
} from '../gable-proxy';

/**
 * The proxy, driven over a real socket against a real upstream.
 *
 * Every one of these is a failure that would look like something else in
 * production:
 *
 *  - `Set-Cookie` comma-joined → the login "succeeds" and the next request is
 *    a 401, because an `Expires` attribute legally contains a comma and the
 *    joined header cannot be split back apart.
 *  - `Secure` left on over local HTTP → the browser drops the cookie silently
 *    and the same 401 appears, this time with nothing in any log.
 *  - the query string dropped → catalog filters stop working and nobody
 *    notices until a contractor searches for a SKU they can see on a delivery
 *    note.
 *  - the ERP unconfigured answering 404 → reads as a wrong URL rather than a
 *    missing environment variable.
 */

interface Upstream {
  url: string;
  close: () => Promise<void>;
  received: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
}

function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<Upstream>((resolve) => {
    const received: Upstream['received'] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const open: (() => Promise<void>)[] = [];

async function proxyServer(options: {
  apiUrl: string | undefined;
  allowInsecureCookies?: boolean;
}) {
  const proxy = createGableProxy(options);
  const server = http.createServer((req, res) => {
    void proxy.handle(req, res, req.url ?? '/');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  open.push(() => new Promise((done) => server.close(() => done())));
  return { url: `http://127.0.0.1:${port}`, proxy };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

describe('forwarding', () => {
  it('preserves the whole path and query string', async () => {
    const erp = await upstream((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('[]');
    });
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    await fetch(`${url}${PORTAL_API_PREFIX}/v1/catalog?category=Cornice&q=flash`);

    // App Platform's `preserve_path_prefix` and Connect's mount-prefix
    // stripping are the same bug from two directions; this asserts neither
    // happened.
    expect(erp.received[0]?.url).toBe('/api/portal/v1/catalog?category=Cornice&q=flash');
  });

  it('forwards the request body on a POST', async () => {
    const erp = await upstream((_req, res) => res.end('{"order_id":"x","message":"ok"}'));
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    await fetch(`${url}${PORTAL_API_PREFIX}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'demo@kelbrook.ca', password: 'password' }),
    });

    expect(erp.received[0]?.method).toBe('POST');
    expect(JSON.parse(erp.received[0]?.body ?? '{}')).toEqual({
      email: 'demo@kelbrook.ca',
      password: 'password',
    });
  });

  it('sends the browser’s cookie header upstream', async () => {
    const erp = await upstream((_req, res) => res.end('{}'));
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    await fetch(`${url}${PORTAL_API_PREFIX}/v1/dashboard`, {
      headers: { cookie: 'portal_token=abc123' },
    });

    expect(erp.received[0]?.headers.cookie).toBe('portal_token=abc123');
  });

  it('adds x-forwarded-for so the ERP’s rate limiter sees the real caller', async () => {
    const erp = await upstream((_req, res) => res.end('{}'));
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    await fetch(`${url}${PORTAL_API_PREFIX}/v1/config`);

    // Without this every request appears to come from the portal container and
    // one noisy contractor rate-limits everybody.
    expect(erp.received[0]?.headers['x-forwarded-for']).toBeTruthy();
  });

  it('passes a 401 through unchanged rather than turning it into a 500', async () => {
    const erp = await upstream((_req, res) => {
      res.statusCode = 401;
      res.end('{"error":{"code":"UNAUTHORIZED"}}');
    });
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/orders`);

    expect(response.status).toBe(401);
  });
});

describe('Set-Cookie', () => {
  it('forwards multiple cookies as separate headers, not comma-joined', async () => {
    const erp = await upstream((_req, res) => {
      res.setHeader('set-cookie', [
        'portal_token=abc; Path=/api/portal; Expires=Mon, 24 Aug 2026 17:00:00 GMT; HttpOnly',
        'other=1; Path=/',
      ]);
      res.end('{}');
    });
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/login`, { method: 'POST' });

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    // The comma inside `Expires=Mon, 24 Aug ...` is the whole reason a joined
    // header cannot be split back apart correctly.
    expect(cookies[0]).toContain('portal_token=abc');
    expect(cookies[0]).toContain('Expires=Mon, 24 Aug 2026 17:00:00 GMT');
  });

  it('keeps Secure by default', async () => {
    const erp = await upstream((_req, res) => {
      res.setHeader('set-cookie', ['portal_token=abc; Path=/api/portal; Secure; HttpOnly']);
      res.end('{}');
    });
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/login`, { method: 'POST' });

    expect(response.headers.getSetCookie()[0]).toContain('Secure');
  });

  it('strips Secure only when explicitly allowed', async () => {
    const erp = await upstream((_req, res) => {
      res.setHeader('set-cookie', ['portal_token=abc; Path=/api/portal; Secure; HttpOnly']);
      res.end('{}');
    });
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url, allowInsecureCookies: true });

    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/login`, { method: 'POST' });

    const cookie = response.headers.getSetCookie()[0] ?? '';
    expect(cookie).not.toContain('Secure');
    // HttpOnly must survive: dropping it would make the session readable from
    // any script on the page, which is the property gable's design buys.
    expect(cookie).toContain('HttpOnly');
  });

  it('removes Secure as an attribute, never as a substring of a value', () => {
    // A cookie whose VALUE contains the letters "secure" must survive intact.
    expect(stripSecureAttribute('t=is-secure-token; Path=/; Secure; HttpOnly')).toBe(
      't=is-secure-token; Path=/; HttpOnly',
    );
  });
});

describe('failure modes name the knob', () => {
  it('answers 503 with the missing variable when no ERP is configured', async () => {
    const { url, proxy } = await proxyServer({ apiUrl: undefined });

    expect(proxy.enabled).toBe(false);
    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/catalog`);
    const body = (await response.json()) as { error: { code: string; message: string } };

    // 404 would read as "wrong URL". This says which environment variable is
    // absent, which is the difference between five minutes and an afternoon.
    expect(response.status).toBe(503);
    expect(body.error.code).toBe('GABLE_NOT_CONFIGURED');
    expect(body.error.message).toContain('GABLE_API_URL');
  });

  it('answers 502 when the ERP is configured but unreachable', async () => {
    // Port 1 is reserved and nothing listens there.
    const { url } = await proxyServer({ apiUrl: 'http://127.0.0.1:1' });

    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/catalog`);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe('GABLE_UNREACHABLE');
  });

  it('does not follow a redirect on the client’s behalf', async () => {
    const erp = await upstream((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', '/login');
      res.end();
    });
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: erp.url });

    const response = await fetch(`${url}${PORTAL_API_PREFIX}/v1/orders`, { redirect: 'manual' });

    // Following it would deliver an HTML login page as a 200 and kill the SPA
    // in JSON.parse with no clue where it came from.
    expect(response.status).toBe(302);
  });

  it('normalises a trailing slash on the configured URL', async () => {
    const erp = await upstream((_req, res) => res.end('[]'));
    open.push(erp.close);
    const { url } = await proxyServer({ apiUrl: `${erp.url}/` });

    await fetch(`${url}${PORTAL_API_PREFIX}/v1/catalog`);

    expect(erp.received[0]?.url).toBe('/api/portal/v1/catalog');
  });
});

describe('the injected runtime flag', () => {
  it('tells the browser whether an ERP exists, and never where it is', () => {
    const tag = renderGableRuntimeTag(true);

    expect(tag).toContain('"wired":true');
    expect(tag).toContain('"basePath":"/api/portal/v1"');
    // The ERP's address is a server-side fact. It must not be in the document.
    expect(tag).not.toContain('http');
  });

  it('says standalone when no ERP is configured', () => {
    expect(renderGableRuntimeTag(false)).toContain('"wired":false');
  });
});
