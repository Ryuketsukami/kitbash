import { describe, expect, it } from 'vitest';
import { createFreemiusApi } from './freemius-api.js';

function pagedFetch(pages: Record<string, unknown[][]>): { urls: string[]; fetchFn: typeof fetch } {
  const urls: string[] = [];
  const served: Record<string, number> = {};
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const resource = url.includes('/licenses.json') ? 'licenses' : 'users';
    const idx = served[resource] ?? 0;
    served[resource] = idx + 1;
    const list = pages[resource]?.[idx] ?? [];
    return new Response(JSON.stringify({ [resource]: list }), { status: 200 });
  }) as typeof fetch;
  return { urls, fetchFn };
}

describe('createFreemiusApi', () => {
  it('fails at creation without an API token', () => {
    const saved = process.env.KB_SHOP_FREEMIUS_API_TOKEN;
    delete process.env.KB_SHOP_FREEMIUS_API_TOKEN;
    try {
      expect(() => createFreemiusApi({ productId: 1 })).toThrow(/KB_SHOP_FREEMIUS_API_TOKEN/);
    } finally {
      if (saved !== undefined) process.env.KB_SHOP_FREEMIUS_API_TOKEN = saved;
    }
  });

  it('paginates licenses until a short page and narrows the fields', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, plan_id: 42 }));
    const lastPage = [
      {
        id: 201,
        plan_id: '43',
        user_id: 9,
        expiration: '2027-01-01 00:00:00',
        is_cancelled: 'true',
      },
      { no_id: true },
    ];
    const { urls, fetchFn } = pagedFetch({ licenses: [fullPage, lastPage] });
    const api = createFreemiusApi({ productId: 4321, apiToken: 'tok', fetchFn });
    const licenses = await api.listLicenses();
    expect(licenses).toHaveLength(201); // the id-less record is dropped
    expect(urls[0]).toBe('https://api.freemius.com/v1/products/4321/licenses.json?count=200&offset=0');
    expect(urls[1]).toBe('https://api.freemius.com/v1/products/4321/licenses.json?count=200&offset=200');
    const last = licenses[200]!;
    expect(last).toMatchObject({ id: '201', planId: '43', userId: '9', isCancelled: true });
    expect(last.expirationMs).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('lists users with lowercased emails', async () => {
    const { fetchFn } = pagedFetch({ users: [[{ id: 9, email: ' Person@Mail.COM ' }, { id: 10 }]] });
    const api = createFreemiusApi({ productId: 1, apiToken: 'tok', fetchFn });
    const users = await api.listUsers();
    expect(users).toEqual([
      { id: '9', email: 'person@mail.com', raw: { id: 9, email: ' Person@Mail.COM ' } },
      { id: '10', email: undefined, raw: { id: 10 } },
    ]);
  });

  it('throws on a non-2xx response', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const api = createFreemiusApi({ productId: 1, apiToken: 'bad', fetchFn });
    await expect(api.listLicenses()).rejects.toThrow(/401/);
  });
});
