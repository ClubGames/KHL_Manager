import * as T from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { Player, Team } from '../types';
import { getClubLogoSources, getOfficialClubPalette, hexLuminance } from '../game/clubColors';
import { buildArena, type Arena } from './replayArena';
import type { Kit, PlayerFigure } from './playerModel';

/**
 * Everything the 3D goal replay can keep between two replays, so the next one opens at once:
 *  - ONE WebGL renderer (one GL context: no context creation, and the compiled shader programs survive);
 *  - the image-based lighting (PMREM of the room environment);
 *  - the static arena of the current match (ice markings, crowd and board canvases are painted once);
 *  - the rigged player figures of the current match and the club crests.
 * The cache belongs to one pair of clubs: a replay of another match drops it. When no replay has used it for
 * a while (and nothing holds it), it is freed together with the GL context.
 */

const IDLE_MS = 120_000;

type ArenaEntry = { arena: Arena; inUse: boolean };
type FigureEntry = { figure: PlayerFigure; inUse: boolean };
type Shared = {
  renderer: T.WebGLRenderer; envMap: T.Texture; users: number; idle: ReturnType<typeof setTimeout> | null;
  match: string; arenas: Map<string, ArenaEntry>; figures: Map<string, FigureEntry>; crests: Map<string, T.MeshBasicMaterial>; crestTextures: T.Texture[];
  /** redraw requests of the mounted scenes (a logo texture finished loading) */
  redraw: Set<() => void>;
  /** puck, its shadow, the trail and the ice mirror: same for every replay (their shaders stay compiled) */
  props: { puck: T.MeshStandardMaterial; puckShadow: T.MeshStandardMaterial; trail: T.LineBasicMaterial } | null;
  reflector: Reflector | null;
};

let shared: Shared | null = null;

const notify = () => shared?.redraw.forEach(f => f());

function disposeMatch(s: Shared) {
  s.arenas.forEach(a => a.arena.dispose()); s.arenas.clear();
  s.figures.forEach(f => { f.figure.root.removeFromParent(); f.figure.dispose(); }); s.figures.clear();
  s.crests.forEach(m => m.dispose()); s.crests.clear();
  s.crestTextures.forEach(t => t.dispose()); s.crestTextures = [];
}

function disposeAll() {
  const s = shared;
  if (!s) return;
  shared = null;
  if (s.idle) clearTimeout(s.idle);
  disposeMatch(s);
  s.envMap.dispose();
  if (s.props) Object.values(s.props).forEach(m => m.dispose());
  if (s.reflector) { s.reflector.geometry.dispose(); (s.reflector.material as T.Material).dispose(); s.reflector.dispose(); }
  s.renderer.dispose(); s.renderer.forceContextLoss(); s.renderer.domElement.remove();
}

/** The shared renderer; every acquire needs a release. Throws when WebGL is not available. */
export function acquireRenderer(): T.WebGLRenderer {
  if (!shared) {
    if (typeof window === 'undefined' || (typeof window.WebGLRenderingContext === 'undefined' && typeof window.WebGL2RenderingContext === 'undefined')) throw new Error('WebGL unavailable');
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace;
    // Neutral tone mapping keeps the club colours true (ACES shifts reds and blues).
    renderer.toneMapping = T.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
    renderer.setClearColor('#081421');
    renderer.domElement.setAttribute('aria-label', 'Объёмная реконструкция голевого эпизода');
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
    // A lost context takes every GPU resource with it: start from scratch next time.
    renderer.domElement.addEventListener('webglcontextlost', () => { if (shared?.renderer === renderer) { shared = null; } });
    // Image-based lighting: soft arena reflections on helmets, visors, the goal frame and the boards.
    const pmrem = new T.PMREMGenerator(renderer), room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, .04).texture; pmrem.dispose(); room.dispose?.();
    shared = { renderer, envMap, users: 0, idle: null, match: '', arenas: new Map(), figures: new Map(), crests: new Map(), crestTextures: [], redraw: new Set(), props: null, reflector: null };
  }
  shared.users++;
  if (shared.idle) { clearTimeout(shared.idle); shared.idle = null; }
  return shared.renderer;
}

