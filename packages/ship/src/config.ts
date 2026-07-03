import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Loaded, validated ship configuration. `webDir` is already defaulted to "dist". */
export interface ShipConfig {
  /** Reverse-DNS application id, e.g. "com.example.app". */
  appId: string;
  appName: string;
  /** Directory of built web assets, relative to the app root. */
  webDir: string;
  /** Vite dev server URL; used by Capacitor live reload and Electron dev mode. */
  devUrl?: string;
  /** Custom URL scheme for deep links, e.g. "myapp". */
  deepLinkScheme?: string;
  electron?: { width?: number; height?: number };
  windows?: { identityName?: string; publisherDisplayName?: string; publisher?: string };
}

export const CONFIG_FILE = 'ship.config.json';

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
// RFC 3986 scheme, restricted to lowercase so it round-trips through native manifests.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(field: string, problem: string): never {
  throw new Error(`${CONFIG_FILE}: "${field}" ${problem}`);
}

export function loadConfig(cwd: string): ShipConfig {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${CONFIG_FILE} not found in ${cwd} — run \`kitbash-ship init --yes\` to write a starter config.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${CONFIG_FILE}: root must be a JSON object`);
  }

  const appId = parsed['appId'];
  if (typeof appId !== 'string' || appId === '') {
    bad('appId', 'is required and must be a string');
  }
  if (!APP_ID_RE.test(appId)) {
    bad('appId', `must be reverse-DNS like "com.example.app" (got "${appId}")`);
  }

  const appName = parsed['appName'];
  if (typeof appName !== 'string' || appName.trim() === '') {
    bad('appName', 'is required and must be a non-empty string');
  }

  let webDir = 'dist';
  const webDirRaw = parsed['webDir'];
  if (webDirRaw !== undefined) {
    if (typeof webDirRaw !== 'string' || webDirRaw.trim() === '') {
      bad('webDir', 'must be a non-empty string when set');
    }
    webDir = webDirRaw;
  }

  let devUrl: string | undefined;
  const devUrlRaw = parsed['devUrl'];
  if (devUrlRaw !== undefined) {
    if (typeof devUrlRaw !== 'string' || !/^https?:\/\//.test(devUrlRaw)) {
      bad('devUrl', 'must be an http(s) URL like "http://localhost:5173" when set');
    }
    devUrl = devUrlRaw;
  }

  let deepLinkScheme: string | undefined;
  const schemeRaw = parsed['deepLinkScheme'];
  if (schemeRaw !== undefined) {
    if (typeof schemeRaw !== 'string' || !SCHEME_RE.test(schemeRaw)) {
      bad(
        'deepLinkScheme',
        'must be a URL scheme like "myapp" (lowercase letter first, then letters/digits/+/-/.)',
      );
    }
    deepLinkScheme = schemeRaw;
  }

  let electron: ShipConfig['electron'];
  const electronRaw = parsed['electron'];
  if (electronRaw !== undefined) {
    if (!isRecord(electronRaw)) {
      bad('electron', 'must be an object when set');
    }
    electron = {};
    for (const key of ['width', 'height'] as const) {
      const value = electronRaw[key];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          bad(`electron.${key}`, 'must be a positive integer when set');
        }
        electron[key] = value;
      }
    }
  }

  let windows: ShipConfig['windows'];
  const windowsRaw = parsed['windows'];
  if (windowsRaw !== undefined) {
    if (!isRecord(windowsRaw)) {
      bad('windows', 'must be an object when set');
    }
    windows = {};
    for (const key of ['identityName', 'publisherDisplayName', 'publisher'] as const) {
      const value = windowsRaw[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || value.trim() === '') {
          bad(`windows.${key}`, 'must be a non-empty string when set');
        }
        windows[key] = value;
      }
    }
  }

  return { appId, appName, webDir, devUrl, deepLinkScheme, electron, windows };
}
