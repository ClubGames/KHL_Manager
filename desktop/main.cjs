// Hockey Simulator Manager for Windows: the same web build as the browser version, in its own window.
// - served from a private app:// origin (careers live in the app's own storage, fetch() of roster.json works);
// - GPU acceleration forced on (no blocklist fallback to software rendering) and no background throttling;
// - files (videos, saves, roster) are written through the system «Save as» dialog;
// - external links open in the default browser;
// - the player's own mods live in the «mods» folder next to «Hockey Simulator Manager.exe» (kept across updates, see installer.nsh);
//   «Установить мод» unpacks a .zip archive there.
const { app, BrowserWindow, protocol, net, shell, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { installModZip, migrateMods, writeZip } = require('./modInstall.cjs');
const { createLan } = require('./lan.cjs');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://khl`;
const WEB_ROOT = path.join(__dirname, 'app');
const smokeArg = process.argv.find(a => a.startsWith('--smoke-test'));

// An ASCII profile folder (%APPDATA%\KHL-GM) whatever the product name.
app.setPath('userData', path.join(app.getPath('appData'), 'KHL-GM'));

// Graphics: always use the video card. Chrome turns WebGL to software on blocklisted drivers — the main cause
// of choppy 3D replays in the browser. Prefer the discrete GPU on laptops with two.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');
// Matches keep running at full speed when the window is in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

if (!smokeArg && !app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;

/**
 * Player's own mods: <game folder>\mods\<id>\{mod.json, roster.json, schedule.json, logos}.
 * - installed app: next to «Hockey Simulator Manager.exe» (%LOCALAPPDATA%\Programs\Hockey Simulator Manager\mods by default); the
 *   uninstaller of an update keeps this folder (desktop/installer.nsh → customRemoveFiles);
 * - portable exe: next to Hockey-Simulator-Manager-Portable.exe (PORTABLE_EXECUTABLE_DIR — the exe itself runs from a temp folder);
 * - a game folder without write access (e.g. installed into Program Files): Documents\Hockey Simulator Manager\mods.
 * Older versions kept mods in Documents: they are copied over once (never overwriting).
 * The game sees these folders next to the bundled ones under app://khl/mods/; a user folder with the same name as a
 * bundled mod takes priority file by file (so the bundled league can be edited without losing it on the next update).
 */
const LEGACY_MODS = path.join(app.getPath('documents'), 'Hockey Simulator Manager', 'mods');
const GAME_DIR = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname);
let USER_MODS = path.join(GAME_DIR, 'mods');
const MOVED_NOTE = 'МОДЫ ПЕРЕЕХАЛИ.txt';
const modsReadme = () => `Папка модов «Хоккейного Симулятора Менеджера» (Hockey Simulator Manager).
${USER_MODS}

Проще всего: в игре на экране новой карьеры нажмите «Установить мод» и выберите архив .zip
(или перетащите архив на список модов) — игра сама распакует его сюда.

Вручную: каждый мод — отдельная папка внутри этой:
  mods\\МойМод\\roster.json     клубы, игроки, тренеры (обязательно)
  mods\\МойМод\\mod.json        название и описание (необязательно)
  mods\\МойМод\\schedule.json   календарь сезона (необязательно)
  mods\\МойМод\\logos\\...      эмблемы клубов (необязательно)
Если мод скачан архивом .zip — распакуйте его сюда, чтобы получилась папка с roster.json внутри.

Обновление игры эту папку не удаляет. Мод появится в списке «Мод (лига)» на экране новой карьеры
(если игра открыта — нажмите «Обновить список» или F5).
`;
const winText = (t) => '\ufeff' + t.replace(/\r?\n/g, '\r\n');

async function writable(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await fs.writeFile(probe, '');
    await fs.rm(probe, { force: true });
    return true;
  } catch { return false; }
}

/** Picks the mods folder (game folder, else Documents), creates it with a README, moves mods over from Documents. */
async function setupUserMods() {
  if (!(await writable(USER_MODS))) USER_MODS = LEGACY_MODS;
  try {
    await fs.mkdir(USER_MODS, { recursive: true });
    await fs.writeFile(path.join(USER_MODS, 'README.txt'), winText(modsReadme()), 'utf8');
  } catch { /* read-only: bundled mods only */ }
  if (USER_MODS !== LEGACY_MODS) {
    const note = path.join(LEGACY_MODS, MOVED_NOTE);
    const moved = await fs.access(note).then(() => true, () => false);
    if (!moved && await fs.access(LEGACY_MODS).then(() => true, () => false)) {
      try {
        const copied = await migrateMods(LEGACY_MODS, USER_MODS);
        await fs.writeFile(note, winText(`Папка модов игры теперь находится рядом с игрой:\n${USER_MODS}\n\nМоды из этой папки скопированы туда${copied.length ? ` (${copied.join(', ')})` : ''}. Эту папку можно удалить.\n`), 'utf8');
      } catch { /* keep the old folder as it is */ }
    }
  }
  return USER_MODS;
}
let modsReady = Promise.resolve(USER_MODS);
const ensureUserMods = () => modsReady;

