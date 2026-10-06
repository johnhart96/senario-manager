# Building and releasing

Installers are built with [electron-builder](https://www.electron.build). Everything is
configured in the `build` section of `package.json`. Output goes to `dist/`.

## Prerequisites

- Node.js 24+ and `npm install`.
- Build each platform **on that platform**, or use the [CI workflow](#continuous-integration):
  - **macOS** builds require macOS.
  - **Windows** builds are best made on Windows. Building from Linux or macOS needs Wine.
  - **Linux** `.rpm` needs `rpmbuild` (`sudo apt install rpm` on Debian/Ubuntu).

## Commands

| Command | Produces |
|---|---|
| `npm run dist:win` | NSIS installer (`x64` + `arm64`) and a portable `.exe` |
| `npm run dist:mac` | `.dmg` and `.zip` for Intel and Apple Silicon |
| `npm run dist:linux` | `.AppImage`, `.deb` and `.rpm` (x64) |
| `npm run dist` | Every target for the current OS |
| `npm run pack` | An unpacked app (`dist/*-unpacked` or `dist/mac*`) for quick testing |
| `npm run test:packaged` | Checks the unpacked build: parser workers and SQLite from inside `app.asar` |

There are no native modules (`npmRebuild: false`), so builds are quick.

## What's in a build

- Only `src/`, `package.json`, `LICENSE` and the production dependencies are packed into
  `app.asar` (about 39 MB). Scripts, tests, docs and build files are excluded.
- The Windows installer shows the GPL license page.
- `.senario` files are registered with the OS (`fileAssociations`). The app handles them via
  command-line arguments (Windows/Linux) and the `open-file` event (macOS), with a
  single-instance lock.
- On Linux, `desktopName` / `syncDesktopName` link the window to its launcher icon.

## Continuous integration

`.github/workflows/build.yml` runs on Windows, macOS and Linux runners:

1. `npm ci`, `npm run check`, `npm test`
2. `electron-builder --dir` and `npm run test:packaged`
3. Builds the installers and uploads them as workflow artifacts.

It runs when you push a `v*` tag, or manually from **Actions → Build → Run workflow**.

## Releasing

1. Update `version` in `package.json` and add an entry to [CHANGELOG.md](../CHANGELOG.md).
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```
3. When the workflow finishes, download the three artifacts and attach the installers to a new
   [GitHub release](https://github.com/johnhart96/senario-manager/releases/new) for the tag.

## Code signing

Unsigned builds work, but users see warnings: Windows SmartScreen, and macOS Gatekeeper blocking
the first launch. To sign, add these repository secrets (**Settings → Secrets and variables →
Actions**). The workflow uses them automatically when present.

| Secret | Purpose |
|---|---|
| `CSC_LINK` | Base64 or URL of the signing certificate (`.p12`/`.pfx`): an Apple Developer ID Application certificate for macOS, a code-signing certificate for Windows |
| `CSC_KEY_PASSWORD` | Its password |
| `APPLE_ID` | Apple ID for notarisation |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Your Apple Developer team ID |

macOS builds use the hardened runtime with `build/entitlements.mac.plist`, which notarisation
requires. Windows certificates from a cloud HSM (e.g. Azure Trusted Signing) need extra
electron-builder configuration. See the
[electron-builder code-signing docs](https://www.electron.build/code-signing).

## Regenerating assets

| Command | Regenerates |
|---|---|
| `npm run icon` | `build/icon.png` (1024×1024) from `build/icon.svg`, rendered by Electron. electron-builder derives the `.ico` and `.icns` from it. |
| `npm run screenshots` | `docs/images/*.png` from a fictional demo scenario. Your own data is never touched. Real IP addresses are replaced with `10.0.0.x` examples. |
| `npm run licenses` | `docs/third-party-licenses.md` from the production dependency tree. Run it after changing dependencies. |

## If the repository moves

The repository address (`github.com/johnhart96/senario-manager`) appears in these files. Update
them all if the repository is renamed or transferred:

- `package.json` (`homepage`, `repository`, `bugs`)
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and `docs/*.md` (search for `johnhart96`)
- `.github/ISSUE_TEMPLATE/config.yml`
