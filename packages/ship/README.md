# @kitbash/ship

One React (Vite) codebase, four targets: web (PWA), iOS and Android (Capacitor shells), and the Microsoft Store (Electron packaged as MSIX via electron-builder).
`kitbash-ship` scaffolds the config files and orchestrates the standard tools — Capacitor, Electron, electron-builder — it does not replace them.
Zero runtime dependencies; needs Node 20+.

## Wire

```sh
npx kitbash-ship init --yes   # writes a starter ship.config.json + scaffolding
# edit ship.config.json: appId, appName, webDir, optional devUrl / deepLinkScheme / electron / windows
npm i -D @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android electron electron-builder
```

Add `<link rel="manifest" href="/manifest.webmanifest">` to `index.html`, call `registerSW()` from `src/kitbash-sw.ts` in your app entry, and set `"main": "electron/main.mjs"` in package.json. Then per target:

| Command | What it runs | Produces |
| --- | --- | --- |
| `kitbash-ship web` | `npm run build` + output checks | `dist/` static PWA |
| `kitbash-ship ios` | `cap add/sync/open ios` | Xcode project in `ios/` |
| `kitbash-ship android` | `cap add/sync/open android` | Android Studio project in `android/` |
| `kitbash-ship windows` | `electron-builder --win appx` | `.appx` in `dist-electron/` (electron-builder output dir) |

`kitbash-ship doctor` checks node version, config validity, installed toolchains, build output and icons.

## Env vars

None required. Windows signing uses electron-builder's standard `CSC_LINK` / `CSC_KEY_PASSWORD`; MS Store identity values come from Partner Center into ship.config.json `windows`.

## Notes

- iOS/Android store submission happens in Xcode / Play Console (signing, listings). `doctor` does not check for Xcode or Android Studio — that is out of scope here.
- MSIX `identityName` / `publisher` MUST match Partner Center exactly or the Store upload is rejected.
- Deep links: register `deepLinkScheme` in the native projects (Info.plist `CFBundleURLTypes`, Android intent-filter) and handle opens with the [Capacitor App plugin](https://capacitorjs.com/docs/apis/app).
- PWA needs the manifest `<link>` plus the `registerSW()` import; icons live at `public/icons/icon-192.png` and `icon-512.png`.
- `devUrl` bakes a dev-server block into `capacitor.config.ts` (remove for release) and enables `ELECTRON_DEV=1` live-reload in the Electron shell.
