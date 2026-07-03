#!/usr/bin/env node
import { android } from './commands/android.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { ios } from './commands/ios.js';
import { web } from './commands/web.js';
import { windows } from './commands/windows.js';

const USAGE = `kitbash-ship — ship one React (Vite) codebase to web, iOS, Android and the Microsoft Store

Usage: kitbash-ship <command> [--yes]

Commands:
  init      scaffold Capacitor/Electron/PWA config files (--yes: write starter ship.config.json, overwrite existing files)
  doctor    check node, ship.config.json, toolchains, build output and icons
  web       build the app and verify the PWA output
  ios       cap add/sync/open ios (opens Xcode)
  android   cap add/sync/open android (opens Android Studio)
  windows   electron-builder --win appx (MSIX for the Microsoft Store)
`;

function main(argv: string[]): number {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const yes = flags.includes('--yes');
  const unknownFlags = flags.filter((flag) => flag !== '--yes');
  const command = positional[0];

  if (command === undefined || positional.length > 1 || unknownFlags.length > 0) {
    process.stderr.write(USAGE);
    return 1;
  }

  const cwd = process.cwd();
  switch (command) {
    case 'init':
      return init(cwd, yes);
    case 'doctor':
      return doctor(cwd);
    case 'web':
      return web(cwd);
    case 'ios':
      return ios(cwd);
    case 'android':
      return android(cwd);
    case 'windows':
      return windows(cwd);
    default:
      process.stderr.write(USAGE);
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
