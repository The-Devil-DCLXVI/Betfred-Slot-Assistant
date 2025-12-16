# Betfred Slot Assistant (Unofficial) — Desktop App

This is an Electron desktop app that loads Betfred.com and injects the existing **Betfred Slot Assistant** bundle (`main.iife.js`) + CSS (`styles.css`).

## Disclaimer
This is an independent third-party application. It is not affiliated with or endorsed by Betfred.

## Run locally
```bash
npm install
npm run start
```

### Run with debug logging
```bash
npm run start:debug
```

## Build installers
```bash
npm run dist
```

This produces:
- Windows: NSIS installer
- macOS: DMG
- Linux: AppImage + .deb

## Tray behaviour
- Closing the window will **hide it to the system tray**.
- Use the tray menu to **Show** or **Quit**.

## Where your extension code lives
- Injected JS: `app/inject/main.iife.js`
- Injected CSS: `app/inject/styles.css`
- Static assets/data: `app/assets`, `app/data`

## Notes
- `chrome`/`browser` APIs are polyfilled via `app/preload.js` + a shim injected from `app/main.js`.
- Local assets are served using a custom protocol: `bfapp://...` so `chrome.runtime.getURL("assets/...")` works.

## GitHub auto-updates (how to publish)
Auto-updates are wired using `electron-updater` and GitHub Releases.

1) Create a GitHub repo (public or private) and push this project.

2) Edit `package.json` and set:
- `build.publish[0].owner`
- `build.publish[0].repo`

3) Create a GitHub personal access token (classic) with at least `repo` scope.

4) In your terminal, set the env var and publish:

**Windows PowerShell**
```powershell
$env:GH_TOKEN="YOUR_TOKEN_HERE"
npm run dist:publish
```

After a release is published, the app's **Help → Check for Updates...** menu will work.
- If your bundle uses additional extension APIs, we can extend the polyfill similarly.
