import { spawnSync } from 'node:child_process';
import { log } from './log.js';

// WHY: on Windows, npm and npx are .cmd shims that only execute through a shell.
const useShell = process.platform === 'win32';

function run(command: string, args: string[], cwd: string): number {
  log.info(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: useShell });
  if (result.error !== undefined) {
    log.fail(`could not start ${command}: ${result.error.message}`);
    return 1;
  }
  // status is null when the child was killed by a signal; treat that as failure.
  return result.status ?? 1;
}

export function runNpx(args: string[], cwd: string): number {
  return run('npx', args, cwd);
}

export function runNpm(args: string[], cwd: string): number {
  return run('npm', args, cwd);
}