export function releaseRenderer(renderer: T.WebGLRenderer) {
  const s = shared;
  if (!s || s.renderer !== renderer) { // the context was lost meanwhile: this renderer is no longer shared
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    return;
  }
  s.users = Math.max(0, s.users - 1);
  if (s.users === 0 && !s.idle) s.idle = setTimeout(disposeAll, IDLE_MS);
}

export function sharedEnvMap(): T.Texture | null { return shared?.envMap ?? null; }

/** Materials of the puck, its shadow and the trail (needs an acquired renderer). */
export function sharedProps() {
  const s = shared!;
  if (!s.props) s.props = {
    puck: new T.MeshStandardMaterial({ color: '#07090d', roughness: .45 }),
    puckShadow: new T.MeshStandardMaterial({ color: '#0b1622', roughness: .65, transparent: true, opacity: .35, depthWrite: false }),
    trail: new T.LineBasicMaterial({ color: '#efad3d', transparent: true, opacity: .7 }),
  };
  return s.props;
}

/** Planar ice mirror (high/ultra), rendered at a fraction of the screen resolution (needs an acquired renderer). */
export function sharedReflector(): Reflector {
  const s = shared!;
  if (!s.reflector) {
    const r = new Reflector(new T.PlaneGeometry(60, 30), { textureWidth: 512, textureHeight: 256, clipBias: .003, multisample: 0 });
    r.rotation.x = -Math.PI / 2; r.position.y = .001; r.updateMatrixWorld(true);
    s.reflector = r;
  }
  return s.reflector;
}

/**
 * Compiles every shader the scene needs ahead of its first frame, off the main thread where the browser
 * supports it — also the variants for the ice mirror's render target (no tone mapping there).
 */
export function compileScene(renderer: T.WebGLRenderer, scene: T.Object3D, camera: T.Camera, target: T.Scene | null, mirror: boolean): Promise<void> {
  const jobs = [renderer.compileAsync(scene, camera, target)];
  if (mirror) {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(sharedReflector().getRenderTarget());
    try { jobs.push(renderer.compileAsync(scene, camera, target)); } finally { renderer.setRenderTarget(previous); }
  }
  return Promise.all(jobs).then(() => undefined, () => undefined);
}

export function onCacheRedraw(fn: () => void) { shared?.redraw.add(fn); return () => { shared?.redraw.delete(fn); }; }

/** Switches the cache to the clubs of this match (dropping figures and arenas of another one). */
function useMatch(home: Team, away: Team) {
  const s = shared!;
  const key = `${home.id}|${away.id}|${home.primaryColor}|${away.primaryColor}`;
  if (s.match !== key) { disposeMatch(s); s.match = key; }
  return s;
}

/** Static arena of the match; `release` puts it back (it stays built for the next replay). */
export function takeArena(home: Team, away: Team, detail: 'normal' | 'hi', anisotropy: number): { arena: Arena; release: () => void } {
  const s = useMatch(home, away);
  const entry = s.arenas.get(detail);
  if (entry && !entry.inUse) { entry.inUse = true; return { arena: entry.arena, release: () => { entry.inUse = false; entry.arena.group.removeFromParent(); } }; }
  const bench = (team: Team, side: 0 | 1) => { const k = kitFor(team, side, false); return { jersey: k.jersey, trim: k.trim, pants: k.pants, socks: k.socks, helmet: k.helmet, glove: k.glove }; };
  const arena = buildArena(new T.Group(), home, away, anisotropy, notify, { detail, benchKits: [bench(home, 0), bench(away, 1)] });
  arena.group.removeFromParent();
  if (entry) return { arena, release: () => arena.dispose() }; // a second scene at the same time: its own copy
  const own: ArenaEntry = { arena, inUse: true };
  s.arenas.set(detail, own);
  return { arena, release: () => { own.inUse = false; arena.group.removeFromParent(); } };
}

