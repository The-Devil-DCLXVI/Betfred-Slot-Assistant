const { app, BrowserWindow, ipcMain, protocol, Menu, dialog, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let tray = null;
let isQuitting = false;

const store = new Store();
const winStateStore = new Store({ name: 'window-state' });

const APP_NAME = 'Betfred Slot Assistant (Desktop)';
const APP_VERSION = app.getVersion();
const DEBUG = process.env.BFAPP_DEBUG === '1';

// Closing the window will hide it to the tray instead of quitting.
const MINIMIZE_TO_TRAY = true;

// Prevent multiple instances fighting over storage/session.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// Hide noisy updater logs unless debugging
autoUpdater.logger = null;

function log(...args) {
  if (DEBUG) console.log(...args);
}
function warn(...args) {
  if (DEBUG) console.warn(...args);
}
function err(...args) {
  console.error(...args);
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    err('[readFileSafe] Failed:', p, e);
    return null;
  }
}

/**
 * bfapp:// protocol
 * - bfapp://assets/... -> BFApp/app/assets/...
 * - bfapp://...        -> BFApp/app/inject/...
 */
function registerBfappProtocol() {
  protocol.registerFileProtocol('bfapp', (request, callback) => {
    try {
      const raw = request.url.replace(/^bfapp:\/\//i, '');
      const safeRel = raw.replace(/^[\\/]+/, '').replace(/\.\./g, '');

      const isAssets = safeRel.toLowerCase().startsWith('assets/');
      const baseDir = isAssets ? path.join(__dirname, 'assets') : path.join(__dirname, 'inject');
      const relInside = isAssets ? safeRel.slice('assets/'.length) : safeRel;

      const filePath = path.join(baseDir, relInside);
      callback({ path: filePath });
    } catch (e) {
      err('[bfapp protocol] error:', e);
      callback({ error: -2 });
    }
  });
}

async function ensureShim(win) {
  const shimCode = `
    (() => {
      const bridge = window.bfAppBridge;
      if (!bridge) return;

      window.chrome = window.chrome || {};

      // storage.local
      window.chrome.storage = window.chrome.storage || {};
      window.chrome.storage.local = window.chrome.storage.local || {};

      window.chrome.storage.local.get = (keys, cb) => bridge.storageGet(keys).then(res => cb && cb(res));
      window.chrome.storage.local.set = (obj, cb) => bridge.storageSet(obj).then(() => cb && cb());
      window.chrome.storage.local.remove = (keys, cb) => bridge.storageRemove(keys).then(() => cb && cb());
      window.chrome.storage.local.clear = (cb) => bridge.storageClear().then(() => cb && cb());

      // runtime messaging + getURL + getManifest
      window.chrome.runtime = window.chrome.runtime || {};
      window.chrome.runtime.sendMessage = (msg, cb) => bridge.sendMessage(msg).then(res => cb && cb(res));
      window.chrome.runtime.onMessage = window.chrome.runtime.onMessage || {};
      window.chrome.runtime.onMessage.addListener = (fn) => bridge.onRuntimeMessage(fn);

      window.chrome.runtime.getURL = (p = '') => {
        const clean = String(p).replace(/^\\/+/, '');
        return 'bfapp://' + clean;
      };

      window.chrome.runtime.getManifest = () => ({
        name: ${JSON.stringify(APP_NAME)},
        version: ${JSON.stringify(APP_VERSION)},
        manifest_version: 3
      });

      window.__BF_DESKTOP__ = true;
    })();
  `;

  try {
    await win.webContents.executeJavaScript(shimCode);
  } catch (e) {
    err('[ensureShim] failed:', e);
  }
}

async function injectCssOnce(win) {
  const cssCode = readFileSafe(path.join(__dirname, 'inject', 'styles.css'));
  if (!cssCode) return;

  const did = await win.webContents.executeJavaScript(`
    (() => {
      if (window.__BFAPP_CSS_INJECTED__) return false;
      window.__BFAPP_CSS_INJECTED__ = true;
      return true;
    })();
  `);

  if (!did) return;

  try {
    await win.webContents.insertCSS(cssCode);
    log('[injectCssOnce] CSS injected');
  } catch (e) {
    err('[injectCssOnce] failed:', e);
  }
}

async function injectBundleOnce(win) {
  const jsCode = readFileSafe(path.join(__dirname, 'inject', 'main.iife.js'));
  if (!jsCode) return;

  const shouldInject = await win.webContents.executeJavaScript(`
    (() => {
      if (window.__BFAPP_BUNDLE_INJECTED__) return false;
      window.__BFAPP_BUNDLE_INJECTED__ = true;
      return true;
    })();
  `);

  if (!shouldInject) return;

  try {
    const wrapped = `
      (() => {
        try { ${jsCode} }
        catch (e) {
          console.error('[BF Desktop] Bundle runtime error:', e);
          throw e;
        }
      })();
    `;
    await win.webContents.executeJavaScript(wrapped);
    log('[injectBundleOnce] Bundle injected OK on', win.webContents.getURL());
  } catch (e) {
    err('[injectBundleOnce] failed:', e);
  }
}

async function onNavigation(win) {
  await ensureShim(win);
  await injectCssOnce(win);
  await injectBundleOnce(win);

  // optional SPA signal (harmless if unused)
  try {
    await win.webContents.executeJavaScript(`
      window.dispatchEvent(new CustomEvent('bfapp:navigation', { detail: { url: location.href } }));
    `);
  } catch {
    // ignore
  }
}

function setAppMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools', visible: DEBUG },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: async () => {
            try {
              await autoUpdater.checkForUpdates();
              dialog.showMessageBox({
                type: 'info',
                title: 'Updates',
                message: 'Checking for updates...',
                detail: 'If an update is available, you will be prompted to download it.'
              });
            } catch (e) {
              dialog.showMessageBox({
                type: 'error',
                title: 'Updates',
                message: 'Update check failed',
                detail: String(e && e.message ? e.message : e)
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About',
              message: APP_NAME,
              detail: `Version: ${APP_VERSION}\n\nIndependent third-party desktop app.\nNot affiliated with or endorsed by Betfred.`,
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createTray() {
  // Try a dedicated tray icon first, fall back to any existing asset.
  const candidates = [
    path.join(__dirname, 'assets', 'tray.png'),
    path.join(__dirname, 'assets', 'external-link-icon.png'),
    path.join(__dirname, 'assets', 'youtube.png')
  ];

  const iconPath = candidates.find((p) => fs.existsSync(p));
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (image && !image.isEmpty()) {
    image = image.resize({ width: 16, height: 16 });
  }

  tray = new Tray(image);
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

function setupAutoUpdater() {
  // electron-updater uses GitHub releases when configured in package.json
  autoUpdater.autoDownload = false;

  autoUpdater.on('update-available', async (info) => {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `A new version is available (${info && info.version ? info.version : 'unknown'}).`,
      detail: 'Download and install now?',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        await dialog.showMessageBox({
          type: 'error',
          title: 'Update download failed',
          message: 'Could not download the update.',
          detail: String(e && e.message ? e.message : e)
        });
      }
    }
  });

  autoUpdater.on('update-downloaded', async () => {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'The update has been downloaded.',
      detail: 'Restart now to install it?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (e) => {
    if (DEBUG) console.error('autoUpdater error', e);
  });
}


function getWindowState() {
  const defaults = { width: 1280, height: 900 };
  const saved = winStateStore.get('main', {});
  return { ...defaults, ...saved };
}

function saveWindowState(win) {
  if (!win) return;
  const bounds = win.getBounds();
  const isMax = win.isMaximized();
  winStateStore.set('main', { ...bounds, isMaximized: isMax });
}

function createWindow() {
  const state = getWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (state.isMaximized) mainWindow.maximize();

  setAppMenu();
  if (MINIMIZE_TO_TRAY) {
    createTray();
  }

  // Keep injections working for SPA + navigations
  mainWindow.webContents.on('did-finish-load', () => onNavigation(mainWindow));
  mainWindow.webContents.on('did-navigate', () => onNavigation(mainWindow));
  mainWindow.webContents.on('did-navigate-in-page', () => onNavigation(mainWindow));

  // Save window state
  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
  mainWindow.on('close', (e) => {
    saveWindowState(mainWindow);

    // Minimize-to-tray behaviour (unless the user is explicitly quitting)
    if (MINIMIZE_TO_TRAY && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Optional dev logging of page console
  if (DEBUG) {
    mainWindow.webContents.on('console-message', (event, ...args) => {
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const { level, message, lineNumber, sourceId } = args[0];
        warn(`[PAGE ${level}] ${message} (${sourceId}:${lineNumber})`);
        return;
      }
      const [level, message, line, sourceId] = args;
      warn(`[PAGE ${level}] ${message} (${sourceId}:${line})`);
    });
  }

  mainWindow.loadURL('https://www.betfred.com/games');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* -------------------- IPC: storage -------------------- */
ipcMain.handle('storage:get', async (_e, keys) => {
  if (!keys) return store.store;

  if (Array.isArray(keys)) {
    const result = {};
    keys.forEach((k) => (result[k] = store.get(k)));
    return result;
  }

  if (typeof keys === 'string') return { [keys]: store.get(keys) };

  if (typeof keys === 'object') {
    const result = {};
    Object.keys(keys).forEach((k) => {
      result[k] = store.get(k, keys[k]);
    });
    return result;
  }

  return {};
});

ipcMain.handle('storage:set', async (_e, obj) => {
  Object.entries(obj).forEach(([k, v]) => store.set(k, v));
});

ipcMain.handle('storage:remove', async (_e, keys) => {
  if (Array.isArray(keys)) keys.forEach((k) => store.delete(k));
  else store.delete(keys);
});

ipcMain.handle('storage:clear', async () => {
  store.clear();
});

/* -------------------- IPC: runtime messaging -------------------- */
ipcMain.handle('runtime:sendMessage', async (_e, message) => {
  if (mainWindow) mainWindow.webContents.send('runtime:message', message);
  return true;
});

/* -------------------- lifecycle -------------------- */
app.whenReady().then(() => {
  registerBfappProtocol();
  setupAutoUpdater();
  createWindow();

  // Check for updates on startup. Will do nothing until you publish releases.
  try {
    autoUpdater.checkForUpdates();
  } catch (e) {
    if (DEBUG) warn('autoUpdater check failed', e);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
