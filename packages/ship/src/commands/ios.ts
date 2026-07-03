import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadConfig, type ShipConfig } from '../config.js';
import { errorMessage, log } from '../lib/log.js';
import { runNpx } from '../lib/run.js';

export function ios(cwd: string): number {
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

  if (!existsSync(join(cwd, 'ios'))) {
    log.info('ios/ platform missing — adding it');
    const added = runNpx(['cap', 'add', 'ios'], cwd);
    if (added !== 0) return added;
  }

  const synced = runNpx(['cap', 'sync', 'ios'], cwd);
  if (synced !== 0) return synced;

  const opened = runNpx(['cap', 'open', 'ios'], cwd);
  if (opened !== 0) return opened;

  log.ok('Xcode project ready — sign, archive and submit from Xcode');
  return 0;
}
