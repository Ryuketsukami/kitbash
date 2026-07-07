import { describe, expect, it } from 'vitest';
import { planReconciliation } from './reconcile.js';

const NOW = Date.parse('2026-07-07T00:00:00Z');
const LATER = NOW + 86_400_000;

describe('planReconciliation', () => {
  it('re-issues every live desired grant and revokes vanished holdings', () => {
    const plan = planReconciliation(
      [
        { key: 'u1', entitlementId: 'pro', endTimeMs: LATER },
        { key: 'u2', entitlementId: 'premium', endTimeMs: LATER },
      ],
      [
        { key: 'u1', entitlementId: 'pro' }, // still desired → kept (re-grant, no revoke)
        { key: 'u3', entitlementId: 'pro' }, // license vanished → revoke
      ],
      NOW,
    );
    expect(plan.grants).toEqual([
      { key: 'u1', entitlementId: 'pro', endTimeMs: LATER },
      { key: 'u2', entitlementId: 'premium', endTimeMs: LATER },
    ]);
    expect(plan.revokes).toEqual([{ key: 'u3', entitlementId: 'pro' }]);
  });

  it('drops already-expired desired grants and revokes their current holdings', () => {
    const plan = planReconciliation(
      [{ key: 'u1', entitlementId: 'pro', endTimeMs: NOW - 1 }],
      [{ key: 'u1', entitlementId: 'pro' }],
      NOW,
    );
    expect(plan.grants).toEqual([]);
    expect(plan.revokes).toEqual([{ key: 'u1', entitlementId: 'pro' }]);
  });

  it('keeps the furthest expiration when the same grant appears twice', () => {
    const plan = planReconciliation(
      [
        { key: 'u1', entitlementId: 'pro', endTimeMs: LATER },
        { key: 'u1', entitlementId: 'pro', endTimeMs: LATER + 5 },
        { key: 'u1', entitlementId: 'pro', endTimeMs: NOW + 5 },
      ],
      [],
      NOW,
    );
    expect(plan.grants).toEqual([{ key: 'u1', entitlementId: 'pro', endTimeMs: LATER + 5 }]);
  });

  it('revokes each vanished holding only once and treats entitlements independently', () => {
    const plan = planReconciliation(
      [{ key: 'u1', entitlementId: 'pro', endTimeMs: LATER }],
      [
        { key: 'u1', entitlementId: 'premium' }, // downgraded premium → pro: revoke premium
        { key: 'u1', entitlementId: 'premium' },
      ],
      NOW,
    );
    expect(plan.grants).toEqual([{ key: 'u1', entitlementId: 'pro', endTimeMs: LATER }]);
    expect(plan.revokes).toEqual([{ key: 'u1', entitlementId: 'premium' }]);
  });
});