/** Folders in the user mods directory that look like a mod (have roster.json or mod.json). */
async function userModIds() {
  try {
    const dirs = (await fs.readdir(USER_MODS, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.'));
    const ok = await Promise.all(dirs.map(async d => {
      for (const f of ['mod.json', 'roster.json']) { try { await fs.access(path.join(USER_MODS, d.name, f)); return d.name; } catch { /* next */ } }
      return null;
    }));
    return ok.filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
  } catch { return []; }
}

/** mods/index.json = bundled mods + the player's folders. */
async function modIndex() {
  await modsReady;
  let bundled = [];
  try {
    const json = JSON.parse(await fs.readFile(path.join(WEB_ROOT, 'mods', 'index.json'), 'utf8'));
    bundled = (Array.isArray(json) ? json : json.mods || []).map(x => typeof x === 'string' ? x : x && x.id).filter(Boolean);
  } catch { /* no bundled index */ }
  const mods = [...new Set([...bundled, ...await userModIds()])];
  return new Response(JSON.stringify({ mods }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

const TYPES = { '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

function serveApp() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/mods/index.json') return modIndex();
    if (rel.startsWith('/mods/')) {
      await modsReady;
      const own = path.normalize(path.join(USER_MODS, rel.slice('/mods/'.length)));
      if (own.startsWith(USER_MODS + path.sep)) {
        try {
          const data = await fs.readFile(own);
          return new Response(data, { headers: { 'content-type': TYPES[path.extname(own).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } });
        } catch { /* not in the user folder: the bundled file */ }
      }
    }
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT)) return new Response('Forbidden', { status: 403 });
    try {
      await fs.access(file);
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Хоккейный Симулятор Менеджера – Hockey Simulator Manager',
    backgroundColor: '#0b1420',
    autoHideMenuBar: true,
    icon: path.join(WEB_ROOT, 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (show) win.once('ready-to-show', () => { win.maximize(); win.show(); });

  // Links to other sites (khl.ru, GitHub…) go to the browser; the game itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) { event.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url); }
  });

  // Keys a browser would give: F11 full screen, F5 reload, Ctrl +/−/0 zoom, Ctrl+Shift+I developer tools.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const zoom = win.webContents.getZoomLevel();
    let handled = true;
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (input.key === 'F5' || (ctrl && key === 'r')) win.webContents.reload();
    else if (ctrl && (key === '=' || key === '+')) win.webContents.setZoomLevel(Math.min(zoom + 0.5, 4));
    else if (ctrl && key === '-') win.webContents.setZoomLevel(Math.max(zoom - 0.5, -3));
    else if (ctrl && key === '0') win.webContents.setZoomLevel(0);
    else if (ctrl && input.shift && key === 'i') win.webContents.toggleDevTools();
    else handled = false;
    if (handled) event.preventDefault();
  });

  void win.loadURL(`${ORIGIN}/index.html`);
  win.on('closed', () => { win = null; });
  return win;
}

function gpuSummary() {
  const status = app.getGPUFeatureStatus();
  return `WebGL: ${status.webgl}, WebGL2: ${status.webgl2}, растеризация: ${status.gpu_compositing}`;
}

// Online over the local network (lan.cjs): the page calls these through window.khlDesktop.lan.
const lan = createLan((ev) => { if (win && !win.isDestroyed()) win.webContents.send('lan:event', ev); });
for (const name of ['host', 'beacon', 'stopHost', 'join', 'close', 'scan', 'stopScan', 'addresses']) ipcMain.handle(`lan:${name}`, (_e, o) => lan[name](o || {}));
// the match's messages: fire and forget (dozens a second)
ipcMain.on('lan:send', (_e, o) => lan.send(o || {}));
app.on('will-quit', () => lan.dispose());

ipcMain.handle('khl:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  gpu: gpuSummary(),
  // electron-builder's portable exe sets these: its update is the portable file, not the installer
  portable: !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
  modsDir: USER_MODS,
}));

ipcMain.handle('khl:open-mods', async () => {
  await ensureUserMods();
  await fs.mkdir(USER_MODS, { recursive: true }).catch(() => {});
  const err = await shell.openPath(USER_MODS);
  return err ? null : USER_MODS;
});

/**
 * «Установить мод»: `file` = { name, data } of an archive dropped on the game window, or nothing — then the system
 * «Open» dialog (several archives at once allowed). Resolves to { installed: [{ id, name, replaced }], errors, dir }
 * or null when cancelled.
 */
