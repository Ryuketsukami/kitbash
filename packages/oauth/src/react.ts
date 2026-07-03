'use client';

import { useCallback, useState } from 'react';
import type { OAuthClient, OAuthSignInOptions } from './client.js';
import type { NativeSignInResult, OAuthProviderId } from './types.js';

export interface UseOAuth {
  signIn(provider: OAuthProviderId, opts?: OAuthSignInOptions): Promise<void>;
  busy: boolean;
  error: Error | null;
  /** Set after a successful native sign-in; stays null on web (full-page redirect). */
  result: NativeSignInResult | null;
}

export function useOAuth(client: OAuthClient): UseOAuth {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<NativeSignInResult | null>(null);

  const signIn = useCallback(
    async (provider: OAuthProviderId, opts?: OAuthSignInOptions) => {
      setBusy(true);
      setError(null);
      try {
        const r = await client.signIn(provider, opts);
        if (r) setResult(r);
        setBusy(false);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setBusy(false);
      }
    },
    [client],
  );

  return { signIn, busy, error, result };
}
