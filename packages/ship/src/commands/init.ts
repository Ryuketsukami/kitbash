import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, loadConfig, type ShipConfig } from '../config.js';
import { errorMessage, log } from '../lib/log.js';
import {
  capacitorConfig,
  electronBuilderConfig,
  electronMain,
  electronPreload,
  serviceWorker,
  swRegister,
  webManifest,
} from '../lib/templates.js';

const STARTER_CONFIG = {
  appId: 'com.example.app',
  appName: 'My App',
  webDir: 'dist',
} as const;

export function init(cwd: string, yes: boolean): number {
  const configPath = join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    if (!yes) {
      log.fail(
        `${CONFIG_FILE} not found. Create it, or run \`kitbash-ship init --yes\` to write a starter config.`,
      );
      return 1;
    }
    writeFileSync(configPath, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`);
    log.ok(`created ${CONFIG_FILE} — edit appId/appName before shipping.`);
  }

  let cfg: ShipConfig;
  try {
    cfg = loadConfig(cwd);
  } catch (error) {
    log.fail(errorMessage(error));
    return 1;
  }

  const files: ReadonlyArray<readonly [string, string]> = [
    ['capacitor.config.ts', capacitorConfig(cfg)],
    ['electron/main.mjs', electronMain(cfg)],
    ['electron/preload.mjs', electronPreload()],
    ['electron-builder.json', electronBuilderConfig(cfg)],
    ['public/manifest.webmanifest', webManifest(cfg)],
    ['public/sw.js', serviceWorker()],
    ['src/kitbash-sw.ts', swRegister()],
  ];
  for (const [rel, content] of files) {
    const abs = join(cwd, rel);
    if (existsSync(abs) && !yes) {
      log.info(`skipped ${rel} (exists — rerun with --yes to overwrite)`);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    log.ok(`created ${rel}`);
  }

  log.info('next steps:');
  console.log(`
  1. Install the toolchains (kitbash-ship does not install them):
     npm i -D @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android electron electron-builder

  2. Add to your index.html <head>:
     <link rel="manifest" href="/manifest.webmanifest">
     and call registerSW() from src/kitbash-sw.ts in your app entry.

  3. Point Electron at the shell — in package.json:
     "main": "electron/main.mjs"

  4. Suggested package.json scripts:
     "ship:web": "kitbash-ship web",
     "ship:ios": "kitbash-ship ios",
     "ship:android": "kitbash-ship android",
     "ship:windows": "kitbash-ship windows"
`);
  return 0;
}
