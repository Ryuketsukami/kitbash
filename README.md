# kitbash

Assemble apps from kit parts.

kitbash is a library of drop-in React modules that each add a whole capability to an
app — guided onboarding, multi-provider sign-in, purchases, multi-platform packaging —
so a new app is mostly wiring, not rebuilding. One React codebase, shipped to iOS,
Android, the Microsoft Store, and the web.

## How it's built

- **Modules, not a framework.** Each package under `packages/` is self-contained,
  TypeScript, ESM, and usable on its own. Take one, some, or all.
- **Config in, behavior out.** Client modules take explicit config objects; server
  pieces read documented `KB_*` env vars. Each module's README lists exactly what it
  needs — nothing is discovered implicitly.
- **No lock-in.** Modules depend on React (plus optional platform SDKs) — never on each
  other, and never on any app.

## The modules

See [INDEX.md](INDEX.md) for the catalog. Every module also carries its own README in
`packages/<module>/` with wiring steps and required env vars.

## Using a module in an app

Inside this monorepo: add the workspace dependency and import.

In any other app:

```sh
npm run build        # compile all packages
npm run pack:all     # tarballs into .tarballs/
npm i /path/to/kitbash/.tarballs/kitbash-onboarding-0.1.0.tgz
```

## Layout

```
packages/
  onboarding/   spotlight tours
  oauth/        multi-provider sign-in
  shop/         RevenueCat purchases
  ship/         multi-platform build pipeline
```

## Development

```sh
npm install
npm run typecheck
npm run build
```