/** Club crest material for jerseys and helmets (the logo texture loads once per match). */
function crestFor(team: Team): T.MeshBasicMaterial {
  const s = shared!;
  let m = s.crests.get(team.id);
  if (m) return m;
  const material = new T.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, alphaTest: .05 });
  material.visible = false; m = material; s.crests.set(team.id, material);
  const sources = getClubLogoSources(team), loader = new T.TextureLoader(), owner = s;
  const next = (i: number) => {
    if (i >= sources.length) return;
    loader.load(sources[i], tex => {
      if (shared !== owner || owner.crests.get(team.id) !== material) { tex.dispose(); return; }
      tex.colorSpace = T.SRGBColorSpace; owner.crestTextures.push(tex); material.map = tex; material.visible = true; material.needsUpdate = true; notify();
    }, undefined, () => next(i + 1));
  };
  next(0);
  return m;
}

const contrast = (a: string, b: string) => Math.abs(hexLuminance(a) - hexLuminance(b)) > 70;

/** Club kit for the rigged models: home in club colours, visitors in white with club trim (as on the 2D rink). */
export function kitFor(team: Team, side: 0 | 1, goalie: boolean, player?: Player, crest?: T.Material): Kit {
  const primary = team.primaryColor, secondary = team.secondaryColor, accent = getOfficialClubPalette(team)?.accentColor ?? '#141414';
  const dark = hexLuminance(primary) < 90 ? primary : hexLuminance(accent) < 90 ? accent : hexLuminance(secondary) < 90 ? secondary : '#161c26';
  const name = player?.name ? player.name.trim().split(/\s+/).pop() : undefined;
  const number = player ? String(player.number) : '';
  if (side === 0) {
    const trim2 = contrast(accent, primary) && accent.toLowerCase() !== secondary.toLowerCase() ? accent : contrast(primary, '#ffffff') ? '#ffffff' : '#141414';
    const fill = hexLuminance(primary) > 170 ? dark : '#ffffff';
    return { jersey: primary, trim: secondary, trim2, pants: dark, socks: primary, sockTrim: secondary, helmet: primary,
      glove: dark === primary ? secondary : primary, number, name, numberFill: fill, numberStroke: contrast(secondary, fill) ? secondary : dark, goalie, pads: '#f4f6f8', crest, hand: player?.hand };
  }
  const ink = hexLuminance(primary) < 200 ? primary : dark;
  const trim2 = hexLuminance(secondary) < 200 && secondary.toLowerCase() !== ink.toLowerCase() ? secondary : accent;
  return { jersey: '#f4f7fa', trim: ink, trim2, pants: dark, socks: '#f4f7fa', sockTrim: ink, helmet: '#f4f7fa', glove: ink,
    number, name, numberFill: ink, numberStroke: '#ffffff', goalie, pads: '#f4f6f8', crest, hand: player?.hand };
}

export type FigureRequest = { id: string; side: 0 | 1; goalie: boolean };
type Model = typeof import('./playerModel');
let model: Promise<{ mod: Model; template: Awaited<ReturnType<Model['loadPlayerTemplate']>> }> | null = null;
let loaded = false;
/** The rigged model is decoded already (figures can be had right away). */
export const modelLoaded = () => loaded;
/** Loaded on demand (keeps the GLB out of node-side imports of the replay components). */
export function loadModel() {
  if (!model) {
    model = import('./playerModel').then(mod => mod.loadPlayerTemplate().then(template => { loaded = true; return { mod, template }; }));
    model.catch(() => { model = null; });
  }
  return model;
}

const figureKey = (r: FigureRequest, hand?: string) => `${r.id}|${r.side}|${r.goalie ? 'g' : 's'}|${hand ?? 'L'}`;

/**
 * Rigged figures for the tracks (cached per player). `fresh` lists the ones built just now (their shaders are
 * not compiled yet); `release` hands them back to the cache.
 */
