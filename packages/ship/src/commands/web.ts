import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type ShipConfig } from '../config.js';
import { errorMessage, log } from '../lib/log.js';
import { runNpm } from '../lib/run.js';

export function web(cwd: string): number {
  let cfg: ShipConfig;
  try {
    cfg = loadConfig(cwd);
  } catch (error) {
    log.fail(errorMessage(error));
    return 1;
  }

  const code = runNpm(['run', 'build'], cwd);
  if (code !== 0) {
    log.fail(`npm run build failed (exit ${code})`);
    return code;
  }

  const indexHtml = join(cwd, cfg.webDir, 'index.html');
  if (!existsSync(indexHtml)) {
    log.fail(
      `${cfg.webDir}/index.html not found after build — set "webDir" in ship.config.json to your build output directory`,
    );
    return 1;
  }
  if (!readFileSync(indexHtml, 'utf8').includes('manifest.webmanifest')) {
    log.warn(
      'built index.html has no manifest link — add <link rel="manifest" href="/manifest.webmanifest"> to your index.html',
    );
  }
  log.ok(`PWA build ready in ${cfg.webDir}/ — deploy it as a static site`);
  return 0;
}
