export type OAuthProviderId = 'google' | 'apple' | 'github' | 'linkedin' | 'x';

export interface OAuthProfile {
  provider: OAuthProviderId;
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  avatarUrl?: string;
  raw: Record<string, unknown>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch ms when the access token expires, when the provider reports it. */
  expiresAt?: number;
  scope?: string;
}

export interface NativeSignInResult {
  profile: OAuthProfile;
  sessionToken?: string;
  raw: unknown;
}
