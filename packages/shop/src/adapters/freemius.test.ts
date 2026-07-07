import { describe, expect, it } from 'vitest';
import { freemiusOfferings } from './freemius.js';

describe('freemiusOfferings', () => {
  it('maps the configured plan catalog into offerings with config-supplied prices', () => {
    const offerings = freemiusOfferings([
      {
        planId: 4242,
        title: 'Pro',
        description: 'Monthly pro plan',
        kind: 'subscription',
        billingCycle: 'monthly',
        priceFormatted: '$9.99',
        currency: 'USD',
      },
      { planId: '4343', id: 'premium', kind: 'subscription', billingCycle: 'annual' },
      { planId: 5050, offeringId: 'packs', kind: 'consumable', billingCycle: 'lifetime' },
    ]);
    expect(offerings).toHaveLength(2);
    const def = offerings.find((o) => o.id === 'default')!;
    expect(def.packages).toHaveLength(2);
    expect(def.packages[0]).toMatchObject({
      id: '4242',
      productId: '4242',
      title: 'Pro',
      priceFormatted: '$9.99',
      currency: 'USD',
      period: 'P1M',
      kind: 'subscription',
    });
    expect(def.packages[1]).toMatchObject({ id: 'premium', productId: '4343', period: 'P1Y' });
    const packs = offerings.find((o) => o.id === 'packs')!;
    expect(packs.packages[0]).toMatchObject({ id: '5050', kind: 'consumable' });
    expect(packs.packages[0]!.period).toBeUndefined();
  });

  it('returns no offerings for an empty catalog', () => {
    expect(freemiusOfferings([])).toEqual([]);
  });
});
