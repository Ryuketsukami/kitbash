import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createFreemiusWebhook,
  freemiusTimeMs,
  parseFreemiusEvent,
  verifyFreemiusSignature,
} from './freemius.js';
import type { FreemiusEvent } from './freemius.js';

const SECRET = 'sk_freemius_test_secret';

function sign(body: string, key: string = SECRET): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

function post(body: string, signature?: string): Request {
  return new Request('http://localhost/billing/freemius/webhook', {
    method: 'POST',
    headers: signature !== undefined ? { 'x-signature': signature } : {},
    body,
  });
}

const PAYLOAD = {
  id: 123456,
  type: 'license.created',
  created: '2026-07-07 10:00:00',
  plugin_id: 99887,
  user_id: 555,
  objects: {
    user: { id: 555, email: ' Buyer@Example.com ' },
    license: {
      id: 777,
      plan_id: 4242,
      pricing_id: 111,
      expiration: '2027-07-07 10:00:00',
      is_cancelled: false,
    },
    subscription: { id: 888, plan_id: 4242 },
    payment: { id: 999, gross: '9.99', subscription_id: 888 },
  },
};

describe('freemiusTimeMs', () => {
  it('parses the Freemius "YYYY-MM-DD HH:MM:SS" format as UTC', () => {
    expect(freemiusTimeMs('2027-07-07 10:00:00')).toBe(Date.parse('2027-07-07T10:00:00Z'));
  });

  it('passes ISO strings through', () => {
    expect(freemiusTimeMs('2027-07-07T10:00:00.000Z')).toBe(Date.parse('2027-07-07T10:00:00Z'));
  });

  it('accepts epoch seconds and epoch milliseconds', () => {
    expect(freemiusTimeMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(freemiusTimeMs(1_800_000_000_000)).toBe(1_800_000_000_000);
  });

  it('returns undefined for null/empty/garbage', () => {
    expect(freemiusTimeMs(null)).toBeUndefined();
    expect(freemiusTimeMs('')).toBeUndefined();
    expect(freemiusTimeMs('soon')).toBeUndefined();
  });
});

describe('parseFreemiusEvent', () => {
  it('flattens ids, buyer email, plan, license expiration and payment fields', () => {
    const evt = parseFreemiusEvent(PAYLOAD);
    expect(evt).toMatchObject({
      id: '123456',
      type: 'license.created',
      productId: '99887',
      userId: '555',
      email: 'buyer@example.com',
      planId: '4242',
      pricingId: '111',
      licenseId: '777',
      subscriptionId: '888',
      paymentId: '999',
      isCancelled: false,
      gross: 9.99,
    });
    expect(evt?.expirationMs).toBe(Date.parse('2027-07-07T10:00:00Z'));
    expect(evt?.raw).toBe(PAYLOAD);
  });

  it('requires id and type', () => {
    expect(parseFreemiusEvent({ type: 'license.created' })).toBeUndefined();
    expect(parseFreemiusEvent({ id: 1 })).toBeUndefined();
    expect(parseFreemiusEvent('nope')).toBeUndefined();
    expect(parseFreemiusEvent(null)).toBeUndefined();
  });

  it('tolerates a minimal payload', () => {
    const evt = parseFreemiusEvent({ id: '9', type: 'payment.refund' });
    expect(evt).toMatchObject({ id: '9', type: 'payment.refund' });
    expect(evt?.email).toBeUndefined();
    expect(evt?.expirationMs).toBeUndefined();
  });
});

describe('verifyFreemiusSignature', () => {
  const body = JSON.stringify(PAYLOAD);

  it('accepts the HMAC-SHA256 hex of the raw body', async () => {
    await expect(verifyFreemiusSignature(body, sign(body), SECRET)).resolves.toBe(true);
  });

  it('accepts uppercase hex signatures', async () => {
    await expect(verifyFreemiusSignature(body, sign(body).toUpperCase(), SECRET)).resolves.toBe(true);
  });

  it('rejects a signature made with another key', async () => {
    await expect(verifyFreemiusSignature(body, sign(body, 'other'), SECRET)).resolves.toBe(false);
  });

  it('rejects missing signatures', async () => {
    await expect(verifyFreemiusSignature(body, null, SECRET)).resolves.toBe(false);
    await expect(verifyFreemiusSignature(body, '', SECRET)).resolves.toBe(false);
  });

  it('rejects a tampered body', async () => {
    await expect(verifyFreemiusSignature(body + ' ', sign(body), SECRET)).resolves.toBe(false);
  });
});

describe('createFreemiusWebhook', () => {
  it('fails at creation without a secret key', () => {
    const saved = process.env.KB_SHOP_FREEMIUS_SECRET;
    delete process.env.KB_SHOP_FREEMIUS_SECRET;
    try {
      expect(() => createFreemiusWebhook()).toThrow(/KB_SHOP_FREEMIUS_SECRET/);
    } finally {
      if (saved !== undefined) process.env.KB_SHOP_FREEMIUS_SECRET = saved;
    }
  });

  it('dispatches a verified event to onEvent and returns 200', async () => {
    const events: FreemiusEvent[] = [];
    const hook = createFreemiusWebhook({ secretKey: SECRET, onEvent: (e) => void events.push(e) });
    const body = JSON.stringify(PAYLOAD);
    const res = await hook.fetch(post(body, sign(body)));
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: '123456', type: 'license.created', email: 'buyer@example.com' });
  });

  it('rejects a bad signature with 401 and does not dispatch', async () => {
    let called = 0;
    const hook = createFreemiusWebhook({ secretKey: SECRET, onEvent: () => void called++ });
    const body = JSON.stringify(PAYLOAD);
    expect((await hook.fetch(post(body, sign(body, 'other')))).status).toBe(401);
    expect((await hook.fetch(post(body))).status).toBe(401);
    expect(called).toBe(0);
  });

  it('rejects a correctly signed but malformed body with 400', async () => {
    const hook = createFreemiusWebhook({ secretKey: SECRET });
    const body = 'not json';
    expect((await hook.fetch(post(body, sign(body)))).status).toBe(400);
  });

  it('acknowledges but does not dispatch events for another product', async () => {
    let called = 0;
    const hook = createFreemiusWebhook({ secretKey: SECRET, productId: 1, onEvent: () => void called++ });
    const body = JSON.stringify(PAYLOAD);
    const res = await hook.fetch(post(body, sign(body)));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ignored: 'other product' });
    expect(called).toBe(0);
  });

  it('returns 500 when onEvent throws so the sender retries', async () => {
    const hook = createFreemiusWebhook({
      secretKey: SECRET,
      onEvent: () => {
        throw new Error('grant failed');
      },
    });
    const body = JSON.stringify(PAYLOAD);
    expect((await hook.fetch(post(body, sign(body)))).status).toBe(500);
  });

  it('rejects non-POST methods with 405', async () => {
    const hook = createFreemiusWebhook({ secretKey: SECRET });
    const res = await hook.fetch(new Request('http://localhost/webhook', { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});
