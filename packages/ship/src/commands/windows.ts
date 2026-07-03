import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadConfig, type ShipConfig } from '../config.js';
import { errorMessage, log } from '../lib/log.js';
import { runNpx } from '../lib/run.js';

export function windows(cwd: string): number {
  let cfg: ShipConfig;
  try {
    cfg = loadConfig(cwd);
  } catch (error) {
    log.fail(errorMessage(error));
    return 1;
  }

  // Resolve from the app's root, not from this package, so we see the app's node_modules.
  const require = createRequire(join(cwd, 'package.json'));
  for (const pkg of ['electron', 'electron-builder'] as const) {
    try {
      require.resolve(`${pkg}/package.json`);
    } catch {
      log.fail(`${pkg} not found in this app — run: npm i -D electron electron-builder`);
      return 1;
    }
  }

  if (!existsSync(join(cwd, 'electron-builder.json'))) {
    log.fail('electron-builder.json not found — run `kitbash-ship init` first');
    return 1;
  }

  if (!existsSync(join(cwd, cfg.webDir, 'index.html'))) {
    log.fail(`${cfg.webDir}/index.html missing — run \`kitbash-ship web\` first`);
    return 1;
  }

  const code = runNpx(['electron-builder', '--win', 'appx', '--config', 'electron-builder.json'], cwd);
  if (code !== 0) {
    log.fail(`electron-builder failed (exit ${code})`);
    return code;
  }
  log.ok('.appx written to dist-electron/ — upload it in Partner Center');
  return 0;
}
