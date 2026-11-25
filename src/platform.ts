import { Capacitor } from '@capacitor/core';
import { GAME_NAME_EN } from './brand';

/**
 * Where the game runs: the browser, the Windows app (Electron, see `desktop/`) or the Android app
 * (Capacitor, see `android/`). All three run the same build; the apps only add native file saving,
 * a full-screen window and (on Windows) a forced hardware-accelerated renderer.
 */
export type Platform = 'web' | 'windows' | 'android';

/** Bridge exposed by `desktop/preload.cjs`. */
type DesktopBridge = {
  platform: string;
  info: () => Promise<{ version: string; electron: string; chrome: string; gpu: string; portable?: boolean; modsDir?: string }>;
  saveFile: (file: { name: string; data: Uint8Array; kind: FileKind }) => Promise<string | null>;
  /** Opens the mods folder (next to KHL-GM.exe) in Explorer (apps built before it existed lack it). */
  openModsFolder?: () => Promise<string | null>;
  /** Unpacks a mod archive (.zip) into the mods folder: a dropped file, or the «Open» dialog without one. */
  installMod?: (file?: { name: string; data: Uint8Array }) => Promise<ModInstallResult | null>;
};
export type ModInstallResult = { installed: { id: string; name: string; replaced: boolean }[]; errors: string[]; dir: string };
declare global {
  interface Window { khlDesktop?: DesktopBridge }
}

export type FileKind = 'video' | 'save' | 'roster';

export function platform(): Platform {
  if (typeof window === 'undefined') return 'web';
  if (window.khlDesktop) return 'windows';
  try { if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return 'android'; } catch { /* not native */ }
  return 'web';
}
export const isApp = () => platform() !== 'web';

/** Players send their mods (a .zip attached to a GitHub issue form, see .github/ISSUE_TEMPLATE/mod.yml). */
export const MOD_SUBMIT_URL = 'https://github.com/ClubGames/KHL_Manager/issues/new?template=mod.yml';
/**
 * Where the Windows app looks for the player's own mods: the «mods» folder next to the game (KHL-GM.exe or the
 * portable exe; Documents\\Hockey Simulator Manager\\mods when the game folder is read-only). Updates keep it.
 * The exact path comes from the app (`userModsDir()`); this is the label until it answers.
 */
export const USER_MODS_DIR = 'папка игры\\mods';
export async function userModsDir(): Promise<string | null> {
  try { return (await window.khlDesktop?.info())?.modsDir ?? null; } catch { return null; }
}
export const canOpenModsFolder = () => typeof window !== 'undefined' && typeof window.khlDesktop?.openModsFolder === 'function';
export async function openModsFolder(): Promise<string | null> {
  try { return (await window.khlDesktop?.openModsFolder?.()) ?? null; } catch { return null; }
}
/** «Установить мод» is there (Windows app; the browser and Android have no mods folder to write to). */
export const canInstallMods = () => typeof window !== 'undefined' && typeof window.khlDesktop?.installMod === 'function';
/** Install a mod archive: `file` (drag-and-drop) or the system «Open» dialog. null: cancelled. */
export async function installModArchive(file?: File): Promise<ModInstallResult | null> {
  const bridge = window.khlDesktop?.installMod;
  if (!bridge) return null;
  try {
    if (!file) return await bridge();
    if (!/\.zip$/i.test(file.name)) return { installed: [], errors: [`${file.name}: нужен архив .zip с папкой мода`], dir: '' };
    return await bridge({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  } catch (e) {
    return { installed: [], errors: [String((e as Error)?.message ?? e)], dir: '' };
  }
}

export const APP_RELEASE = 'https://github.com/ClubGames/KHL_Manager/releases/tag/app';
export const APP_DOWNLOADS = {
  windowsSetup: 'https://github.com/ClubGames/KHL_Manager/releases/download/app/KHL-GM-Setup.exe',
  windowsPortable: 'https://github.com/ClubGames/KHL_Manager/releases/download/app/KHL-GM-Portable.exe',
  android: 'https://github.com/ClubGames/KHL_Manager/releases/download/app/KHL-GM.apk',
} as const;

/** App version (shown in the settings); null in the browser. */
export async function appVersion(): Promise<string | null> {
  const p = platform();
  try {
    if (p === 'windows') return (await window.khlDesktop!.info()).version;
    if (p === 'android') { const { App } = await import('@capacitor/app'); return (await App.getInfo()).version; }
  } catch { /* unknown */ }
  return null;
}

/** What the user is told after a save (null: cancelled). */
export type SaveResult = { where: string } | null;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function browserDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Saves a file the platform's way:
 * - Windows app: the system «Save as» dialog (videos start in «Видео», the rest in «Документы»);
 * - Android app: a copy in «Документы/Hockey Simulator Manager» plus the share sheet (Telegram, Drive, gallery…);
 * - browser: a normal download.
 */
export async function saveFile(blob: Blob, name: string, kind: FileKind): Promise<SaveResult> {
  const p = platform();
  if (p === 'windows') {
    const path = await window.khlDesktop!.saveFile({ name, data: new Uint8Array(await blob.arrayBuffer()), kind });
    return path ? { where: path } : null;
  }
  if (p === 'android') {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const data = await blobToBase64(blob);
    let uri: string, where: string;
    try {
      uri = (await Filesystem.writeFile({ path: `${GAME_NAME_EN}/${name}`, data, directory: Directory.Documents, recursive: true })).uri;
      where = `Документы/${GAME_NAME_EN}/${name}`;
    } catch {
      // No access to the shared folder on this device: keep it in the app and hand it to the share sheet.
      uri = (await Filesystem.writeFile({ path: name, data, directory: Directory.Cache })).uri;
      where = 'меню «Поделиться»';
    }
    try { await Share.share({ title: name, files: [uri], dialogTitle: kind === 'video' ? 'Отправить видео' : 'Сохранить файл' }); } catch { /* closed */ }
    return { where };
  }
  browserDownload(blob, name);
  return { where: 'загрузки браузера' };
}

/** Graphics adapter as WebGL reports it, and whether the browser fell back to software rendering. */
export type GpuInfo = { renderer: string; software: boolean; webgl: boolean };
let gpuCache: GpuInfo | null = null;
export function gpuInfo(): GpuInfo {
  if (gpuCache) return gpuCache;
  let renderer = '', webgl = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      webgl = true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL */ }
  const software = !webgl || /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer);
  gpuCache = { renderer: renderer.replace(/^ANGLE \((.*)\)$/, '$1') || (webgl ? 'неизвестно' : 'WebGL недоступен'), software, webgl };
  return gpuCache;
}

/**
 * Native glue, run once at start-up: Android «Back» closes the open window/modal (as Esc does) and minimises
 * the app on the main screens; the apps ask for persistent storage so saved careers are never evicted.
 */
export function initPlatform() {
  const p = platform();
  if (p === 'web') return;
  document.documentElement.dataset.app = p;
  void navigator.storage?.persist?.().catch(() => false);
  if (p === 'android') {
    void import('@capacitor/app').then(({ App }) => App.addListener('backButton', () => {
      const overlay = document.querySelector('div.fixed.inset-0, [role="dialog"]');
      if (overlay) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      else void App.minimizeApp();
    }));
  }
}
