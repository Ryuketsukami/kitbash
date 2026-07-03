import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CONFIG_FILE, loadConfig, type ShipConfig } from '../config.js';
import { errorMessage, log } from '../lib/log.js';

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

function warn(message: string): void {
  console.log(`WARN ${message}`);
}

function failed(message: string): void {
  console.error(`FAIL ${message}`);
}

export function doctor(cwd: string): number {
  let failures = 0;

  const major = Number(process.versions.node.split('.')[0] ?? '0');
  if (major >= 20) {
    pass(`node ${process.versions.node} (>= 20)`);
  } else {
    failed(`node ${process.versions.node} — kitbash-ship needs node >= 20`);
    failures += 1;
  }

  let cfg: ShipConfig | undefined;
  try {
    cfg = loadConfig(cwd);
    pass(`${CONFIG_FILE} valid (appId ${cfg.appId})`);
  } catch (error) {
    failed(errorMessage(error));
    failures += 1;
  }

  // Resolve from the app's root, not from this package, so we see the app's node_modules.
  const require = createRequire(join(cwd, 'package.json'));
  const toolchains: ReadonlyArray<readonly [string, string]> = [
    ['@capacitor/cli', 'the ios/android targets'],
    ['electron', 'the windows target'],
    ['electron-builder', 'the windows target'],
  ];
  for (const [pkg, neededFor] of toolchains) {
    let present = true;
    try {
      require.resolve(`${pkg}/package.json`);
    } catch {
      present = false;
    }
    if (present) {
      pass(`${pkg} installed`);
    } else {
      warn(`${pkg} not installed (needed for ${neededFor})`);
    }
  }

  if (cfg !== undefined) {
    if (existsSync(join(cwd, cfg.webDir, 'index.html'))) {
      pass(`${cfg.webDir}/ built`);
    } else {
      warn(`${cfg.webDir}/ not built yet — run \`kitbash-ship web\``);
    }
  }

  for (const icon of ['icon-192.png', 'icon-512.png']) {
    const rel = join('public', 'icons', icon);
    if (existsSync(join(cwd, rel))) {
      pass(`${rel} present`);
    } else {
      warn(`${rel} missing — the PWA manifest points at it`);
    }
  }

  if (failures === 0) {
    log.ok('doctor: no failures');
    return 0;
  }
  log.fail(`doctor: ${failures} failure(s)`);
  return 1;
}
