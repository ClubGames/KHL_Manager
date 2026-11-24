import { useCallback, useEffect, useState, type RefObject } from 'react';
import { platform } from './platform';

/**
 * Fullscreen API with the WebKit prefixes (Safari on iPad/macOS, older Android browsers).
 * iPhone Safari has no element fullscreen at all: there the game goes fullscreen when it is added to the home screen
 * (see the web app manifest / apple-mobile-web-app-capable meta in index.html), and the 3D replay falls back to
 * filling the visible viewport.
 */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void };

const doc = () => (typeof document === 'undefined' ? null : (document as FsDocument));

export function fullscreenElement(): Element | null {
  const d = doc();
  return d ? (d.fullscreenElement ?? d.webkitFullscreenElement ?? null) : null;
}

export function fullscreenSupported(el?: HTMLElement | null): boolean {
  const d = doc();
  if (!d) return false;
  // The Android app is always full screen (system bars hidden natively); its WebView has no element fullscreen,
  // so the replay uses the same «fill the viewport» mode as iPhone Safari.
  if (platform() === 'android') return false;
  const target = (el ?? d.documentElement) as FsElement;
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? false;
  return !!enabled && !!(target.requestFullscreen || target.webkitRequestFullscreen);
}

/** Launched from the home screen / installed: the browser UI is already gone. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (platform() === 'android') return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  const mq = (q: string) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  return nav.standalone === true || mq('(display-mode: fullscreen)') || mq('(display-mode: standalone)');
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function enterFullscreen(el?: HTMLElement | null): Promise<boolean> {
  const d = doc();
  if (!d) return false;
  const target = (el ?? d.documentElement) as FsElement;
  try {
    if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
    else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    else return false;
  } catch {
    return false;
  }
  // Phones: the game is landscape-first, so keep it there while fullscreen (Android Chrome allows this only now).
  const orientation = (screen as Screen & { orientation?: ScreenOrientation & { lock?: (o: string) => Promise<void> } }).orientation;
  const phone = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  if (phone && orientation?.lock) orientation.lock('landscape').catch(() => {});
  return true;
}

export async function exitFullscreen(): Promise<void> {
  const d = doc();
  if (!d || !fullscreenElement()) return;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* already left (Esc / system gesture) */
  }
}

/**
 * Fullscreen state of one element (or of the whole page when no ref is given).
 * `active` is true only while that element is the fullscreen element.
 */
export function useFullscreen(target?: RefObject<HTMLElement | null>) {
  const el = () => target?.current ?? doc()?.documentElement ?? null;
  const [active, setActive] = useState(() => !!fullscreenElement() && fullscreenElement() === el());
  useEffect(() => {
    const d = doc();
    if (!d) return;
    const sync = () => setActive(!!fullscreenElement() && fullscreenElement() === el());
    sync();
    d.addEventListener('fullscreenchange', sync);
    d.addEventListener('webkitfullscreenchange', sync);
    return () => {
      d.removeEventListener('fullscreenchange', sync);
      d.removeEventListener('webkitfullscreenchange', sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const toggle = useCallback(async () => {
    if (fullscreenElement() === el()) {
      await exitFullscreen();
      return true;
    }
    return enterFullscreen(el());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return { active, toggle, supported: fullscreenSupported(el() as HTMLElement | null) };
}