export function takeFigures(mod: Model, template: Awaited<ReturnType<Model['loadPlayerTemplate']>>, home: Team, away: Team, players: Record<string, Player>, requests: FigureRequest[]) {
  const s = useMatch(home, away);
  const figures: PlayerFigure[] = [], fresh: PlayerFigure[] = [], taken: FigureEntry[] = [], owned: PlayerFigure[] = [];
  for (const r of requests) {
    const key = figureKey(r, players[r.id]?.hand);
    let entry = s.figures.get(key);
    if (entry && !entry.inUse) { entry.inUse = true; taken.push(entry); figures.push(entry.figure); continue; }
    const team = r.side === 0 ? home : away;
    const figure = new mod.PlayerFigure(template, kitFor(team, r.side, r.goalie, players[r.id], crestFor(team)));
    figure.root.rotation.y = Math.PI / 2; // model faces +z, replay bodies face +x
    fresh.push(figure); figures.push(figure);
    if (entry) owned.push(figure); // used by another scene right now: a private copy
    else { entry = { figure, inUse: true }; s.figures.set(key, entry); taken.push(entry); }
  }
  const owner = s;
  return {
    figures, fresh,
    release: () => {
      taken.forEach(e => { e.inUse = false; e.figure.root.removeFromParent(); });
      owned.forEach(f => { f.root.removeFromParent(); f.dispose(); });
      if (shared !== owner) taken.forEach(e => e.figure.dispose());
    },
  };
}

/** The lights of the replay arena (also used to compile shaders ahead with the exact same light setup). */
export function addStageLights(scene: T.Scene, shadowSize: number, shadowRadius: number) {
  scene.fog = new T.Fog('#081421', 70, 150);
  scene.add(new T.HemisphereLight('#e6f4ff', '#26384c', 1.5));
  const env = sharedEnvMap();
  if (env) { scene.environment = env; scene.environmentIntensity = .45; }
  // One shadow-casting key light that follows the play (tight, sharp shadow map) and a fill.
  const sun = new T.DirectionalLight('#fff7e9', 2.9); sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize); sun.shadow.radius = shadowRadius; sun.shadow.camera.left = -16; sun.shadow.camera.right = 16; sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 60; sun.shadow.normalBias = .03; sun.shadow.bias = -.0005;
  scene.add(sun); scene.add(sun.target);
  const fill = new T.DirectionalLight('#dbe8ff', .9); fill.position.set(-14, 20, -18); scene.add(fill);
  // Goal lamp behind the net (switched on when the puck goes in).
  const lamp = new T.PointLight('#ff2847', 0, 15); scene.add(lamp);
  return { sun, fill, lamp };
}

const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 400 }); else setTimeout(fn, 30);
};

/**
 * Prepares the replays of a match in the background: the arena and the players' figures are built in small
 * idle-time steps and their shaders compiled ahead, so the first goal replay opens without a wait.
 * Returns a cancel function that also lets the cache go idle.
 */
export function prewarmReplays(opts: { home: Team; away: Team; players: Record<string, Player>; figures: FigureRequest[]; detail: 'normal' | 'hi' }): () => void {
  let cancelled = false, renderer: T.WebGLRenderer | null = null;
  const done = () => { if (renderer) { const r = renderer; renderer = null; releaseRenderer(r); } };
  idle(() => {
    if (cancelled) return;
    try { renderer = acquireRenderer(); } catch { return; }
    const r = renderer;
    const { arena, release: releaseArena } = takeArena(opts.home, opts.away, opts.detail, Math.min(opts.detail === 'hi' ? 16 : 8, r.capabilities.getMaxAnisotropy()));
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(40, 16 / 9, .05, 200);
    addStageLights(scene, 1024, 1);
    scene.add(arena.group);
    const finish = () => { releaseArena(); done(); };
    loadModel().then(({ mod, template }) => {
      const queue = opts.figures.filter(f => opts.players[f.id]).slice();
      const releases: (() => void)[] = [];
      const step = () => {
        if (cancelled || !shared || shared.renderer !== r) { releases.forEach(f => f()); finish(); return; }
        // A few figures per idle slice (~5–10 ms each on a desktop).
        for (const req of queue.splice(0, 3)) {
          const t = takeFigures(mod, template, opts.home, opts.away, opts.players, [req]);
          t.figures.forEach(f => scene.add(f.root));
          releases.push(t.release);
        }
        if (queue.length) { idle(step); return; }
        compileScene(r, scene, camera, null, opts.detail === 'hi').finally(() => { releases.forEach(f => f()); finish(); });
      };
      idle(step);
    }, finish);
  });
  return () => { cancelled = true; };
}
