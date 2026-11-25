import { useEffect, useState } from 'react';
import { APP_DOWNLOADS, platform, type Platform } from './platform';

/**
 * «Есть новая версия» — the game compares its build stamp with the newest one:
 * - browser: `version.json` next to the page (GitHub Pages) → the update is a page reload;
 * - Windows / Android apps: the «app» release on GitHub (its notes carry the stamp of the files actually uploaded,
 *   so an app is never sent to download a build that is not there yet) → the new installer / APK is downloaded
 *   and installed over the old one; careers stay.
 */
export interface BuildStamp { build: number; sha: string; version: string }
export interface UpdateInfo {
  current: BuildStamp;
  latest: BuildStamp;
  platform: Platform;
  /** what «Обновить» does */
  action: 'reload' | 'download';
  /** download link for the apps */
  url?: string;
}

const RELEASE_API = 'https://api.github.com/repos/ClubGames/KHL_Manager/releases/tags/app';
const RECHECK_MS = 6 * 3600_000;

export function currentBuild(): BuildStamp | null {
  return typeof __KHL_BUILD__ !== 'undefined' && __KHL_BUILD__ && __KHL_BUILD__.build > 0 ? __KHL_BUILD__ : null;
}

/** «1.0.14» or «сборка 25.11.2026 (abc1234)» */
export function buildLabel(b: BuildStamp): string {
  if (b.version) return b.version;
  const d = new Date(b.build * 1000);
  const dd = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return `сборка ${dd}${b.sha ? ` (${b.sha})` : ''}`;
}

/** The stamp the release notes carry: `<!-- khl-build: 1764058000 abc1234 1.0.14 -->`. */
export function parseReleaseStamp(body: string | null | undefined): BuildStamp | null {
  const m = /khl-build:\s*(\d+)\s+([0-9a-f]*)\s*([\d.]*)/i.exec(body ?? '');
  return m ? { build: Number(m[1]), sha: m[2] ?? '', version: m[3] ?? '' } : null;
}

async function getJson(url: string): Promise<unknown> {
  if (typeof fetch !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 10_000) : null;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctl?.signal, headers: url.startsWith('https://api.github.com') ? { Accept: 'application/vnd.github+json' } : undefined });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function windowsPortable(): Promise<boolean> {
  try { return !!(await window.khlDesktop?.info())?.portable; } catch { return false; }
}

/** Newest build for this platform, or null (offline, dev server, nothing newer). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = currentBuild();
  if (!current) return null;
  const p = platform();
  let latest: BuildStamp | null = null;
  let assets: { name?: string; browser_download_url?: string }[] = [];
  if (p === 'web') {
    // The page's own folder: works for GitHub Pages and any copy of dist/ on another host (absent on the dev server).
    const j = (await getJson(`./version.json?t=${Date.now()}`)) as BuildStamp | null;
    if (j && typeof j.build === 'number') latest = { build: j.build, sha: String(j.sha ?? ''), version: String(j.version ?? '') };
  } else {
    const rel = (await getJson(RELEASE_API)) as { body?: string; assets?: { name?: string; browser_download_url?: string }[] } | null;
    assets = Array.isArray(rel?.assets) ? rel!.assets! : [];
    // Only the release itself is trusted: Pages is updated minutes before the new installers are uploaded.
    latest = parseReleaseStamp(rel?.body);
  }
  if (!latest || latest.build <= current.build) return null;
  if (p === 'web') return { current, latest, platform: p, action: 'reload' };
  const url = downloadUrl(p, await windowsPortable(), assets);
  return { current, latest, platform: p, action: 'download', url };
}

/** The file this app updates from: picked from the release's own files (by kind, not by exact name), so a renamed
 *  download never leaves an installed app with a dead link; the known address when the list is not available. */
export function downloadUrl(p: Platform, portable: boolean, assets: { name?: string; browser_download_url?: string }[]): string {
  const pattern = p === 'android' ? /\.apk$/i : portable ? /portable\.exe$/i : /setup\.exe$/i;
  const hit = assets.find(a => typeof a.name === 'string' && pattern.test(a.name) && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith('https://'));
  return hit?.browser_download_url ?? (p === 'android' ? APP_DOWNLOADS.android : portable ? APP_DOWNLOADS.windowsPortable : APP_DOWNLOADS.windowsSetup);
}

/** Do the update: reload the page (browser) or download the new installer / APK (apps). */
export function applyUpdate(u: UpdateInfo) {
  if (u.action === 'reload') {
    // a new address so no cache hands back the old single-file page
    const url = new URL(window.location.href);
    url.searchParams.set('v', String(u.latest.build));
    window.location.replace(url.toString());
    return;
  }
  if (!u.url) return;
  // Windows: the app hands https links to the default browser. Android: leaving the app's own origin opens the
  // system browser / download manager, which offers to install the APK.
  if (u.platform === 'android') window.location.href = u.url;
  else window.open(u.url, '_blank', 'noopener');
}

const DISMISS_KEY = 'khl.update.dismissed';
/** «Позже» hides this build's reminder for a day; a newer build asks again at once. */
export function dismissUpdate(u: UpdateInfo) {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify({ build: u.latest.build, until: Date.now() + 24 * 3600_000 })); } catch { /* private mode */ }
}
function dismissed(u: UpdateInfo): boolean {
  try {
    const d = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? 'null') as { build: number; until: number } | null;
    return !!d && d.build === u.latest.build && Date.now() < d.until;
  } catch {
    return false;
  }
}

/** Checks a few seconds after start-up and every six hours; `force` re-checks now (the settings button). */
export function useUpdateCheck() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    const run = () => void checkForUpdate().then((u) => { if (alive) { setInfo(u); setHidden(!!u && dismissed(u)); } });
    const first = setTimeout(run, 4000);
    const every = setInterval(run, RECHECK_MS);
    return () => { alive = false; clearTimeout(first); clearInterval(every); };
  }, []);
  return {
    info: hidden ? null : info,
    later: () => { if (info) dismissUpdate(info); setHidden(true); },
  };
}
