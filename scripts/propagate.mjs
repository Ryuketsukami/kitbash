#!/usr/bin/env node
// Propagates freshly packed @kitbash tarballs into consumer repos: builds,
// tests and packs the workspaces here, copies the tarballs into each
// consumer's vendor/ dir, points their manifests at the new filenames,
// reinstalls, and runs the consumer's own checks. Deploy NEVER happens unless
// --deploy is passed explicitly.
//
//   npm run propagate            # all packages, all consumers
//   npm run propagate -- shop    # only @kitbash/shop
//   npm run propagate -- shop --deploy

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONSUMERS = [
  {
    name: 'cvmake',
    root: '/home/ryuke/projects/cvmake',
    vendorDir: 'vendor',
    manifests: ['apps/api/package.json', 'apps/web/package.json', 'apps/mobile/package.json'],
    install: ['corepack', ['pnpm', 'install']],
    checks: [
      ['corepack', ['pnpm', 'typecheck']],
      ['corepack', ['pnpm', 'build']],
    ],
    deploy: [['bash', ['deploy-api.sh']]],
  },
];

const argv = process.argv.slice(2);
const deploy = argv.includes('--deploy');
const only = argv.filter((a) => !a.startsWith('--')); // short names, e.g. "shop"

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (in ${cwd})`);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`propagate: "${cmd} ${args.join(' ')}" failed (${res.status ?? 'signal'})`);
    process.exit(res.status ?? 1);
  }
}

function workspacePackages() {
  const dir = join(ROOT, 'packages');
  return readdirSync(dir)
    .map((d) => join(dir, d, 'package.json'))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')))
    .map((pkg) => ({
      name: pkg.name, // @kitbash/shop
      short: pkg.name.split('/')[1], // shop
      version: pkg.version,
      tarball: `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`, // kitbash-shop-0.3.0.tgz
    }));
}

// 1. Build, test and pack everything at the source.
run('npm', ['run', 'build'], ROOT);
run('npm', ['run', 'test'], ROOT);
run('npm', ['run', 'pack:all'], ROOT);

const packages = workspacePackages().filter((p) => only.length === 0 || only.includes(p.short));
if (packages.length === 0) {
  console.error(`propagate: no workspace packages match [${only.join(', ')}]`);
  process.exit(1);
}

for (const consumer of CONSUMERS) {
  if (!existsSync(consumer.root)) {
    console.warn(`\npropagate: skipping ${consumer.name} — ${consumer.root} does not exist`);
    continue;
  }
  const vendor = join(consumer.root, consumer.vendorDir);
  let touched = false;

  for (const manifestRel of consumer.manifests) {
    const manifestPath = join(consumer.root, manifestRel);
    if (!existsSync(manifestPath)) continue;
    let raw = readFileSync(manifestPath, 'utf8');
    let changed = false;

    for (const pkg of packages) {
      // Only consumers that already reference this package's tarball are updated;
      // adding the dependency the first time is a manual, per-app decision.
      const ref = new RegExp(`kitbash-${pkg.short}-[0-9A-Za-z.\\-]+?\\.tgz`, 'g');
      if (!ref.test(raw)) continue;
      const next = raw.replace(ref, pkg.tarball);
      if (next !== raw) {
        raw = next;
        changed = true;
      }
      mkdirSync(vendor, { recursive: true });
      copyFileSync(join(ROOT, '.tarballs', pkg.tarball), join(vendor, pkg.tarball));
      for (const f of readdirSync(vendor)) {
        if (f.startsWith(`kitbash-${pkg.short}-`) && f.endsWith('.tgz') && f !== pkg.tarball) {
          rmSync(join(vendor, f));
        }
      }
      touched = true;
      console.log(`\npropagate: ${consumer.name}/${manifestRel} → ${pkg.tarball}`);
    }

    if (changed) writeFileSync(manifestPath, raw);
  }

  if (!touched) {
    console.log(`\npropagate: ${consumer.name} has no tarball references to the selected packages — skipped`);
    continue;
  }

  run(consumer.install[0], consumer.install[1], consumer.root);
  for (const [cmd, args] of consumer.checks) run(cmd, args, consumer.root);

  if (deploy && consumer.deploy) {
    for (const [cmd, args] of consumer.deploy) run(cmd, args, consumer.root);
  } else if (consumer.deploy) {
    console.log(`propagate: ${consumer.name} NOT deployed (pass --deploy to run: ${consumer.deploy.map(([c, a]) => `${c} ${a.join(' ')}`).join(' && ')})`);
  }
}

console.log('\npropagate: done');
