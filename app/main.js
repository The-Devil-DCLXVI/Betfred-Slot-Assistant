const { app, BrowserWindow, ipcMain, protocol, Menu, dialog, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const keytar = require('keytar');

let mainWindow;
let tray = null;
let isQuitting = false;

const store = new Store();
const winStateStore = new Store({ name: 'window-state' });

const APP_NAME = 'Betfred Slot Assistant';
const APP_VERSION = app.getVersion();
const DEBUG = process.env.BFAPP_DEBUG === '1';

// If true, closing the window hides to tray (keeps task running). User requested full exit.
const MINIMIZE_TO_TRAY = false;

/**
 * External URLs that should open in the user's default browser.
 * Keep this to your footer links so Betfred navigation stays inside the app.
 */
const EXTERNAL_URL_PREFIXES = [
  'https://punksquad.com',
  'https://www.punksquad.com',
  'https://youtube.com/@PUNKslots',
  'https://www.youtube.com/@PUNKslots',
  'https://youtu.be/'
];

function isExternalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return EXTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// Prevent multiple instances fighting over storage/session.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  // IMPORTANT: stop executing the rest of this file
  process.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

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
 * - bfapp://assets/... -> app/assets/...
 * - bfapp://...        -> app/inject/...
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

window.chrome.storage.local.get = (keys, cb) => {
  const p = bridge.storageGet(keys).then((res) => res || {});
  if (typeof cb === 'function') { p.then((r) => cb(r)); return; }
  return p;
};

window.chrome.storage.local.set = (obj, cb) => {
  const p = bridge.storageSet(obj).then(() => undefined);
  if (typeof cb === 'function') { p.then(() => cb()); return; }
  return p;
};

window.chrome.storage.local.remove = (keys, cb) => {
  const p = bridge.storageRemove(keys).then(() => undefined);
  if (typeof cb === 'function') { p.then(() => cb()); return; }
  return p;
};

window.chrome.storage.local.clear = (cb) => {
  const p = bridge.storageClear().then(() => undefined);
  if (typeof cb === 'function') { p.then(() => cb()); return; }
  return p;
};


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
    return;
  }

  // Inject password helper AFTER the main bundle (separate file; keeps main.iife.js untouched)
  const pwCode = readFileSafe(path.join(__dirname, 'inject', 'password-helper.iife.js'));
  if (!pwCode) return;

  try {
    await win.webContents.executeJavaScript(`
      (() => {
        if (window.__BFAPP_PW_HELPER_INJECTED__) return;
        window.__BFAPP_PW_HELPER_INJECTED__ = true;
        try { ${pwCode} }
        catch (e) { console.error('[BF Desktop] Password helper error:', e); }
      })();
    `);
    log('[injectBundleOnce] Password helper injected OK on', win.webContents.getURL());
  } catch (e) {
    err('[injectBundleOnce] Password helper inject failed:', e);
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
  autoUpdater.autoDownload = false;

  // Track whether the check was user-initiated
  let userInitiatedCheck = false;

  // Wrap checkForUpdates so we know when the user clicked it
  const originalCheck = autoUpdater.checkForUpdates.bind(autoUpdater);
  autoUpdater.checkForUpdates = async () => {
    userInitiatedCheck = true;
    return originalCheck();
  };

  autoUpdater.on('update-available', async (info) => {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `A new version is available (${info?.version || 'unknown'}).`,
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
          detail: String(e?.message || e)
        });
      }
    }
  });

  autoUpdater.on('update-not-available', () => {
    // Only show this when the user explicitly clicked "Check for updates"
    if (!userInitiatedCheck) return;

    dialog.showMessageBox({
      type: 'info',
      title: 'No updates available',
      message: 'You’re up to date',
      detail: `${APP_NAME} v${APP_VERSION} is the latest version.`
    });

    userInitiatedCheck = false;
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
      devTools: true
    },
  });

  if (state.isMaximized) mainWindow.maximize();

  if (DEBUG || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  setAppMenu();
  if (MINIMIZE_TO_TRAY) createTray();

  // Open matching URLs in the user's default browser (popups / target=_blank)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Open matching URLs in the user's default browser (normal navigation)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Keep injections working for SPA + navigations
  mainWindow.webContents.on('did-finish-load', () => onNavigation(mainWindow));
  mainWindow.webContents.on('did-navigate', () => onNavigation(mainWindow));
  mainWindow.webContents.on('did-navigate-in-page', () => onNavigation(mainWindow));

  // Save window state
  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));

  // Close behaviour: user requested full quit on close
  mainWindow.on('close', () => {
    isQuitting = true;
  });

  mainWindow.loadURL('https://www.betfred.com/games');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* -------------------- IPC: external links -------------------- */
ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

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

/* -------------------- IPC: updater -------------------- */
ipcMain.handle('updater:check', async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});


/* -------------------- IPC: credentials (keytar) -------------------- */
const CREDS_SERVICE = 'Betfred Slot Assistant';
const accountKey = (username) => `betfred:${String(username || '').trim().toLowerCase()}`;

ipcMain.handle('creds:save', async (_e, username, password) => {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const u = username.trim();
  const p = password;
  if (!u || !p) return false;
  await keytar.setPassword(CREDS_SERVICE, accountKey(u), p);
  return true;
});

ipcMain.handle('creds:load', async (_e, username) => {
  if (typeof username !== 'string') return null;
  const u = username.trim();
  if (!u) return null;
  return await keytar.getPassword(CREDS_SERVICE, accountKey(u));
});

ipcMain.handle('creds:delete', async (_e, username) => {
  if (typeof username !== 'string') return false;
  const u = username.trim();
  if (!u) return false;
  return await keytar.deletePassword(CREDS_SERVICE, accountKey(u));
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

  // Only check for updates automatically when installed.
  if (app.isPackaged) {
    try {
      autoUpdater.checkForUpdates();
    } catch (e) {
      if (DEBUG) warn('autoUpdater check failed', e);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