async function installMods(items) {
  await ensureUserMods();
  const installed = [], errors = [];
  for (const it of items) {
    try {
      const data = it.data ? Buffer.from(it.data) : await fs.readFile(it.path);
      installed.push(...(await installModZip(data, it.name || path.basename(it.path || 'mod.zip'), USER_MODS)).installed);
    } catch (e) {
      errors.push(`${it.name || path.basename(it.path || '')}: ${e && e.message || e}`);
    }
  }
  return { installed, errors, dir: USER_MODS };
}
ipcMain.handle('khl:install-mod', async (event, file) => {
  if (file && file.data) return installMods([{ name: String(file.name || 'mod.zip'), data: file.data }]);
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: 'Установить мод — выберите архив .zip',
    defaultPath: app.getPath('downloads'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Архив мода (.zip)', extensions: ['zip'] }, { name: 'Все файлы', extensions: ['*'] }],
  });
  if (canceled || !filePaths.length) return null;
  return installMods(filePaths.map((p) => ({ path: p, name: path.basename(p) })));
});

ipcMain.handle('khl:save-file', async (event, { name, data, kind }) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const folder = kind === 'video' ? app.getPath('videos') : app.getPath('documents');
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  const filters = ext === 'mp4'
    ? [{ name: 'Видео MP4', extensions: ['mp4'] }]
    : ext === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [];
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: kind === 'video' ? 'Сохранить видео гола' : 'Сохранить файл',
    defaultPath: path.join(folder, path.basename(String(name))),
    filters: [...filters, { name: 'Все файлы', extensions: ['*'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, Buffer.from(data));
  if (kind === 'video') shell.showItemInFolder(filePath);
  return filePath;
});

/**
 * CI check of the packaged app (`"Hockey Simulator Manager.exe" --smoke-test=result.json`): the game starts from app://
 * (the main menu, then «Играть» → «Карьера»: the career screen with the mod list — the game ships without a league), a mod installed from a .zip is listed and its
 * roster is served, storage works and WebGL is there. Writes JSON, exits 0/1.
 */
async function smokeTest(outFile) {
  const result = { ok: false, steps: [] };
  const w = createWindow({ show: false });
  const evalJs = (code) => w.webContents.executeJavaScript(code, true);
  try {
    await new Promise((resolve, reject) => {
      w.webContents.once('did-finish-load', () => resolve(undefined));
      w.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`load failed ${code} ${desc}`)));
    });
    result.steps.push('loaded');
    const waitFor = async (js, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(js)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
    // the main menu first; «Играть» → «Карьера» opens the career screen with the mod list
    result.menu = await waitFor('!!document.querySelector("[data-main-menu] [data-menu-item=play]")', 60000);
    if (result.menu) {
      await evalJs('document.querySelector("[data-menu-item=play]").click()');
      if (await waitFor('!!document.querySelector("[data-menu-item=career]")', 10000)) await evalJs('document.querySelector("[data-menu-item=career]").click()');
    }
    const started = Date.now();
    let text = '';
    while (Date.now() - started < 60000) {
      text = await evalJs('document.body.textContent'); // not innerText: headings are CSS-uppercased
      if (text.includes('Новая карьера') && await evalJs('!!document.querySelector("[data-mod-picker]")')) break;
      await new Promise(r => setTimeout(r, 250));
    }
    result.startScreen = text.includes('Новая карьера');
    result.modPicker = await evalJs('!!document.querySelector("[data-mod-picker]")');
    result.storage = await evalJs(`(() => { localStorage.setItem('khl.smoke', '1'); return localStorage.getItem('khl.smoke') === '1'; })()`);
    result.desktopBridge = await evalJs('typeof window.khlDesktop?.saveFile === "function" && typeof window.khlDesktop?.installMod === "function"');
    // Mods folder next to the exe; a .zip installs into it and shows up in mods/index.json.
    result.modsDir = await modsReady;
    result.modsInGameFolder = path.resolve(result.modsDir) === path.resolve(GAME_DIR, 'mods');
    const smokeMod = 'SmokeTestMod';
    const inst = await installMods([{ name: `${smokeMod}.zip`, data: writeZip({ 'roster.json': JSON.stringify({ league: { name: 'Smoke' }, teams: [] }), 'mod.json': JSON.stringify({ name: 'Smoke' }) }) }]);
    const listed = await evalJs(`fetch('/mods/index.json').then(r => r.json()).then(j => j.mods)`);
    result.modInstall = inst.errors.length === 0 && inst.installed[0]?.id === smokeMod && listed.includes(smokeMod);
    result.roster = await evalJs(`fetch('/mods/${smokeMod}/roster.json').then(r => r.json()).then(j => j.league && j.league.name === 'Smoke').catch(() => false)`);
    await fs.rm(path.join(result.modsDir, smokeMod), { recursive: true, force: true });
    result.webgl = await evalJs(`(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); if (!gl) return null; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);
    result.gpu = gpuSummary();
    result.version = app.getVersion();
    result.ok = result.menu && result.startScreen && result.modPicker && result.roster && result.storage && result.desktopBridge && result.modsInGameFolder && result.modInstall;
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  await fs.writeFile(outFile, JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  modsReady = setupUserMods();
  serveApp();
  if (smokeArg) {
    const out = smokeArg.includes('=') ? smokeArg.split('=').slice(1).join('=') : path.join(process.cwd(), 'smoke-result.json');
    void smokeTest(out);
    return;
  }
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (!smokeArg) app.quit(); });
