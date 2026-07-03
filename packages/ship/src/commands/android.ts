import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadConfig, type ShipConfig } from '../config.js';
import { errorMessage, log } from '../lib/log.js';
import { runNpx } from '../lib/run.js';

export function android(cwd: string): number {
  let cfg: ShipConfig;
  try {
    cfg = loadConfig(cwd);
  } catch (error) {
    log.fail(errorMessage(error));
    return 1;
  }

  // Resolve from the app's root, not from this package, so we see the app's node_modules.
  try {
    createRequire(join(cwd, 'package.json')).resolve('@capacitor/cli/package.json');
  } catch {
    log.fail(
      '@capacitor/cli not found in this app — run: npm i -D @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android',
    );
    return 1;
  }

  if (!existsSync(join(cwd, cfg.webDir))) {
    log.fail(`${cfg.webDir}/ does not exist — run \`kitbash-ship web\` first`);
    return 1;
  }

  if (!existsSync(join(cwd, 'android'))) {
    log.info('android/ platform missing — adding it');
    const added = runNpx(['cap', 'add', 'android'], cwd);
    if (added !== 0) return added;
  }

  const synced = runNpx(['cap', 'sync', 'android'], cwd);
  if (synced !== 0) return synced;

  const opened = runNpx(['cap', 'open', 'android'], cwd);
  if (opened !== 0) return opened;

  log.ok('Android Studio project ready — build a signed bundle and upload via Play Console');
  return 0;
}
