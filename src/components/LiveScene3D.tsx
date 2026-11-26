import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import type { Player, Team } from '../types';
import { clamp } from '../game/rinkPlayback';
import type { PlayerFigure } from './playerModel';
import { acquireRenderer, addStageLights, compileScene, kitFor, loadModel, officialKit, onCacheRedraw, releaseRenderer, sharedProps, takeArena, takeFigures, type FigureRequest } from './replayCache';
import { crewFor, type Official } from './officialCrew';
import { buildArenaShow } from './arenaShow';
import { INTRO_STRIDE, introCamera, introChapter, introOfficials, introPoses, introShotAt, introShow, planIntro, type IntroPlan, type IntroSkater } from './matchIntro';
import { celebrateCamera, GOAL_SHOW, goalReplay, MOMENT_GAP, momentReplay, pickMoment, replayAngle, replayCamera, replayLength, replayTau, type ReplaySpec } from './liveShow';
import { NET_X } from './replayMotion';
import { liveCameraPose, toWorld, ZOOM, type LiveCamera } from './replayCameras';
import { RINK } from '../game/rinkGeometry';
import { benchSeat, boxSeat, BENCH } from './arenaBenches';

export { LIVE_CAMERAS, type LiveCamera } from './replayCameras';
import { releaseHeading } from './replayMotion';
import { replayPreset, type ReplayQuality } from './ReplayScene';
import { LiveMotion, LOOKAHEAD, puckVelocity, shownSkaters, type LiveMotionLike, type LiveSource } from './liveMotion';

/**
 * The whole match in 3D, frame for frame the same hockey as the 2D rink: every render reads `ai.frameAt(tau)`
 * — the frame the 2D rink draws at that moment — so positions, the puck, line changes, faceoffs and whistles
 * can never drift apart. The players are the rigged figures of the goal replays (same cache: arena, kits and
 * compiled shaders are shared), posed from their motion: strides from the distance skated, lean in turns, the
 * blade on a carried puck, windups and follow-throughs of passes and shots, goalie saves, goal celebrations.
 */
const PUCK_R = .0381 * 1.25, PUCK_H = .0254 * 1.25;
const STRIDE = 3.3;
const angleLerp = (a: number, b: number, u: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * u; };
const angleDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
const smooth01 = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };

type Actor = {
  id: string; side: 0 | 1; goalie: boolean; group: T.Group; figure: PlayerFigure | null; standIn: T.Object3D;
  heading: number; phase: number; lx: number; lz: number; known: boolean;
  save: { x: number; y: number; z: number; tau: number } | null;
  /** off the ice: the seat he is on ('b3' bench, 'p1' penalty box) and when his seated pose was last refreshed */
  seat?: string; sitAt?: number;
  /** skating off to the bench / the penalty box (from where he left the ice) and stepping in — or back out onto the ice */
  off?: Trip; enter?: Trip;
  /** on the ice in the last picture (undefined: not known — the first picture, a new period) */
  on?: boolean;
};
/** A walk between the ice and a seat: from (fx, fz), through the door in the boards (or over the boards, `hop`). */
type Trip = { fx: number; fz: number; t0: number; hop: boolean; dur: number };
/** The door (or the top of the boards) a seat is reached through: on the ice edge in front of it. */
const doorOf = (seat: { x: number; z: number }) => ({ x: seat.x, z: Math.sign(seat.z) * (RINK.width / 2 - .45) });

/** What the 3D view tells the match loop: wait for the first picture, hold the clock (the entrance, a replay), play
 *  in real time (a goal celebration), and that it shows the goals' replays itself (no replay window then). */
export type LiveTicker = { tau?: number; wait?: boolean; hold?: boolean; slow?: boolean; shows?: boolean };
/** The broadcast captions over the picture. */
type Ui = { mode: 'intro' | 'celebrate' | 'replay'; title: string; name?: string; sub?: string; color?: string };
const SHOT_LABEL = { goalie: 'Вратарь', captain: 'Капитан', leader: 'Лидер команды' } as const;
const RE_LABEL = { goal: 'Повтор гола', save: 'Опасный момент', post: 'Штанга!', hit: 'Силовой приём', miss: 'Опасный момент' } as const;
type Props = {
  ai: LiveSource; ticker: LiveTicker; home: Team; away: Team; players: Record<string, Player>;
  /** everyone who may come on the ice (dressed players, both goalies): their figures are prepared up front */
  roster: FigureRequest[];
  camera: LiveCamera; quality: ReplayQuality;
  /** WebGL unavailable / context lost: the parent shows the 2D rink instead */
  onFail: () => void;
  /** the start of the match: the teams' entrance with the laser show plays first (once per rink) */
  intro?: boolean;
  /** goal celebrations with their replays, replays of big moments at stoppages */
  replays?: boolean;
};
/** Rinks whose entrance has been shown (switching the camera or the quality must not replay it). */
const introPlayed = new WeakSet<object>();

