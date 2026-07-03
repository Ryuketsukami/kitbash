import type { NativeSignInResult, OAuthProviderId } from './types.js';

export type OAuthPlatform = 'web' | 'ios' | 'android';

export interface OAuthClientConfig {
  /** Origin (or base URL) of the server that mounts the /oauth/* routes. */
  serverUrl: string;
  /** Custom URL scheme of the native app, e.g. "myapp". Required for native sign-in. */
  appScheme?: string;
}

export interface OAuthSignInOptions {
  /** Where to land after a web sign-in. Defaults to the current path + query. */
  redirectPath?: string;
}

export interface OAuthClient {
  platform(): OAuthPlatform;
  signIn(provider: OAuthProviderId, opts?: OAuthSignInOptions): Promise<NativeSignInResult | void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

function isNative(): boolean {
  return capacitorGlobal()?.isNativePlatform?.() === true;
}

// browserFinished can race the appUrlOpen deep link on iOS, so give the deep
// link a moment to arrive before treating a closed browser as a cancel.
const CANCEL_GRACE_MS = 1500;

export function createOAuthClient(config: OAuthClientConfig): OAuthClient {
  const base = config.serverUrl.replace(/\/+$/, '');
  return {
    platform() {
      if (!isNative()) return 'web';
      return capacitorGlobal()?.getPlatform?.() === 'android' ? 'android' : 'ios';
    },
    signIn(provider, opts) {
      if (isNative()) return nativeSignIn(base, provider, config.appScheme);
      const redirect = opts?.redirectPath ?? location.pathname + location.search;
      location.assign(`${base}/oauth/${provider}/start?redirect=${encodeURIComponent(redirect)}`);
      // Full-page navigation: the page unloads, so this promise never settles.
      return new Promise<never>(() => undefined);
    },
  };
}

interface ListenerHandle {
  remove(): Promise<void>;
}

async function nativeSignIn(
  base: string,
  provider: OAuthProviderId,
  appScheme: string | undefined,
): Promise<NativeSignInResult> {
  if (!appScheme) {
    throw new Error('@kitbash/oauth: config.appScheme is required for native sign-in');
  }
  const [{ Browser }, { App }] = await Promise.all([
    import('@capacitor/browser'),
    import('@capacitor/app'),
  ]);
  const callbackPrefix = `${appScheme}://oauth/callback`;
  let urlHandle: ListenerHandle | undefined;
  let finishHandle: ListenerHandle | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const callbackUrl = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      void App.addListener('appUrlOpen', (event) => {
        if (event.url.startsWith(callbackPrefix)) settle(() => resolve(event.url));
      }).then((h) => {
        urlHandle = h;
      });
      void Browser.addListener('browserFinished', () => {
        cancelTimer = setTimeout(
          () => settle(() => reject(new Error('Sign-in was cancelled'))),
          CANCEL_GRACE_MS,
        );
      }).then((h) => {
        finishHandle = h;
      });
      const startUrl =
        `${base}/oauth/${provider}/start?native=1` +
        `&redirect=${encodeURIComponent(callbackPrefix)}`;
      void Browser.open({ url: startUrl }).catch((err: unknown) =>
        settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
      );
    });
    await Browser.close().catch(() => undefined);
    const otc = new URL(callbackUrl).searchParams.get('otc');
    if (!otc) throw new Error('@kitbash/oauth: callback deep link is missing the otc parameter');
    const res = await fetch(`${base}/oauth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ otc }),
    });
    if (!res.ok) throw new Error(`@kitbash/oauth: exchange failed with status ${res.status}`);
    return toNativeResult((await res.json()) as unknown);
  } finally {
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
    await urlHandle?.remove().catch(() => undefined);
    await finishHandle?.remove().catch(() => undefined);
  }
}

function toNativeResult(raw: unknown): NativeSignInResult {
  const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const profile = rec.profile;
  if (typeof profile !== 'object' || profile === null) {
    throw new Error('@kitbash/oauth: exchange response is missing profile');
  }
  const p = profile as Record<string, unknown>;
  if (typeof p.provider !== 'string' || typeof p.id !== 'string') {
    throw new Error('@kitbash/oauth: exchange response profile is malformed');
  }
  return {
    profile: profile as unknown as NativeSignInResult['profile'],
    sessionToken: typeof rec.sessionToken === 'string' ? rec.sessionToken : undefined,
    raw,
  };
}
