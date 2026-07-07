import { describe, expect, it } from 'vitest';
import { createRcAdmin } from './rc-admin.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(status: number, body = '{}'): { calls: Call[]; fetchFn: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('createRcAdmin', () => {
  it('fails at creation without a secret key', () => {
    const saved = process.env.KB_SHOP_RC_SECRET;
    delete process.env.KB_SHOP_RC_SECRET;
    try {
      expect(() => createRcAdmin()).toThrow(/KB_SHOP_RC_SECRET/);
    } finally {
      if (saved !== undefined) process.env.KB_SHOP_RC_SECRET = saved;
    }
  });

  it('grants a promotional entitlement with a bearer key and end_time_ms', async () => {
    const { calls, fetchFn } = stubFetch(201);
    const rc = createRcAdmin({ secretKey: 'sk_test', fetchFn });
    await rc.grantEntitlement({ appUserId: 'user 1', entitlementId: 'pro', endTimeMs: 1234.7 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.revenuecat.com/v1/subscribers/user%201/entitlements/pro/promotional');
    expect(call.init?.method).toBe('POST');
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer sk_test');
    expect(JSON.parse(String(call.init?.body))).toEqual({ end_time_ms: 1235 });
  });

  it('throws on a failed grant with the status in the message', async () => {
    const { fetchFn } = stubFetch(403, '{"code":7638}');
    const rc = createRcAdmin({ secretKey: 'sk_test', fetchFn });
    await expect(
      rc.grantEntitlement({ appUserId: 'u', entitlementId: 'pro', endTimeMs: 1 }),
    ).rejects.toThrow(/403/);
  });

  it('revokes via revoke_promotionals and tolerates 404', async () => {
    const { calls, fetchFn } = stubFetch(404);
    const rc = createRcAdmin({ secretKey: 'sk_test', fetchFn });
    await rc.revokeEntitlement({ appUserId: 'u', entitlementId: 'premium' });
    expect(calls[0]!.url).toBe(
      'https://api.revenuecat.com/v1/subscribers/u/entitlements/premium/revoke_promotionals',
    );
  });

  it('throws on a non-404 failed revoke', async () => {
    const { fetchFn } = stubFetch(500);
    const rc = createRcAdmin({ secretKey: 'sk_test', fetchFn });
    await expect(rc.revokeEntitlement({ appUserId: 'u', entitlementId: 'pro' })).rejects.toThrow(/500/);
  });

  it('honors a custom base URL', async () => {
    const { calls, fetchFn } = stubFetch(200);
    const rc = createRcAdmin({ secretKey: 'sk_test', baseUrl: 'http://localhost:9999/v1/', fetchFn });
    await rc.grantEntitlement({ appUserId: 'u', entitlementId: 'pro', endTimeMs: 1 });
    expect(calls[0]!.url).toBe('http://localhost:9999/v1/subscribers/u/entitlements/pro/promotional');
  });
});