export function LiveScene3D(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ ai: props.ai, camera: props.camera, zoom: 1 });
  live.current.ai = props.ai; live.current.camera = props.camera;
  const [ready, setReady] = useState(false);
  const [introOn, setIntroOn] = useState(false);
  const [ui, setUi] = useState<Ui | null>(null);
  const skipIntro = useRef(false), skipShow = useRef(false);
  const introRef = useRef(props.intro); introRef.current = props.intro;
  const replaysRef = useRef(!!props.replays); replaysRef.current = !!props.replays;
  const failRef = useRef(props.onFail); failRef.current = props.onFail;
  const { quality } = props;
  // Clubs and players are read when the scene is built: a store update during the match must not rebuild it.
  const clubs = useRef({ home: props.home, away: props.away, players: props.players });
  clubs.current = { home: props.home, away: props.away, players: props.players };
  const matchKey = `${props.home.id}|${props.away.id}|${props.home.primaryColor}|${props.away.primaryColor}`;
  const tickerRef = useRef(props.ticker); tickerRef.current = props.ticker;
  const rosterRef = useRef(props.roster); rosterRef.current = props.roster;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const { home, away, players } = clubs.current;
    let renderer: T.WebGLRenderer | undefined;
    let stopped = false, raf = 0;
    const geometries: T.BufferGeometry[] = [], materials: T.Material[] = [];
    const unbind: (() => void)[] = [];
    const releases: (() => void)[] = [];
    let releaseArena = () => {};
    let observer: ResizeObserver | undefined;
    tickerRef.current.wait = true;
    // the teams' entrance: the match clock waits for it (from the first picture with the real figures)
    const introSource = live.current.ai;
    const introWanted = !!introRef.current && !introPlayed.has(introSource) && (tickerRef.current.tau ?? 0) < .01;
    if (introWanted) tickerRef.current.hold = true;
    tickerRef.current.shows = replaysRef.current;
    skipIntro.current = false; skipShow.current = false;
    const dispose = () => {
      tickerRef.current.wait = false; tickerRef.current.hold = false; tickerRef.current.slow = false; tickerRef.current.shows = false;
      stopped = true; cancelAnimationFrame(raf); observer?.disconnect(); unbind.forEach(f => f()); releases.forEach(f => f()); releaseArena();
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
      if (renderer) { renderer.domElement.remove(); releaseRenderer(renderer); }
    };
    try {
      const preset = replayPreset(quality);
      renderer = acquireRenderer();
      const maxRatio = preset.dpr(window.devicePixelRatio || 1);
      let ratio = maxRatio;
      renderer.setPixelRatio(ratio);
      renderer.domElement.setAttribute('aria-label', 'Матч в 3D');
      element.appendChild(renderer.domElement);
      const canvas = renderer.domElement;
      const lost = (e: Event) => { e.preventDefault(); if (!stopped) failRef.current(); };
      canvas.addEventListener('webglcontextlost', lost);
      unbind.push(() => canvas.removeEventListener('webglcontextlost', lost));
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(40, 2, .05, 220);
      const { sun, lamp, hemi, fill } = addStageLights(scene, preset.shadow, preset.radius);
      const lit = { hemi: hemi.intensity, sun: sun.intensity, fill: fill.intensity, env: scene.environmentIntensity };
      // the arena show: lasers, the ice projection, follow spots, the crowd's flashes
      const show = buildArenaShow([home.primaryColor, away.primaryColor], preset.detail);
      scene.add(show.group); unbind.push(() => show.dispose());
      const taken = takeArena(home, away, preset.detail, Math.min(preset.detail === 'hi' ? 16 : 8, renderer.capabilities.getMaxAnisotropy()));
      const arena = taken.arena;
      arena.iceReflection.texture.value = null; arena.iceReflection.strength.value = 0;
      scene.add(arena.group);
      // The bench: on the light preset the arena's low-poly players; above it the real figures of the dressed
      // players who are not on the ice sit there (and come and go with the line changes).
      const realBench = quality !== 'standard';
      arena.benchCrowd.visible = !realBench;
      releaseArena = () => { arena.benchCrowd.visible = true; arena.lights(1); taken.release(); };
      const benchUsed = [new Set<number>(), new Set<number>()];
      const frustum = new T.Frustum(), projView = new T.Matrix4(), seatBall = new T.Sphere(new T.Vector3(), 1.1);
      const leaveSeat = (a: Actor) => { if (a.seat?.startsWith('b')) benchUsed[a.side].delete(Number(a.seat.slice(1))); a.seat = undefined; a.figure?.castShadows(true); };
      const benchSlot = (a: Actor) => {
        if (a.seat?.startsWith('b')) return Number(a.seat.slice(1));
        leaveSeat(a);
        // fill from the middle of the bench out; the backup goalie at the far end
        const order = Array.from({ length: BENCH.slots }, (_, i) => i).sort((x, y) => Math.abs(x - 7.5) - Math.abs(y - 7.5));
        const slot = a.goalie ? (benchUsed[a.side].has(BENCH.slots - 1) ? order.find(i => !benchUsed[a.side].has(i)) : BENCH.slots - 1) : order.find(i => !benchUsed[a.side].has(i));
        const s = slot ?? 0; benchUsed[a.side].add(s); a.seat = `b${s}`; a.sitAt = undefined; return s;
      };
      let dirty = true;
      unbind.push(onCacheRedraw(() => { dirty = true; }));

      const propMats = sharedProps();
      const puckGeo = new T.CylinderGeometry(PUCK_R, PUCK_R, PUCK_H, 20), shadowGeo = new T.CircleGeometry(PUCK_R * 1.5, 16);
      geometries.push(puckGeo, shadowGeo);
      const puck = new T.Mesh(puckGeo, propMats.puck); puck.castShadow = true; scene.add(puck);
      const puckShadow = new T.Mesh(shadowGeo, propMats.puckShadow); puckShadow.rotation.x = -Math.PI / 2; scene.add(puckShadow);
      const trailGeo = new T.BufferGeometry().setFromPoints(Array.from({ length: 14 }, () => new T.Vector3())); geometries.push(trailGeo);
      const trail = new T.Line(trailGeo, propMats.trail); trail.frustumCulled = false; scene.add(trail);
      // The four officials (two referees, two linesmen): simple striped stand-ins until the rigged figures are in.
      const refMat = new T.MeshStandardMaterial({ color: '#16191f', roughness: .7 }), refShirt = new T.MeshStandardMaterial({ color: '#f1f3f5', roughness: .7 }), armMat = new T.MeshStandardMaterial({ color: '#ff6a1a', roughness: .6 });
      materials.push(refMat, refShirt, armMat);
      const offGeo = { legs: new T.CylinderGeometry(.15, .13, .85, 8), body: new T.CylinderGeometry(.24, .2, .62, 10), head: new T.SphereGeometry(.15, 10, 8), band: new T.CylinderGeometry(.25, .25, .08, 10) };
      geometries.push(...Object.values(offGeo));
      const officials = (['ref', 'ref', 'line', 'line'] as const).map(role => {
        const group = new T.Group(), standIn = new T.Group();
        const l = new T.Mesh(offGeo.legs, refMat); l.position.y = .45; const b = new T.Mesh(offGeo.body, refShirt); b.position.y = 1.18; const h = new T.Mesh(offGeo.head, refMat); h.position.y = 1.65;
        [l, b, h].forEach(m => { m.castShadow = true; standIn.add(m); });
        if (role === 'ref') { const band = new T.Mesh(offGeo.band, armMat); band.position.y = 1.36; standIn.add(band); }
        group.add(standIn); scene.add(group);
        return { role, group, standIn, figure: null as PlayerFigure | null, ph: 0, lx: NaN, lz: NaN };
      });
      const ownFigures: PlayerFigure[] = [];
      unbind.push(() => ownFigures.forEach(f => f.dispose()));
      // The played match: a ring on the ice under the skater the manager controls (and an arrow above him).
      const ringGeo = new T.RingGeometry(.52, .66, 40), arrowGeo = new T.ConeGeometry(.16, .3, 4);
      const ringMat = new T.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: .9, depthWrite: false, side: T.DoubleSide });
      geometries.push(ringGeo, arrowGeo); materials.push(ringMat);
      const ctrlRing = new T.Mesh(ringGeo, ringMat); ctrlRing.rotation.x = -Math.PI / 2; ctrlRing.renderOrder = 2;
      const ctrlArrow = new T.Mesh(arrowGeo, ringMat); ctrlArrow.rotation.x = Math.PI;
      ctrlRing.visible = ctrlArrow.visible = false; scene.add(ctrlRing, ctrlArrow);
      // The aim marker on the net (NHL style): where the manager's puck carrier would put a shot right now; it
      // grows and warms from yellow to red as the shot is loaded. Drawn over the net and the goalie.
      const aimGeo = new T.RingGeometry(.16, .25, 32), aimDot = new T.CircleGeometry(.06, 16);
      const aimMat = new T.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: .95, depthTest: false, depthWrite: false, side: T.DoubleSide });
      geometries.push(aimGeo, aimDot); materials.push(aimMat);
      const aimMark = new T.Group(); aimMark.add(new T.Mesh(aimGeo, aimMat), new T.Mesh(aimDot, aimMat));
      aimMark.children.forEach(m => { m.renderOrder = 10; }); aimMark.visible = false; scene.add(aimMark);
      const aimCold = new T.Color('#ffd23f'), aimHot = new T.Color('#ff3b30');
      // Whoever has the puck (either team): a cyan ring under him, wider than the manager's yellow one.
      const carrierGeo = new T.RingGeometry(.74, .9, 48);
      const carrierMat = new T.MeshBasicMaterial({ color: '#2ee6ff', transparent: true, opacity: .85, depthWrite: false, side: T.DoubleSide });
      geometries.push(carrierGeo); materials.push(carrierMat);
      const carrierRing = new T.Mesh(carrierGeo, carrierMat); carrierRing.rotation.x = -Math.PI / 2; carrierRing.renderOrder = 2; carrierRing.visible = false;
      scene.add(carrierRing);

      // Stand-ins (until the rigged model is decoded, or if it fails): a capsule in club colours.
      const standGeo = new T.CapsuleGeometry(.27, 1.05, 4, 10), helmetGeo = new T.SphereGeometry(.2, 10, 8);
      geometries.push(standGeo, helmetGeo);
      const kitMat = new Map<string, T.MeshStandardMaterial>();
      const kitMaterial = (color: string) => { let m = kitMat.get(color); if (!m) { m = new T.MeshStandardMaterial({ color, roughness: .6 }); materials.push(m); kitMat.set(color, m); } return m; };
      const actors = new Map<string, Actor>();
      let mod: Awaited<ReturnType<typeof loadModel>> | null = null;
      const actorFor = (id: string, side: 0 | 1, goalie: boolean): Actor => {
        let a = actors.get(id);
        if (a) return a;
        const team = side ? away : home, kit = kitFor(team, side, goalie, players[id]);
        const group = new T.Group(); scene.add(group);
        const standIn = new T.Group();
        const body = new T.Mesh(standGeo, kitMaterial(kit.jersey)); body.position.y = .82; body.castShadow = true;
        const helmet = new T.Mesh(helmetGeo, kitMaterial(kit.helmet)); helmet.position.y = 1.62; helmet.castShadow = true;
        standIn.add(body, helmet); group.add(standIn);
        a = { id, side, goalie, group, figure: null, standIn, heading: side ? Math.PI : 0, phase: Math.random() * 6, lx: NaN, lz: NaN, known: false, save: null };
        actors.set(id, a);
        if (mod) attach([a]);
        return a;
      };
      const attach = (list: Actor[]) => {
        if (!mod || !list.length) return;
        let t: ReturnType<typeof takeFigures>;
        try { t = takeFigures(mod.mod, mod.template, home, away, players, list.map(a => ({ id: a.id, side: a.side, goalie: a.goalie }))); } catch { return; }
        releases.push(t.release);
        t.figures.forEach((f, i) => { const a = list[i]; a.figure = f; a.group.add(f.root); a.standIn.visible = false; });
        dirty = true;
      };
      // Everyone dressed gets an actor (hidden until he steps on the ice), so the figures are built in one go.
      for (const r of rosterRef.current) actorFor(r.id, r.side, r.goalie);
      // The match clock waits for the first picture with the real figures (the match screen caps the wait).
      let figuresDone = false, readyRef = false;
      const figuresIn = () => { figuresDone = true; if (readyRef) tickerRef.current.wait = false; };
      loadModel().then(m => {
        if (stopped || !renderer) return;
        mod = m;
        const list = [...actors.values()].filter(a => !a.figure);
        // Build them into a staging scene and compile their shaders off the main thread before they appear.
        let t: ReturnType<typeof takeFigures>;
        try { t = takeFigures(m.mod, m.template, home, away, players, list.map(a => ({ id: a.id, side: a.side, goalie: a.goalie }))); } catch { figuresIn(); return; }
        releases.push(t.release);
        // the officials: their own figures (striped shirts, no stick), built with the players
        const offFigures = officials.map(o => { try { const f = new m.mod.PlayerFigure(m.template, officialKit(o.role)); f.root.rotation.y = Math.PI / 2; ownFigures.push(f); return f; } catch { return null; } });
        const go = () => {
          if (stopped) return;
          t.figures.forEach((f, i) => { const a = list[i]; a.figure = f; a.group.add(f.root); a.standIn.visible = false; });
          offFigures.forEach((f, i) => { if (!f) return; const o = officials[i]; o.figure = f; o.group.add(f.root); o.standIn.visible = false; });
          dirty = true; figuresIn();
        };
        const fresh = [...t.fresh, ...offFigures.filter((f): f is PlayerFigure => !!f)];
        if (!fresh.length) { go(); return; }
        const staging = new T.Scene(); fresh.forEach(f => staging.add(f.root));
        compileScene(renderer, staging, camera, scene, false).then(go);
      }).catch(() => { figuresIn(); /* stand-ins stay */ });

      let motion: LiveMotionLike | null = null, motionOf: LiveSource | null = null;
      const focus = { x: 0, z: 0, init: false };
      let lastTau = NaN, lastNow = performance.now(), lastCam = '', firstFrame = true;
      const puckWorld = new T.Vector3(), local = new T.Vector3(), puckOff = { x: 0, z: 0 };
      const aspect = () => camera.aspect;
      let settled = false, camSpeed = 0;
      // the captions over the picture: React state, set only when they change
      let uiKey = '';
      const showUi = (u: Ui | null) => { const k = u ? `${u.mode}|${u.title}|${u.name ?? ''}|${u.sub ?? ''}` : ''; if (k !== uiKey) { uiKey = k; setUi(u); } };
      const forget = () => { actors.forEach(a => { a.lx = NaN; a.save = null; a.on = undefined; a.off = a.enter = undefined; }); focus.init = false; lastTau = NaN; dirty = true; };
      // the teams' entrance (see matchIntro): everybody dressed skates out, the reserves end on their seats
      let intro: { t0: number; plan: IntroPlan; ids: Set<string> } | null = null, introStarted = false;
      const introSeats = new Map<string, number>();
      const mountAt = performance.now();
      const endIntro = () => {
        if (!intro) return;
        // the reserves keep the seats they skated to
        introSeats.forEach((slot, id) => { const a = actors.get(id); if (a && !a.seat) { a.seat = `b${slot}`; a.sitAt = undefined; } });
        introSeats.clear();
        intro = null; tickerRef.current.hold = false; setIntroOn(false); showUi(null);
        hemi.intensity = lit.hemi; sun.intensity = lit.sun; fill.intensity = lit.fill; scene.environmentIntensity = lit.env;
        officials.forEach(o => { o.lx = NaN; });
        forget();
      };
      unbind.push(() => { if (intro) endIntro(); });
      const beginIntro = (now: number, ai: LiveSource) => {
        introStarted = true; introPlayed.add(introSource);
        const f0 = ai.frameAt(tickerRef.current.tau ?? 0);
        const captains = [home.captainId ?? null, away.captainId ?? null];
        const list: IntroSkater[] = [], ids = new Set<string>();
        for (const p of shownSkaters(f0)) {
          if (ids.has(p.id)) continue;
          const w = toWorld(p.pos); ids.add(p.id);
          list.push({ id: p.id, side: p.side, goalie: !!p.goalie, start: true, x: w.x, z: w.z, captain: captains[p.side] === p.id, rating: players[p.id]?.overall });
          const a = actorFor(p.id, p.side, !!p.goalie); if (a.seat) leaveSeat(a);
        }
        for (const r of rosterRef.current) {
          if (ids.has(r.id)) continue;
          ids.add(r.id);
          const a = actorFor(r.id, r.side, r.goalie);
          let seat: IntroSkater['seat'] = null;
          // the higher presets seat the real figures: each reserve skates to the seat he keeps afterwards
          if (realBench) { const slot = benchSlot(a); introSeats.set(a.id, slot); a.seat = undefined; seat = benchSeat(r.side, slot); }
          else if (a.seat) leaveSeat(a);
          list.push({ id: r.id, side: r.side, goalie: r.goalie, start: false, x: 0, z: 0, seat, captain: captains[r.side] === r.id, rating: players[r.id]?.overall });
        }
        intro = { t0: now, plan: planIntro(list), ids };
        actors.forEach(a => { a.off = a.enter = undefined; a.on = undefined; a.lx = NaN; });
        setIntroOn(true);
      };

      // The broadcast between the plays (see liveShow): a goal — the celebration in close-up, then its replay; a
      // stoppage after a big moment — its replay. The replays read the rink's own frames again; the clock holds.
      type Tv = { kind: 'goal' | 'moment'; phase: 'celebrate' | 'replay'; t0: number; spec: ReplaySpec; goalTau: number };
      let tv: Tv | null = null, lastAngle = '';
      const seenGoals = new Set<number>();
      let lastMomentClock = -Infinity, stopSeen = NaN, stopChecked = false;
      const tvFocus = { x: 0, z: 0, init: false };
      const startReplay = () => { tickerRef.current.hold = true; tickerRef.current.slow = false; lastAngle = ''; tvFocus.init = false; forget(); };
      const endTv = () => { tv = null; tickerRef.current.hold = false; tickerRef.current.slow = false; showUi(null); forget(); };
      unbind.push(() => { if (tv) endTv(); });
      // the officials as they were (a replay shows them where they stood then)
      const crewHist: { tau: number; crew: Official[] }[] = [];
      const recordCrew = (tau: number, crew: readonly Official[]) => {
        const last = crewHist.at(-1);
        if (last && tau < last.tau) crewHist.length = 0;
        if (last && tau - last.tau < .04) return;
        crewHist.push({ tau, crew: crew.map(o => ({ role: o.role, x: o.x, z: o.z, vx: o.vx, vz: o.vz, heading: o.heading, phase: o.phase, gesture: o.gesture, gt: o.gt, aim: o.aim ? { ...o.aim } : null })) });
        while (crewHist.length > 2 && tau - crewHist[0].tau > 24) crewHist.shift();
      };
      const crewAt = (tau: number): readonly Official[] => {
        if (!crewHist.length) return crewFor(live.current.ai).officials;
        let lo = 0, hi = crewHist.length - 1;
        if (tau <= crewHist[0].tau) return crewHist[0].crew;
        if (tau >= crewHist[hi].tau) return crewHist[hi].crew;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (crewHist[m].tau <= tau) lo = m; else hi = m; }
        const a = crewHist[lo], b = crewHist[hi], u = (tau - a.tau) / (b.tau - a.tau || 1);
        return a.crew.map((o, i) => { const q = b.crew[i]; return { ...o, x: o.x + (q.x - o.x) * u, z: o.z + (q.z - o.z) * u, heading: angleLerp(o.heading, q.heading, u), phase: o.phase + (q.phase - o.phase) * u, gt: o.gt + (tau - a.tau) }; });
      };
      const goalPlay = (ai: LiveSource, tau: number) => { for (let i = ai.plays.length - 1; i >= 0; i--) { const p = ai.plays[i]; if (p.kind === 'goal' && Math.abs(p.tau - tau) < 1e-6) return p; if (p.tau < tau - 1) break; } return undefined; };

      const update = (now: number) => {
        if (!renderer) return;
        const ai = live.current.ai;
        if (introWanted && !introStarted && (figuresDone || now - mountAt > 8000)) beginIntro(now, ai);
        if (intro && (skipIntro.current || (now - intro.t0) / 1000 >= intro.plan.t.length)) endIntro();
        if (intro) dirty = true;
        if (!motion || motionOf !== ai) { motion = ai.motion ?? new LiveMotion(ai); motionOf = ai; focus.init = false; actors.forEach(a => { a.lx = NaN; a.save = null; a.on = undefined; a.off = a.enter = undefined; }); if (tv) endTv(); crewHist.length = 0; }
        const liveTau = tickerRef.current.tau ?? 0;
        if (tv && (skipShow.current || !replaysRef.current)) endTv();
        skipShow.current = false;
        if (replaysRef.current && !intro && (introStarted || !introWanted)) {
          // a goal just scored: the celebration (the match plays on in real time), then its replay
          const g = tv ? null : motion.goalAt(liveTau);
          if (g && !seenGoals.has(g.tau)) {
            seenGoals.add(g.tau);
            if (liveTau - g.tau < 1.5) {
              const p = goalPlay(ai, g.tau);
              tv = { kind: 'goal', phase: 'celebrate', t0: now, spec: goalReplay(g.tau, g.netX, p?.text ?? 'ГОЛ!', p?.player), goalTau: g.tau };
              tickerRef.current.slow = true; tvFocus.init = false;
            }
          }
          if (tv?.phase === 'celebrate' && (liveTau >= tv.goalTau + GOAL_SHOW.celebrate || now - tv.t0 > 7000)) { tv.phase = 'replay'; tv.t0 = now; startReplay(); }
          // a stoppage: a replay of the big moment just before the whistle (now and then)
          if (!tv) {
            const fl = ai.frameAt(liveTau);
            if (!fl.stopped) stopSeen = NaN;
            else if (Number.isNaN(stopSeen)) { stopSeen = liveTau; stopChecked = false; }
            else if (!stopChecked && liveTau - stopSeen > .9) {
              stopChecked = true;
              const clock = ai.clockAt?.(liveTau) ?? NaN;
              const due = Number.isNaN(clock) || clock - lastMomentClock >= MOMENT_GAP || clock < lastMomentClock;
              if (due && !(ai as { ended?: boolean }).ended && !motion.goalAt(liveTau)) {
                const m = pickMoment(ai.plays, stopSeen - 9, stopSeen + .3);
                if (m) {
                  const pk = toWorld(ai.frameAt(m.tau).puck);
                  tv = { kind: 'moment', phase: 'replay', t0: now, spec: momentReplay(m, Math.sign(pk.x || 1) * NET_X, stopSeen + .8), goalTau: NaN };
                  if (!Number.isNaN(clock)) lastMomentClock = clock;
                  startReplay();
                }
              }
            }
          }
        }
        let tau = liveTau;
        if (tv?.phase === 'replay') {
          const real = (now - tv.t0) / 1000;
          if (real >= replayLength(tv.spec)) endTv(); else tau = replayTau(tv.spec, real);
        }
        const replaying = tv?.phase === 'replay';
        if (tv) dirty = true;
        const realDt = Math.min(.1, (now - lastNow) / 1000); lastNow = now;
        const camKey = `${live.current.camera}|${live.current.zoom}|${camera.aspect}`;
        // Paused (or a whistle with nothing moving) and the camera at rest: nothing to draw.
        if (tau === lastTau && camKey === lastCam && !dirty && settled) return;
        lastCam = camKey; dirty = false;
        const dTau = Number.isNaN(lastTau) ? 0 : clamp(tau - lastTau, 0, .6);
        lastTau = tau;
        // Simulate a little ahead (windups start before the release), then read the frame both rinks show.
        ai.ensure(tau + LOOKAHEAD);
        motion.update(); motion.prune(tau);
        const f = ai.frameAt(tau), fb = ai.frameAt(tau - .1), fb2 = ai.frameAt(tau - .2);
        const pw = toWorld(f.puck);
        puck.position.set(pw.x, Math.max(0, pw.y) + PUCK_H / 2, pw.z); puckShadow.position.set(pw.x, .012, pw.z); puckShadow.visible = pw.y > .03;
        puckWorld.copy(puck.position);
        const pv = puckVelocity(ai, tau), pSpeed = Math.hypot(pv.x, pv.z);
        const tr = trailGeo.getAttribute('position');
        for (let i = 0; i < 14; i++) { const v = toWorld(ai.frameAt(tau - i * .012).puck); tr.setXYZ(i, v.x, Math.max(0, v.y) + PUCK_H, v.z); }
        tr.needsUpdate = true; trail.visible = pSpeed > 14;
        // the officials: positions and signals from the crew both rinks share
        let crew: readonly Official[];
        if (replaying) crew = crewAt(tau);
        else { crew = crewFor(ai).update(f, ai.plays, tau); recordCrew(tau, crew); }
        crew.forEach((c, i) => {
          const o = officials[i];
          o.group.position.set(c.x, 0, c.z); o.group.rotation.set(0, c.heading, 0);
          if (!o.figure) return;
          o.group.updateMatrixWorld(true);
          const aim = c.aim ? o.figure.root.worldToLocal(new T.Vector3(c.aim.x, 1.2, c.aim.z)) : null;
          const look = angleDiff(c.heading, Math.atan2(-(pw.z - c.z), pw.x - c.x));
          o.figure.officiate({ phase: c.phase, amp: clamp(Math.hypot(c.vx, c.vz) / 6, 0, 1), gesture: c.gesture, t: c.gt, aim, look });
        });

        const goal = motion.goalAt(tau);
        lamp.intensity = goal && tau - goal.tau < 3 ? 14 : 0;
        if (goal) lamp.position.set(goal.netX + Math.sign(goal.netX) * 1.6, 2.6, 0);

        const shown = shownSkaters(f);
        const ctl = shown.find(p => p.ctrl);
        const am = ai.aimMarker?.() ?? null;
        aimMark.visible = !!am;
        if (am) {
          // a hair in front of the goal line, toward the shooter
          aimMark.position.set(am.x - Math.sign(am.x) * .06, clamp(am.y, .08, 1.12), am.z);
          aimMark.scale.setScalar(1 + am.charge * .45 + Math.sin(now / 140) * .05);
          aimMat.color.copy(aimCold).lerp(aimHot, am.charge);
        }
        ctrlRing.visible = ctrlArrow.visible = !!ctl;
        if (ctl) { const c = toWorld(ctl.pos); ctrlRing.position.set(c.x, .015, c.z); ctrlArrow.position.set(c.x, 2.35 + Math.sin(now / 180) * .06, c.z); ctrlArrow.rotation.y = now / 600; }
        const holder = f.carrier && !f.stopped ? shown.find(p => p.id === f.carrier && !p.goalie) : undefined;
        carrierRing.visible = !!holder;
        if (holder) { const c = toWorld(holder.pos); carrierRing.position.set(c.x, .017, c.z); const pulse = 1 + Math.sin(now / 160) * .05; carrierRing.scale.set(pulse, pulse, 1); }
        const onIce = new Set(shown.map(p => p.id));
        // Off the ice: the penalty box (everyone, every preset) or the bench (the real figures on the higher presets).
        const boxCount = [0, 0], boxOf = new Map<string, number>();
        for (const p of f.skaters) if (p.box) { boxOf.set(p.id, boxCount[p.side]++); actorFor(p.id, p.side, !!p.goalie); }
        const dressed = new Set(rosterRef.current.map(r => r.id));
        actors.forEach(a => {
          if (intro?.ids.has(a.id)) return; // the entrance poses everybody itself
          if (onIce.has(a.id)) {
            // back onto the ice: out of the seat, through the door (over the boards from the bench)
            if (a.on === false) {
              // from his seat, from where he was going, or (the light preset seats nobody) from the bench
              const p = a.seat || a.off ? a.group.position : { x: BENCH.x[a.side] + (a.phase % 1 - .5) * 4, z: BENCH.seatZ };
              a.enter = { fx: p.x, fz: p.z, t0: now, hop: !a.seat?.startsWith('p') && p.z < 0, dur: 750 };
            }
            a.on = true; a.off = undefined;
            if (a.seat) { leaveSeat(a); a.lx = NaN; }
            return;
          }
          // just left the ice (the frame before he was on it): he skates the rest of the way himself
          const wasOn = a.on === true && !Number.isNaN(a.lx);
          const from = { x: a.lx, z: a.lz };
          a.lx = NaN; a.on = false;
          const box = boxOf.get(a.id);
          let seat: ReturnType<typeof benchSeat> | null = null;
          if (box !== undefined) { const key = `p${box}`; if (a.seat !== key) { leaveSeat(a); a.seat = key; a.sitAt = undefined; } seat = boxSeat(a.side, box); }
          else if (realBench && dressed.has(a.id)) seat = benchSeat(a.side, benchSlot(a));
          else if (a.seat) leaveSeat(a);
          if (wasOn) {
            const target = seat ?? (box === undefined ? { x: BENCH.x[a.side], z: BENCH.seatZ } : boxSeat(a.side, 0));
            const door = doorOf(target);
            a.off = { fx: from.x, fz: from.z, t0: now, hop: box === undefined && !!seat, dur: clamp(Math.hypot(door.x - from.x, door.z - from.z) / 6.5, .2, 1.6) * 1000 + (seat ? 600 : 0) };
          }
          if (a.off) {
            // the trip: to the door at skating speed, then through it (or over the boards) onto the seat
            const tr = a.off, target = seat ?? (box === undefined ? { x: BENCH.x[a.side], y: 0, z: BENCH.seatZ } : boxSeat(a.side, 0)), door = doorOf(target);
            const u = (now - tr.t0) / tr.dur;
            if (u < 1) {
              const split = seat ? 1 - 600 / tr.dur : 1;
              let x: number, y = 0, z: number, head: number;
              if (u < split) { const v = smooth01(u / split * .85 + .15 * (u / split)); x = tr.fx + (door.x - tr.fx) * v; z = tr.fz + (door.z - tr.fz) * v; head = Math.atan2(-(door.z - tr.fz), door.x - tr.fx); }
              else { const v = smooth01((u - split) / (1 - split)); x = door.x + (target.x - door.x) * v; z = door.z + (target.z - door.z) * v; y = (tr.hop ? Math.sin(Math.PI * v) * .95 : 0) + (seat?.y ?? 0) * v; head = angleLerp(Math.atan2(-(target.z - door.z), target.x - door.x), seat?.heading ?? 0, v * v); }
              a.group.visible = true; a.group.position.set(x, y, z); a.group.rotation.set(0, head, 0);
              if (a.figure) { a.phase += realDt * 6; a.group.updateMatrixWorld(true); a.figure.skate(a.phase, u < split ? .8 : .3, undefined, 0, { bank: 0 }); a.figure.castShadows(true); }
              a.sitAt = undefined;
              return;
            }
            a.off = undefined;
          }
          if (!seat) { a.group.visible = false; return; }
          a.group.visible = true;
          a.group.position.set(seat.x, seat.y, seat.z); a.group.rotation.set(0, seat.heading, 0);
          if (!a.figure) return;
          // the seated pose follows the play a few times a second (and the bench gets up for its team's goal)
          if (a.sitAt !== undefined && now - a.sitAt < 220 + (a.phase % 1) * 160) return;
          if (a.sitAt === undefined) a.figure.castShadows(false);
          a.sitAt = now;
          const up = goal && goal.side === a.side && box === undefined ? clamp((tau - goal.tau) / .5, 0, 1) * (1 - smooth01((tau - goal.tau - 4) / 1.2)) : 0;
          a.group.updateMatrixWorld(true);
          a.figure.sit({ seat: BENCH.seatTop, look: clamp(angleDiff(seat.heading, Math.atan2(-(pw.z - seat.z), pw.x - seat.x)), -1.1, 1.1), up });
        });
        const prevOf = new Map(fb.skaters.map(p => [p.id, p.pos])), prev2Of = new Map(fb2.skaters.map(p => [p.id, p.pos]));
        const alpha = 1 - Math.exp(-dTau * 9);
        let carrierW = 0;
        const poses: { figure: PlayerFigure; args: Parameters<PlayerFigure['skate']> ; w: number; carrier: boolean }[] = [];
        const gp = goal ? goalPlay(ai, goal.tau) : undefined;
        for (const p of shown) {
          if (intro?.ids.has(p.id)) continue;
          const a = actorFor(p.id, p.side, !!p.goalie);
          const w = toWorld(p.pos), b = toWorld(prevOf.get(p.id) ?? p.pos), b2 = toWorld(prev2Of.get(p.id) ?? prevOf.get(p.id) ?? p.pos);
          a.group.visible = true;
          // stepping onto the ice from a seat: through the door / over the boards, then he blends into his track
          let lift = 0;
          if (a.enter) {
            const tr = a.enter, u = (now - tr.t0) / tr.dur;
            if (u >= 1) a.enter = undefined;
            else {
              const door = doorOf({ x: tr.fx, z: tr.fz });
              if (u < .45) { const v = smooth01(u / .45); w.x = tr.fx + (door.x - tr.fx) * v; w.z = tr.fz + (door.z - tr.fz) * v; lift = tr.hop ? Math.sin(Math.PI * v) * .95 : 0; }
              else { const v = smooth01((u - .45) / .55); w.x = door.x + (w.x - door.x) * v; w.z = door.z + (w.z - door.z) * v; }
            }
          }
          a.group.position.set(w.x, lift, w.z);
          a.group.rotation.order = 'YXZ';
          const jumped = Number.isNaN(a.lx) || Math.hypot(w.x - a.lx, w.z - a.lz) > 4;
          const moved = Math.hypot(w.x - b.x, w.z - b.z), speed = moved / .1;
          if (!jumped) a.phase += Math.hypot(w.x - a.lx, w.z - a.lz) / STRIDE * Math.PI * 2;
          a.lx = w.x; a.lz = w.z;
          const facePuck = Math.atan2(-(pw.z - w.z), pw.x - w.x);
          if (a.goalie) {
            // Faces out of his net, turned a little toward the puck.
            const out = w.x > 0 ? Math.PI : 0, body = out + clamp(angleDiff(out, facePuck), -.6, .6);
            a.heading = jumped ? body : angleLerp(a.heading, body, Math.max(alpha, .25));
            a.group.rotation.set(0, a.heading, 0);
            if (!a.figure) continue;
            a.group.updateMatrixWorld(true);
            const lateral = ((w.x - b.x) * -Math.sin(a.heading) + (w.z - b.z) * -Math.cos(a.heading)) / .1 / 2.2;
            // A fast puck coming at him: he reaches for the point where it passes him; the reaction fades after.
            const rx = w.x - pw.x, rz = w.z - pw.z, along = pSpeed > 0 ? (rx * pv.x + rz * pv.z) / pSpeed : 0;
            const lat = pSpeed > 0 ? Math.abs(rx * pv.z - rz * pv.x) / pSpeed : 99;
            if (pSpeed > 9 && along > -.3 && along < 12 && lat < 2.4) a.save = { x: pw.x + pv.x / pSpeed * along, y: Math.max(0, pw.y), z: pw.z + pv.z / pSpeed * along, tau: tau + along / pSpeed };
            let save: T.Vector3 | null = null, saveWeight = 0;
            if (a.save) {
              const sec = tau - a.save.tau;
              saveWeight = sec < 0 ? smooth01((sec + .3) / .22) : sec < .3 ? 1 : 1 - smooth01((sec - .3) / .45);
              if (sec > .8) a.save = null; else save = a.figure.root.worldToLocal(new T.Vector3(a.save.x, a.save.y, a.save.z));
            }
            const pl = a.figure.root.worldToLocal(local.copy(puckWorld)).clone(), pd = Math.hypot(pl.x, pl.z);
            const carrier = f.carrier ? shown.find(s => s.id === f.carrier) : undefined;
            const attacker = !!carrier && carrier.side !== a.side;
            const pokeWeight = attacker && pw.y < .2 && pl.z > .4 && pd < 2.8 ? smooth01((2.8 - pd) / 1.0) * .85 : 0;
            const drop = Math.max(!attacker && pw.y < .3 && pl.z > -.3 && pd < 2.2 ? .6 * smooth01((2.2 - pd) / .8) : 0, save && a.save && a.save.y < .45 ? saveWeight * .8 : 0);
            a.figure.goalie({ drop, lateral: clamp(lateral, -1, 1), save, saveWeight, poke: pl, pokeWeight, look: clamp(angleDiff(a.heading, facePuck), -1.2, 1.2) });
            continue;
          }
          // Heading: the rink AI's own facing (forward along the motion, backwards facing the puck when he retreats,
          // to the puck when standing — the blade, and the puck on it, are where the 2D rink has them); turned to the
          // target in a release.
          const motionDir = Math.atan2(-(w.z - b.z), w.x - b.x);
          let target = p.dir ? Math.atan2(-p.dir.y, p.dir.x) : angleLerp(facePuck, motionDir, smooth01(moved / .35));
          const hand: 1 | -1 = players[p.id]?.hand === 'L' ? -1 : 1;
          const rel = motion.releaseAt(p.id, tau);
          let turnAway = 0;
          if (rel) {
            const aim = releaseHeading(rel.rel, w.x, w.z, hand, rel.s > 0 ? clamp(rel.s / .5, 0, 1) : 0);
            turnAway = rel.aim * smooth01(Math.abs(angleDiff(target, aim)) / 1.5);
            target = angleLerp(target, aim, rel.aim);
          }
          a.heading = jumped || firstFrame ? target : angleLerp(a.heading, target, Math.max(alpha, rel ? .35 : 0));
          // knocked down (the rink's fall 0…1: tipping over, down, getting up): on his back, face first, or sideways
          // over the hip; the body rests on the ice a little above the skates' pivot
          const fall = p.fall ?? 0, fk = p.fallKind ?? 'back';
          // a spin-o-rama: the whole body turns a full circle (toward his backhand side) and comes out facing ahead again
          const spinYaw = p.move === 'spin' ? -hand * Math.PI * 2 * smooth01(p.moveT ?? 0) : 0;
          a.group.rotation.set(fk === 'back' ? -fall * 1.38 : fk === 'front' ? fall * 1.3 : -fall * .25, a.heading + spinYaw, fk === 'side' ? (p.fallSide ?? 1) * fall * 1.42 : 0);
          if (fall > 0) a.group.position.y = .1 * Math.sin(fall * Math.PI / 2);
          if (!a.figure) { a.group.position.y = Math.abs(Math.sin(a.phase)) * .04 * clamp(speed / 7, 0, 1); continue; }
          a.group.updateMatrixWorld(true);
          const h1 = Math.atan2(-(b.z - b2.z), b.x - b2.x), h2 = motionDir;
          const turn = moved > .3 ? angleDiff(h1, h2) / .1 : 0;
          const bank = clamp(turn * speed * .03, -.4, .4);
          const amp = clamp(speed / 7, 0, 1) * (1 - .4 * (rel?.aim ?? 0) - .45 * turnAway);
          const shot = rel && rel.s >= -1 && rel.s <= 1.9 ? rel.s : undefined;
          const cheer = goal && goal.side === p.side ? clamp((tau - goal.tau) / .3, 0, 1) * (1 - smooth01((tau - goal.tau - 4) / 1.5)) * (gp?.player === p.id ? 1 : .7) : 0;
          // the scorer himself: a fist pump, and (some of them) down on one knee sliding
          let pump = 0, kneel = 0;
          if (goal && gp?.player === p.id) {
            const gt = tau - goal.tau, style = [...p.id].reduce((h, c) => h + c.charCodeAt(0), 0) % 2;
            pump = smooth01((gt - .45) / .3) * (1 - smooth01((gt - 3.6) / .6));
            if (style) kneel = smooth01((gt - .3) / .35) * (1 - smooth01((gt - 2.4) / .5));
          }
          local.copy(puckWorld); a.figure.root.worldToLocal(local);
          let reach: T.Vector3 | null = null, reachWeight = 0;
          const near = Math.hypot(local.x + .3 * hand, local.z - .85);
          if (p.move === 'reach' && pw.y < .4 && local.z > .2 && Math.hypot(local.x, local.z) < 2.8) reach = local.clone();
          if (pw.y < .25 && local.z > .1 && local.z < 1.8 && Math.abs(local.x) < 1.3 && near < 1.4 && !(shot !== undefined && shot > 0)) {
            reachWeight = (f.carrier === p.id ? 1 : .6) * (1 - smooth01((near - .55) / .85));
            carrierW = Math.max(carrierW, reachWeight);
            reach = local.clone();
          }
          poses.push({ figure: a.figure, args: [a.phase, amp * (1 - fall), shot, cheer, { bank, reach, reachWeight, kind: rel?.rel.kind, deke: p.deke, check: p.check, poke: p.poke, move: p.move, moveT: p.moveT, stagger: p.stagger, down: fall, pump, kneel, t: tau - (goal?.tau ?? 0), stance: p.stance, stanceT: p.stanceT, handle: p.handle, now: tau }], w: reachWeight, carrier: f.carrier === p.id });
        }
        let blade: { x: number; z: number; w: number } | null = null;
        for (const { figure, args, w, carrier } of poses) {
          const o = args[4]!;
          figure.skate(args[0], args[1], args[2], args[3], { ...o, reachWeight: w >= carrierW - 1e-6 ? w : w * .35 });
          if (carrier && w > 0) { figure.bladeWorld(local); blade = { x: local.x, z: local.z, w }; }
        }
        // The carried puck sits on the blade of the 3D stick (the stick cups the rink AI's puck; what is left of the
        // gap goes to the puck). A pass or a shot leaves from there and the offset fades out within a few frames.
        const off = blade && Math.hypot(blade.x - pw.x, blade.z - pw.z) < 1 ? { x: (blade.x - pw.x) * smooth01(blade.w * 1.4), z: (blade.z - pw.z) * smooth01(blade.w * 1.4) } : { x: 0, z: 0 };
        const kOff = blade ? 1 : 1 - Math.exp(-dTau * 14);
        puckOff.x += (off.x - puckOff.x) * kOff; puckOff.z += (off.z - puckOff.z) * kOff;
        if (Math.abs(puckOff.x) + Math.abs(puckOff.z) > 1e-4) {
          puck.position.x = pw.x + puckOff.x; puck.position.z = pw.z + puckOff.z;
          puckShadow.position.x = puck.position.x; puckShadow.position.z = puck.position.z;
        }
        firstFrame = false;
        // The entrance: everybody dressed skates out on his own route (the rink waits at its first frame)
        const it = intro ? (now - intro.t0) / 1000 : -1;
        const ip = intro ? introPoses(intro.plan, it) : null;
        if (intro && ip) {
          const plan = intro.plan;
          for (const s of plan.skaters) {
            const a = actors.get(s.id), p = ip.get(s.id);
            if (!a || !p) continue;
            a.group.visible = p.visible;
            if (!p.visible) { a.lx = NaN; continue; }
            const fresh = Number.isNaN(a.lx), moved = fresh ? 0 : Math.hypot(p.x - a.lx, p.z - a.lz);
            // long, easy strides: the stride phase from the distance skated
            a.phase += moved / INTRO_STRIDE * Math.PI * 2; a.lx = p.x; a.lz = p.z;
            const turn = fresh || realDt <= 0 ? 0 : angleDiff(a.heading, p.heading) / realDt;
            a.group.position.set(p.x, p.y, p.z); a.group.rotation.set(0, p.heading, 0); a.heading = p.heading;
            if (!a.figure) continue;
            a.group.updateMatrixWorld(true);
            if (p.sit) { a.figure.sit({ seat: BENCH.seatTop, look: 0 }); continue; }
            if (s.goalie && p.speed < .5) a.figure.goalie({ drop: 0, look: 0 });
            else a.figure.skate(a.phase, clamp(p.speed / 9, 0, 1), undefined, p.wave, { bank: clamp(turn * p.speed * .03, -.3, .3), shake: p.shake, t: it });
          }
          const crewNow = crewFor(ai).officials;
          introOfficials(plan, it, crewNow.map(c => ({ x: c.x, z: c.z }))).forEach((p, i) => {
            const o = officials[i];
            o.group.visible = p.visible; o.group.position.set(p.x, 0, p.z); o.group.rotation.set(0, p.heading, 0);
            const moved = Number.isNaN(o.lx) ? 0 : Math.hypot(p.x - o.lx, p.z - o.lz); o.lx = p.x; o.lz = p.z; o.ph += moved / 3.4 * Math.PI * 2;
            if (!o.figure) return;
            o.group.updateMatrixWorld(true);
            o.figure.officiate({ phase: o.ph, amp: clamp(p.speed / 6, 0, 1), gesture: p.gesture, t: it, look: 0 });
          });
          puck.visible = puckShadow.visible = trail.visible = false; carrierRing.visible = ctrlRing.visible = ctrlArrow.visible = aimMark.visible = false;
          // the captions: the chapter, and whose close-up it is
          const shot = introShotAt(plan, it), who = shot ? players[shot.id] : undefined;
          const team = shot ? (shot.side ? away : home) : null;
          showUi({ mode: 'intro', title: introChapter(plan, it), name: who ? `${who.number ? `#${who.number} ` : ''}${who.name}` : undefined, sub: shot && team ? `${SHOT_LABEL[shot.kind]} · ${team.name}` : undefined, color: team?.primaryColor });
        } else {
          puck.visible = true; officials.forEach(o => { o.group.visible = true; });
          if (replaying) { carrierRing.visible = ctrlRing.visible = ctrlArrow.visible = aimMark.visible = false; }
        }
        const sh = intro && ip ? introShow(intro.plan, it, ip) : null;
        const L = sh?.level ?? 0;
        // a home goal: the arena lights flash and the lasers fire for a few seconds
        const party = !intro && goal && goal.side === 0 ? Math.max(0, Math.sin(Math.PI * clamp((tau - goal.tau) / 4.5, 0, 1))) : 0;
        if (intro) { hemi.intensity = lit.hemi * (1 - .9 * L); sun.intensity = lit.sun * (1 - .88 * L); fill.intensity = lit.fill * (1 - .92 * L); scene.environmentIntensity = lit.env * (1 - .88 * L); }
        show.update(now, { level: Math.max(L, party * .55), team: sh?.team ?? 0, focus: sh?.focus ?? { x: goal ? goal.netX * .6 : 0, z: 0 }, burst: Math.max(sh?.burst ?? 0, party), flashes: 1, scale: renderer.domElement.height / (2 * Math.tan(T.MathUtils.degToRad(camera.fov) / 2)) });
        if (party > 0) dirty = true;
        // Camera: follows a smoothed point of play, slightly ahead of the puck, in real time (not rink time).
        const lead = { x: pw.x + clamp(pv.x * .25, -4, 4), z: pw.z };
        if (!focus.init) { focus.x = lead.x; focus.z = lead.z; focus.init = true; }
        else { const k = 1 - Math.exp(-realDt * 2.6); focus.x += (lead.x - focus.x) * k; focus.z += (lead.z - focus.z) * k; }
        camSpeed += (Math.min(pSpeed, 30) - camSpeed) * (1 - Math.exp(-realDt * 1.6));
        settled = Math.hypot(lead.x - focus.x, lead.z - focus.z) < .01 && Math.abs(Math.min(pSpeed, 30) - camSpeed) < .05;
        const pose = liveCameraPose(live.current.camera, focus, live.current.zoom, aspect(), { attack: ai.attack ?? (ai.flipped ? -1 : 1), speed: camSpeed });
        if (tv) {
          // the broadcast's own pictures: the scorer in close-up, the replay's angles (smoothed on the puck, cut between angles)
          let c;
          if (tv.phase === 'celebrate') {
            const sc = shown.find(p => p.id === tv!.spec.player) ?? shown.filter(p => goal && p.side === goal.side && !p.goalie).sort((p, q) => { const a = toWorld(p.pos), b = toWorld(q.pos); return Math.hypot(a.x - pw.x, a.z - pw.z) - Math.hypot(b.x - pw.x, b.z - pw.z); })[0];
            const w = sc ? toWorld(sc.pos) : pw;
            if (!tvFocus.init) { tvFocus.x = w.x; tvFocus.z = w.z; tvFocus.init = true; }
            else { const k = 1 - Math.exp(-realDt * 5); tvFocus.x += (w.x - tvFocus.x) * k; tvFocus.z += (w.z - tvFocus.z) * k; }
            c = celebrateCamera((now - tv.t0) / 1000, tvFocus);
          } else {
            const angle = replayAngle(tv.spec, tau);
            if (angle !== lastAngle) { lastAngle = angle; tvFocus.init = false; }
            if (!tvFocus.init) { tvFocus.x = pw.x; tvFocus.z = pw.z; tvFocus.init = true; }
            else { const k = 1 - Math.exp(-realDt * 4.5); tvFocus.x += (pw.x - tvFocus.x) * k; tvFocus.z += (pw.z - tvFocus.z) * k; }
            c = replayCamera(tv.spec, tau, tvFocus);
          }
          pose.pos = c.pos; pose.look = c.look; pose.fov = c.fov;
          const who = tv.spec.player ? players[tv.spec.player] : undefined, side = goal?.side;
          const team = tv.kind === 'goal' && side !== undefined ? (side ? away : home) : null;
          if (tv.phase === 'celebrate') showUi({ mode: 'celebrate', title: 'ГОЛ!', name: who ? `${who.number ? `#${who.number} ` : ''}${who.name}` : tv.spec.text.replace(/^ГОЛ!\s*/, ''), sub: team?.name, color: team?.primaryColor });
          else showUi({ mode: 'replay', title: RE_LABEL[tv.spec.kind], name: tv.kind === 'goal' ? (who ? `${who.number ? `#${who.number} ` : ''}${who.name}` : undefined) : tv.spec.text });
        }
        if (intro && sh) {
          // the entrance's own camera, handing over to the match camera as everybody skates to his place
          const ic = introCamera(intro.plan, it, ip!), k = smooth01((it - intro.plan.t.settle - .3) / 2.2);
          pose.pos = { x: ic.pos.x + (pose.pos.x - ic.pos.x) * k, y: ic.pos.y + (pose.pos.y - ic.pos.y) * k, z: ic.pos.z + (pose.pos.z - ic.pos.z) * k };
          pose.look = { x: ic.look.x + (pose.look.x - ic.look.x) * k, y: ic.look.y + (pose.look.y - ic.look.y) * k, z: ic.look.z + (pose.look.z - ic.look.z) * k };
          pose.fov = ic.fov + (pose.fov - ic.fov) * k;
        }
        camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
        camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
        if (Math.abs(camera.fov - pose.fov) > .01) { camera.fov = pose.fov; camera.updateProjectionMatrix(); }
        camera.updateMatrixWorld(); arena.view(camera); arena.tick(now); arena.lights(1 - .88 * L);
        // the skinned figures are never culled by three: the seated ones out of the picture are skipped here
        frustum.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        actors.forEach(a => { if (a.seat) { seatBall.center.set(a.group.position.x, .8, a.group.position.z); a.group.visible = frustum.intersectsSphere(seatBall); } });
        sun.position.set(pose.look.x + 8, 25, pose.look.z + 12); sun.target.position.set(pose.look.x, 0, pose.look.z); sun.target.updateMatrixWorld();
        camera.updateMatrixWorld();
        // the aim marker always faces the camera (seen from the side the net's plane would hide it)
        if (aimMark.visible) aimMark.quaternion.copy(camera.quaternion);
        renderer.render(scene, camera);
        if (!readyRef) { readyRef = true; setReady(true); if (figuresDone) tickerRef.current.wait = false; }
      };
      const resize = () => {
        if (!renderer) return;
        const w = Math.max(1, element.clientWidth), h = Math.max(1, element.clientHeight);
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
      };
      observer = new ResizeObserver(resize); observer.observe(element); resize();
      // The mouse on the ice (the played match aims with it): a screen point → rink percent, through the camera.
      const ray = new T.Raycaster(), ice = new T.Plane(new T.Vector3(0, 1, 0), 0), hit = new T.Vector3(), ndc = new T.Vector2();
      const pick = (cx: number, cy: number) => {
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        if (!ray.ray.intersectPlane(ice, hit)) return null;
        return { x: clamp(hit.x / RINK.length * 100 + 50, 0, 100), y: clamp(hit.z / RINK.width * 100 + 50, 0, 100) };
      };
      const src = live.current.ai;
      src.screenPick = pick;
      unbind.push(() => { if (src.screenPick === pick) src.screenPick = null; });
      // Adaptive resolution: step down only while frames are really slow for a while, back up with headroom.
      // Measured against the display's own refresh (a 60 Hz screen never draws faster than 16.7 ms — it used to
      // never earn its sharpness back after one slow moment, e.g. a rush up the ice), and never below the
      // screen's native pixels on a desktop (a blurry picture there is worse than a dropped frame).
      const desktop = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(pointer: coarse)').matches;
      const floor = desktop ? Math.max(preset.minDpr, Math.min(maxRatio, 1)) : preset.minDpr;
      let slow = 0, fast = 0, prevNow = 0, base = 16.7, lowered = 0;
      const tick = (now: number) => {
        if (stopped) return;
        const dt = now - prevNow; prevNow = now;
        try { update(now); } catch (e) { console.error(e); failRef.current(); return; }
        if (preset.adaptive && dt > 0 && dt < 250) {
          // the refresh interval: the quickest frames seen (slowly forgiving, a monitor can change)
          base = Math.min(base * 1.0005, Math.max(4, dt));
          if (dt > Math.max(base * 1.7, 26)) { slow++; fast = Math.max(0, fast - 2); } else if (dt < base * 1.2) { fast++; slow = Math.max(0, slow - 1); } else { slow = Math.max(0, slow - 1); }
          if (renderer && slow > 45 && ratio > floor && now - lowered > 2000) { ratio = Math.max(floor, ratio - .15); renderer.setPixelRatio(ratio); resize(); slow = 0; fast = 0; lowered = now; }
          else if (renderer && fast > 120 && ratio < maxRatio) { ratio = Math.min(maxRatio, ratio + .15); renderer.setPixelRatio(ratio); resize(); fast = 0; }
        }
        raf = requestAnimationFrame(tick);
      };
      // The arena's shaders compile in the background; the first frame waits for them (at most 3 s).
      let started = false;
      const start = () => { if (started || stopped) return; started = true; raf = requestAnimationFrame(tick); };
      compileScene(renderer, scene, camera, null, false).finally(start);
      const giveUp = setTimeout(start, 3000); unbind.push(() => clearTimeout(giveUp));
      // Zoom: mouse wheel and two-finger pinch.
      const setZoom = (z: number) => { live.current.zoom = clamp(z, ZOOM.min, ZOOM.max); };
      const wheel = (e: WheelEvent) => { e.preventDefault(); setZoom(live.current.zoom * Math.exp(clamp(e.deltaY, -200, 200) * .0015)); };
      let pinch = 0;
      const span2 = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const touchStart = (e: TouchEvent) => { if (e.touches.length === 2) pinch = span2(e); };
      const touchMove = (e: TouchEvent) => { if (e.touches.length === 2 && pinch > 0) { e.preventDefault(); const d = span2(e); setZoom(live.current.zoom * pinch / d); pinch = d; } };
      const touchEnd = () => { pinch = 0; };
      canvas.addEventListener('wheel', wheel, { passive: false });
      canvas.addEventListener('touchstart', touchStart, { passive: true });
      canvas.addEventListener('touchmove', touchMove, { passive: false });
      canvas.addEventListener('touchend', touchEnd);
      unbind.push(() => { canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('touchstart', touchStart); canvas.removeEventListener('touchmove', touchMove); canvas.removeEventListener('touchend', touchEnd); });
    } catch {
      dispose(); failRef.current();
      return;
    }
    return dispose;
  }, [matchKey, quality]);

  return <div className="absolute inset-0" data-live-3d={ready ? 'ready' : 'loading'}>
    <div ref={host} className="w-full h-full" />
    {!ready && <div className="absolute inset-0 flex items-center justify-center text-xs text-white/70 bg-[#081421]">Загрузка 3D…</div>}
    {/* the broadcast's captions: a lower third (the entrance's chapters and close-ups, the scorer), the replay bug */}
    {(introOn || ui) && <div className="absolute inset-0 pointer-events-none z-20" data-live-intro={introOn || undefined} data-live-show={ui && ui.mode !== 'intro' ? ui.mode : undefined}>
      {ui?.mode === 'replay' && <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-sm bg-black/60 px-2 py-1 text-[11px] font-black uppercase tracking-[.18em] text-white backdrop-blur-sm">
        <i className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />Повтор
      </div>}
      <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-1.5 px-3">
        {ui && (ui.name || ui.mode !== 'intro') && <div className="flex items-stretch max-w-[92%] overflow-hidden rounded-sm shadow-lg" data-live-caption>
          <span className="px-2.5 py-1 text-xs sm:text-sm font-black uppercase tracking-wide text-white" style={{ background: ui.color ?? (ui.mode === 'replay' ? '#b91c1c' : '#0f2a44') }}>{ui.title}</span>
          {ui.name && <span className="px-2.5 py-1 bg-black/70 text-white text-xs sm:text-sm font-semibold truncate backdrop-blur-sm">{ui.name}{ui.sub && <span className="ml-2 text-white/60 font-normal text-[11px]">{ui.sub}</span>}</span>}
        </div>}
        {introOn && !(ui && ui.name) && <span className="text-[11px] font-bold uppercase tracking-[.2em] text-white/90 drop-shadow">{ui?.title ?? 'Выход команд'}</span>}
        {introOn
          ? <button type="button" onClick={() => { skipIntro.current = true; }} className="pointer-events-auto rounded-sm bg-black/55 hover:bg-black/75 text-white text-xs font-semibold px-3 py-1 backdrop-blur-sm" data-live-intro-skip>Пропустить ▸</button>
          : ui && <button type="button" onClick={() => { skipShow.current = true; }} className="pointer-events-auto rounded-sm bg-black/55 hover:bg-black/75 text-white text-xs font-semibold px-3 py-1 backdrop-blur-sm" data-live-show-skip>Пропустить ▸</button>}
      </div>
    </div>}
  </div>;
}
