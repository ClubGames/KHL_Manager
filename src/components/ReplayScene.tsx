import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import * as T from 'three';
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { Player, Team } from '../types';
import { attackDir, clamp, samplePath, sampleSmooth, type Key, type ReplayClip } from '../game/rinkPlayback';
import { clipFrame, RinkSvg } from './RinkView';
import type { PlayerFigure } from './playerModel';
import { acquireRenderer, addStageLights, compileScene, loadModel, modelLoaded, onCacheRedraw, releaseRenderer, sharedProps, sharedReflector, takeArena, takeFigures } from './replayCache';
import { cameraPose, toWorld, viewFor, ZOOM, type ReplayCamera, type ReplayView } from './replayCameras';
import type { ReplayFrameSource } from './replayExport';

export { broadcastFocus, CAMERAS, autoCamera, viewFor, VIEW_LABEL, ZOOM, type ReplayCamera, type ReplayView } from './replayCameras';
export { kitFor } from './replayCache';

/**
 * `time` is the replay position (0…1). While `playing`, the scene runs its own requestAnimationFrame loop
 * (rendering every display frame, independent of React) and reports the position back through `onTime`
 * about ten times a second; a new `seek` (slider, restart) adopts `time` at once.
 */
type Props = {
  /** `time` is adopted whenever `seek` changes (and on mount); progress reports carry the seek they belong to. */
  clip: ReplayClip; time: number; seek?: number; camera: ReplayCamera; home: Team; away: Team; players: Record<string, Player>;
  playing?: boolean; speed?: number; zoom?: number; onTime?: (time: number, seek: number) => void; onZoom?: (zoom: number) => void;
  /** Controls that only make sense for the 3D picture (camera label, zoom); hidden in the SVG fallback. */
  overlay?: ReactNode;
  quality?: ReplayQuality;
  /** Filled with an offline frame renderer (for the MP4 export) while the WebGL scene is alive. */
  exporter?: MutableRefObject<ReplayFrameSource | null>;
  /** 3D turned off in the settings: the episode on the 2D rink, no WebGL at all */
  flat?: boolean;
  /** the 3D picture is ready (shaders compiled, first frame drawn) */
  onReady?: (ready: boolean) => void;
};

/**
 * Picture quality presets. standard: the light setup for phones; high: sharper (supersampled on 1× screens),
 * soft 2048 shadows, ice reflections, double-resolution arena textures; ultra: 2–2.5× supersampling, 4096
 * shadows, full-resolution reflections, no adaptive downscaling.
 */
export type ReplayQuality = 'standard' | 'high' | 'ultra';
export const QUALITY_LABEL: Record<ReplayQuality, string> = { standard: 'Стандарт', high: 'Высокое', ultra: 'Ультра' };
const QUALITY: Record<ReplayQuality, { dpr: (d: number) => number; minDpr: number; shadow: number; radius: number; reflect: number; detail: 'normal' | 'hi'; adaptive: boolean }> = {
  standard: { dpr: d => Math.min(d, 1.5), minDpr: .6, shadow: 1024, radius: 1, reflect: 0, detail: 'normal', adaptive: true },
  high: { dpr: d => Math.min(2, Math.max(1.25, d)), minDpr: 1, shadow: 2048, radius: 2.5, reflect: .5, detail: 'hi', adaptive: true },
  ultra: { dpr: d => Math.min(2.5, Math.max(2, d)), minDpr: 2, shadow: 4096, radius: 3, reflect: 1, detail: 'hi', adaptive: false },
};
/** The quality from the settings; «auto»: high on desktops, standard on touch devices. */
export function resolveReplayQuality(q: ReplayQuality | 'auto' = 'auto'): ReplayQuality {
  if (q !== 'auto') return q;
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'standard' : 'high';
}
/** Arena texture detail of a preset (also used by the background preparation of replays). */
export const arenaDetail = (q: ReplayQuality) => QUALITY[q].detail;

/** Real puck: 7.62 cm × 2.54 cm, drawn 1.25× so it still reads on a phone-sized broadcast shot. */
const PUCK_R = .0381 * 1.25, PUCK_H = .0254 * 1.25;
const STRIDE = 3.3; // metres per full stride cycle (left + right push)

/** Cumulative skating distance along a track (metres), sampled finely so the stride follows real speed. */
function distanceTable(keys: Key[], samples = 240) {
  const out = new Float32Array(samples + 1);
  let prev = toWorld(sampleSmooth(keys, 0));
  for (let i = 1; i <= samples; i++) {
    const p = toWorld(sampleSmooth(keys, i / samples));
    out[i] = out[i - 1] + Math.hypot(p.x - prev.x, p.z - prev.z); prev = p;
  }
  return (t: number) => { const f = clamp(t, 0, 1) * samples, i = Math.min(samples - 1, Math.floor(f)); return out[i] + (out[i + 1] - out[i]) * (f - i); };
}
const angleLerp = (a: number, b: number, u: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * u; };
const angleDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
const smooth01 = (v: number) => { const t = clamp(v, 0, 1); return t * t * (3 - 2 * t); };

/** Real perspective geometry, lighting and depth testing, not CSS-transformed sprites. */
export function ReplayScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<((time: number) => void) | null>(null);
  const [failed, setFailed] = useState(false);
  const [rigged, setRigged] = useState(false);
  const { clip, home, away, players } = props;
  const quality = props.quality ?? 'standard';
  // Live values read by the render loop (no React re-render per frame).
  const live = useRef({ time: props.time, seek: props.seek ?? 0, camera: props.camera, zoom: props.zoom ?? 1, failed: false });
  live.current.camera = props.camera;
  const callbacks = useRef({ onTime: props.onTime, onZoom: props.onZoom, onReady: props.onReady });
  callbacks.current = { onTime: props.onTime, onZoom: props.onZoom, onReady: props.onReady };
  const draw = useRef(0);
  const requestDraw = () => {
    if (draw.current || typeof requestAnimationFrame === 'undefined') return;
    draw.current = requestAnimationFrame(() => { draw.current = 0; controller.current?.(live.current.time); });
  };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: T.WebGLRenderer | undefined;
    const geometries = new Set<T.BufferGeometry>(), materials = new Set<T.Material>(), textures: T.Texture[] = [];
    let observer: ResizeObserver | undefined;
    let stopped = false;
    let releaseFigures = () => {};
    let releaseArena = () => {};
    const unbind: (() => void)[] = [];
    // The renderer, the arena and the players' figures belong to the replay cache: they are handed back, not
    // destroyed, so the next replay of this match opens without rebuilding anything or recompiling shaders.
    const dispose = () => {
      observer?.disconnect(); controller.current = null; releaseFigures(); releaseArena(); unbind.forEach(f => f());
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
      if (renderer) { renderer.domElement.remove(); releaseRenderer(renderer); }
    };
    if (props.flat) { live.current.failed = true; setFailed(true); return () => { stopped = true; }; }
    live.current.failed = false; setFailed(false);
    try {
      const preset = QUALITY[quality];
      renderer = acquireRenderer();
      // Adaptive resolution: start sharp, step down while frames are slow, step back up when there is headroom.
      const maxRatio = preset.dpr(window.devicePixelRatio || 1);
      let ratio = maxRatio;
      renderer.setPixelRatio(ratio);
      renderer.setClearColor('#081421', 1);
      element.appendChild(renderer.domElement);
      const lost = (e: Event) => { e.preventDefault(); if (!stopped) { live.current.failed = true; setFailed(true); } };
      const canvasNode = renderer.domElement;
      canvasNode.addEventListener('webglcontextlost', lost);
      unbind.push(() => canvasNode.removeEventListener('webglcontextlost', lost));
      unbind.push(onCacheRedraw(() => requestDraw()));
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(40, 2, .05, 200);
      const { sun, lamp } = addStageLights(scene, preset.shadow, preset.radius);
      const taken = takeArena(home, away, preset.detail, Math.min(preset.detail === 'hi' ? 16 : 8, renderer.capabilities.getMaxAnisotropy()));
      const arena = taken.arena;
      scene.add(arena.group);
      releaseArena = () => { arena.iceReflection.texture.value = null; arena.iceReflection.strength.value = 0; taken.release(); };
      arena.iceReflection.texture.value = null; arena.iceReflection.strength.value = 0;
      // Planar ice reflection (high/ultra): the players, goals and boards mirrored in the ice, rendered at a
      // fraction of the screen resolution and blended into the ice shader with a fresnel term.
      let reflector: Reflector | null = null;
      const reflectorInverse = new T.Matrix4();
      if (preset.reflect > 0) {
        reflector = sharedReflector();
        reflectorInverse.copy(reflector.matrixWorld).invert();
        arena.iceReflection.texture.value = reflector.getRenderTarget().texture;
        arena.iceReflection.strength.value = 1;
      }
      let skipReflection = false;
      const renderReflection = () => {
        if (!reflector || !renderer) return;
        if (skipReflection) { arena.iceReflection.strength.value = 0; return; }
        arena.iceReflection.strength.value = 1;
        arena.reflectionHidden.forEach(o => { o.visible = false; });
        const clear = renderer.getClearColor(new T.Color()), alpha = renderer.getClearAlpha();
        renderer.setClearColor(clear, 0);
        reflector.onBeforeRender(renderer, scene, camera, reflector.geometry, reflector.material as T.Material, null as unknown as T.Group);
        renderer.setClearColor(clear, alpha);
        arena.reflectionHidden.forEach(o => { o.visible = true; });
        arena.iceReflection.matrix.value.multiplyMatrices((reflector.material as T.ShaderMaterial).uniforms.textureMatrix.value, reflectorInverse);
      };
      const sizeReflection = (w: number, h: number) => { reflector?.getRenderTarget().setSize(Math.max(64, Math.round(w * preset.reflect)), Math.max(64, Math.round(h * preset.reflect))); };

      const mat = (color: string, extra: T.MeshStandardMaterialParameters = {}) => { const m = new T.MeshStandardMaterial({ color, roughness: .65, ...extra }); materials.add(m); return m; };
      const white = mat('#e9f3f8'), dark = mat('#15283d'), steel = mat('#93aab8', { metalness: .5 });
      const addMesh = (parent: T.Object3D, geometry: T.BufferGeometry, material: T.Material, x = 0, y = 0, z = 0, shadow = true) => {
        geometries.add(geometry); const m = new T.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = shadow; parent.add(m); return m;
      };
      const box = (parent: T.Object3D, sx: number, sy: number, sz: number, material: T.Material, x = 0, y = 0, z = 0) => addMesh(parent, new T.BoxGeometry(sx, sy, sz), material, x, y, z);
      const rod = (parent: T.Object3D, a: T.Vector3, b: T.Vector3, radius: number, material: T.Material) => {
        const mesh = addMesh(parent, new T.CylinderGeometry(radius, radius, a.distanceTo(b), 6), material);
        mesh.position.copy(a).add(b).multiplyScalar(.5); mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return mesh;
      };

      // Simple stand-in figures until the rigged models are decoded (and the fallback if that fails).
      // With the rigged model already decoded the figures come from the cache right away: no stand-ins (they
      // would only cost geometry and shader compiles for a picture nobody sees).
      const standIns = !modelLoaded();
      const actors = clip.tracks.map(track => {
        if (!standIns) {
          const group = new T.Group(); scene.add(group);
          const none = new T.Group();
          return { track, group, legs: [] as T.Mesh[], stick: none, torso: none as unknown as T.Mesh, glove: undefined as T.Mesh | undefined, distance: distanceTable(track.keys) };
        }
        const team = track.side === 0 ? home : away;
        const jersey = mat(track.side === 0 ? team.primaryColor : '#f4f7fa'), trim = mat(track.side === 0 ? team.secondaryColor : team.primaryColor);
        const group = new T.Group(); scene.add(group);
        const torso = addMesh(group, new T.CylinderGeometry(.28, .35, .65, 8), jersey, 0, 1.18); torso.rotation.z = -.13;
        box(group, .56, .12, .53, trim, 0, .98);
        addMesh(group, new T.SphereGeometry(.24, 10, 8), jersey, .08, 1.76);
        box(group, .1, .20, .32, steel, .28, 1.70);
        const legs: T.Mesh[] = [];
        for (const sign of [-1, 1]) {
          const leg = box(group, track.goalie ? .29 : .19, .60, .20, track.goalie ? white : dark, 0, .47, sign * .21); legs.push(leg);
          box(group, .43, .09, .09, steel, .07, .09, sign * .23);
          rod(group, new T.Vector3(0, 1.38, sign * .28), new T.Vector3(.4, .95, sign * .38), .12, jersey);
          addMesh(group, new T.SphereGeometry(.13, 6, 5), dark, .4, .95, sign * .38);
        }
        const stick = new T.Group(); stick.position.set(.4, 1, .35); group.add(stick);
        rod(stick, new T.Vector3(0, 0, 0), new T.Vector3(.5, -.87, .21), .035, dark);
        box(stick, .42, .10, .10, dark, .62, -.9, .21);
        let glove: T.Mesh | undefined;
        if (track.goalie) {
          glove = addMesh(group, new T.SphereGeometry(.25, 8, 6), white, .3, 1.12, -.58);
          box(group, .2, .38, .28, white, .4, .97, .45);
          box(group, .12, .32, .36, white, .26, 1.74);
        }
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = track.side === 0 ? '#ffffff' : team.primaryColor; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.strokeStyle = track.side === 0 ? '#142337' : '#ffffff'; ctx.lineWidth = 6;
          const num = String(players[track.id]?.number ?? ''); ctx.strokeText(num, 32, 34); ctx.fillText(num, 32, 34);
          const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace; textures.push(tex);
          const m = new T.MeshBasicMaterial({ map: tex, transparent: true, side: T.DoubleSide }); materials.add(m);
          const number = addMesh(group, new T.PlaneGeometry(.42, .44), m, -.31, 1.25, 0); number.rotation.y = -Math.PI / 2;
        }
        return { track, group, legs, stick, torso, glove, distance: distanceTable(track.keys) };
      });
      let figures: PlayerFigure[] | null = null;
      // Rigged figures from the replay cache. Figures built just now get their shaders compiled off the main
      // thread (KHR_parallel_shader_compile) before they replace the stand-ins, so the picture never stalls.
      let ready = false, sceneCompiled = false;
      let figuresPending = modelLoaded();
      const show = () => {
        if (stopped || ready || !sceneCompiled || figuresPending) return;
        ready = true; resize(); callbacks.current.onReady?.(true);
      };
      loadModel().then(({ mod, template }) => {
        if (stopped || !renderer) return;
        let t: ReturnType<typeof takeFigures>;
        try {
          t = takeFigures(mod, template, home, away, players, clip.tracks.map(track => ({ id: track.id, side: track.side, goalie: !!track.goalie })));
        } catch { figuresPending = false; show(); return; }
        releaseFigures = t.release;
        const attach = () => {
          if (stopped) return;
          t.figures.forEach((figure, i) => actors[i].group.add(figure.root));
          figures = t.figures; setRigged(true);
          actors.forEach((a, i) => a.group.children.forEach(c => { if (c !== t.figures[i].root) c.visible = false; }));
          figuresPending = false; show(); requestDraw();
        };
        if (!t.fresh.length) { attach(); return; }
        const staging = new T.Scene(); t.fresh.forEach(f => staging.add(f.root));
        compileScene(renderer, staging, camera, scene, !!reflector).then(attach);
      }).catch(() => { figuresPending = false; show(); /* keep the simple figures */ });

      const propMats = sharedProps();
      const puck = addMesh(scene, new T.CylinderGeometry(PUCK_R, PUCK_R, PUCK_H, 20), propMats.puck);
      const puckShadow = addMesh(scene, new T.CircleGeometry(PUCK_R * 1.5, 16), propMats.puckShadow, 0, 0, 0, false); puckShadow.rotation.x = -Math.PI / 2;
      const trailGeometry = new T.BufferGeometry().setFromPoints(Array.from({ length: 18 }, () => new T.Vector3())); geometries.add(trailGeometry);
      const trailMaterial = propMats.trail;
      const trail = new T.Line(trailGeometry, trailMaterial); trail.frustumCulled = false; scene.add(trail);
      const dir = attackDir(clip);
      lamp.position.set(dir * 27.5, 3, 0);

      const puckWorld = new T.Vector3(), local = new T.Vector3(), vecUp = new T.Vector3(0, 1, 0), legacy = new T.Vector3();
      const ahead = .2 / Math.max(.5, clip.duration); // ±0.2 s window for headings and speeds
      let exporting = false;
      const update = (time: number, viewOverride?: ReplayView) => {
        if (stopped || !renderer) return;
        const view = viewOverride ?? viewFor(live.current.camera, clip, time);
        const p = samplePath(clip.puck, time), pw = toWorld(p);
        puck.position.set(pw.x, Math.max(0, pw.y) + PUCK_H / 2, pw.z); puckShadow.position.set(pw.x, .012, pw.z);
        puckShadow.visible = pw.y > .03; puckWorld.copy(puck.position);
        // Who has the puck on his stick: the skater whose blade zone is closest to it cups it with the blade;
        // others close by only reach toward it (a poke), so two blades never sit on one puck.
        let carrierW = 0;
        const poses: { figure: PlayerFigure; args: [number, number, number | undefined, number, number, T.Vector3 | null, number] }[] = [];
        actors.forEach(({ track, group, legs, stick, torso, glove, distance }, index) => {
          const pos = sampleSmooth(track.keys, time), w = toWorld(pos);
          group.position.set(w.x, 0, w.z); group.rotation.set(0, 0, 0); group.scale.set(1, 1, 1);
          const figure = figures?.[index];
          if (track.goalie) {
            // Faces out of his net, turned a little toward the puck.
            const out = w.x > 0 ? Math.PI : 0, toPuck = Math.atan2(-(pw.z - w.z), pw.x - w.x);
            group.rotation.y = out + clamp(angleDiff(out, toPuck), -.6, .6);
            if (figure) {
              group.updateMatrixWorld(true);
              figure.goalie(clamp((time - clip.release + .05) / .10, 0, 1), clamp((pos.y - 50) / 12, -1, 1));
              return;
            }
            const drop = clamp((time - clip.release + .05) / .10, 0, 1);
            group.scale.y = 1 - .3 * drop;
            torso.rotation.z = -.13 - drop * .2;
            if (glove) { glove.position.y = 1.12 + drop * .25; glove.position.z = -.58 - drop * .2; }
            legs.forEach((leg, i) => { leg.rotation.x = (i ? -1 : 1) * drop * .9; });
            return;
          }
          // Heading from the motion over ±0.2 s (no jitter on every 0.1 s key); idle players face the puck.
          const a = toWorld(sampleSmooth(track.keys, clamp(time - ahead, 0, 1))), b = toWorld(sampleSmooth(track.keys, clamp(time + ahead, 0, 1)));
          const a2 = toWorld(sampleSmooth(track.keys, clamp(time - ahead * 2, 0, 1))), b2 = toWorld(sampleSmooth(track.keys, clamp(time + ahead * 2, 0, 1)));
          const moved = Math.hypot(b.x - a.x, b.z - a.z), span = Math.max(.001, (Math.min(1, time + ahead) - Math.max(0, time - ahead)) * clip.duration);
          const speed = moved / span;
          const motion = Math.atan2(-(b.z - a.z), b.x - a.x), facePuck = Math.atan2(-(pw.z - w.z), pw.x - w.x);
          const heading = angleLerp(facePuck, motion, smooth01(moved / .35));
          group.rotation.y = heading;
          if (!clip.bodies) group.position.sub(legacy.set(1.0, 0, .52).applyAxisAngle(vecUp, heading));
          group.updateMatrixWorld(true);
          if (figure) {
            // Lean into turns: angular velocity of the heading × speed.
            const h1 = Math.atan2(-(a.z - a2.z), a.x - a2.x), h2 = Math.atan2(-(b2.z - b.z), b2.x - b.x);
            const turn = moved > .3 ? angleDiff(h1, h2) / Math.max(.05, span * 1.5) : 0;
            const bank = clamp(turn * speed * .045, -.4, .4);
            const amp = clamp(speed / 7, 0, 1) * (time > clip.goal + .08 ? .45 : 1);
            const phase = (distance(time) / STRIDE) * Math.PI * 2 + index * 1.7;
            const scorer = track.id === clip.scorer;
            const shot = scorer && time > clip.release - .12 && time < clip.release + .3 ? (time - clip.release) / .1 : undefined;
            const cheer = time > clip.goal && track.side === clip.attacking ? clamp((time - clip.goal) / .06, 0, 1) * (scorer ? 1 : .55) : 0;
            // Puck in character space: candidate for the blade if it is on the ice in front of him.
            local.copy(puckWorld); figure.root.worldToLocal(local);
            const near = Math.hypot(local.x + .3, local.z - .85);
            let reach: T.Vector3 | null = null, reachWeight = 0;
            if (pw.y < .25 && local.z > .1 && local.z < 1.8 && Math.abs(local.x) < 1.3 && near < 1.4 && !(shot !== undefined && time > clip.release)) {
              reachWeight = 1 - smooth01((near - .55) / .85);
              carrierW = Math.max(carrierW, reachWeight);
              reach = local.clone();
            }
            poses.push({ figure, args: [phase, amp, shot, cheer, bank, reach, reachWeight] });
            return;
          }
          group.position.y = Math.abs(Math.sin(time * 65 + index)) * .045 * (time < clip.goal ? 1 : .3);
          legs.forEach((leg, i) => { leg.rotation.z = Math.sin(time * 65 + i * Math.PI + index) * .16; });
          const windup = time < clip.release ? clamp((time - clip.release + .10) / .10, 0, 1) : clamp(1 - (time - clip.release) / .10, 0, 1);
          if (track.id === clip.scorer) {
            stick.rotation.y = time <= clip.release ? -.8 * Math.sin(windup * Math.PI) : .6 * Math.sin(windup * Math.PI);
            torso.rotation.z = -.13 - .2 * Math.sin(windup * Math.PI);
            group.rotation.z = time > clip.goal ? Math.sin((time - clip.goal) * 10) * .08 : 0;
          }
        });
        for (const { figure, args: [phase, amp, shot, cheer, bank, reach, w] } of poses) {
          figure.skate(phase, amp, shot, cheer, { bank, reach, reachWeight: w >= carrierW - 1e-6 ? w : w * .35 });
        }
        const attr = trailGeometry.getAttribute('position');
        for (let i = 0; i < 18; i++) { const v = toWorld(samplePath(clip.puck, Math.max(0, time - i * .0025))); attr.setXYZ(i, v.x, v.y + PUCK_H, v.z); } attr.needsUpdate = true;
        // The trail only shows a flying puck (shots and hard passes), not a carried one.
        const prev = toWorld(samplePath(clip.puck, Math.max(0, time - .01)));
        trail.visible = Math.hypot(pw.x - prev.x, pw.z - prev.z) / Math.max(.001, .01 * clip.duration) > 14;
        lamp.intensity = time >= clip.goal ? 14 : 0;
        const pose = cameraPose(clip, time, view, live.current.zoom, camera.aspect);
        camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
        camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
        if (Math.abs(camera.fov - pose.fov) > .01) { camera.fov = pose.fov; camera.updateProjectionMatrix(); }
        // Key light and its shadow map follow what the camera looks at.
        sun.position.set(pose.look.x + 8, 25, pose.look.z + 12); sun.target.position.set(pose.look.x, 0, pose.look.z); sun.target.updateMatrixWorld();
        camera.updateMatrixWorld();
        renderReflection();
        renderer.render(scene, camera);
      };
      const resize = () => {
        if (!renderer || exporting) return;
        const w = Math.max(1, element.clientWidth), h = Math.max(1, element.clientHeight);
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
        sizeReflection(w * ratio, h * ratio);
        if (ready) update(live.current.time);
      };
      observer = new ResizeObserver(resize); observer.observe(element); resize();
      // Shaders of the arena and the stand-ins compile in the background; the first frame waits for them.
      compileScene(renderer, scene, camera, null, !!reflector).finally(() => { sceneCompiled = true; show(); });
      // Never wait forever (a driver without parallel compile, a slow phone): show what is there after 4 s.
      const giveUp = setTimeout(() => { sceneCompiled = true; figuresPending = false; show(); }, 4000);
      unbind.push(() => clearTimeout(giveUp));
      // Frame-time governor for the adaptive resolution.
      let slow = 0, fast = 0, lastFrame = 0;
      controller.current = (time: number) => {
        const now = performance.now(), dt = now - lastFrame; lastFrame = now;
        if (exporting || !ready) return;
        update(time);
        if (preset.adaptive && dt > 0 && dt < 250) {
          if (dt > 24) { slow++; fast = 0; } else if (dt < 15) { fast++; slow = 0; } else { slow = Math.max(0, slow - 1); fast = Math.max(0, fast - 1); }
          if (renderer && slow > 20 && ratio > preset.minDpr) { ratio = Math.max(preset.minDpr, ratio - .2); renderer.setPixelRatio(ratio); resize(); slow = 0; }
          else if (renderer && fast > 120 && ratio < maxRatio) { ratio = Math.min(maxRatio, ratio + .1); renderer.setPixelRatio(ratio); resize(); fast = 0; }
        }
      };
      // Offline frames for the MP4 export: fixed size, exact time and camera, no adaptive resolution.
      // «fast» export: no ice reflection pass and a 1024 shadow map (the costliest parts of a frame).
      const setShadow = (size: number) => {
        if (sun.shadow.mapSize.x === size) return;
        sun.shadow.map?.dispose(); sun.shadow.map = null; sun.shadow.mapSize.set(size, size);
      };
      if (props.exporter) props.exporter.current = {
        begin: (w, h, options) => {
          if (!renderer) return;
          exporting = true; renderer.setPixelRatio(1); renderer.setSize(w, h, false);
          camera.aspect = w / h; camera.updateProjectionMatrix();
          skipReflection = !!options?.fast;
          if (options?.fast) setShadow(Math.min(1024, preset.shadow)); else sizeReflection(w, h);
        },
        frame: (time, view) => { update(time, view); return renderer!.domElement; },
        end: () => { if (!renderer) return; exporting = false; skipReflection = false; setShadow(preset.shadow); renderer.setPixelRatio(ratio); resize(); },
      };
      const exporterRef = props.exporter;
      unbind.push(() => { if (exporterRef) exporterRef.current = null; });
      // Zoom: mouse wheel and two-finger pinch on the picture.
      const setZoom = (z: number) => { live.current.zoom = clamp(z, ZOOM.min, ZOOM.max); callbacks.current.onZoom?.(live.current.zoom); requestDraw(); };
      const wheel = (e: WheelEvent) => { e.preventDefault(); setZoom(live.current.zoom * Math.exp(clamp(e.deltaY, -200, 200) * .0015)); };
      let pinch = 0;
      const span2 = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const touchStart = (e: TouchEvent) => { if (e.touches.length === 2) pinch = span2(e); };
      const touchMove = (e: TouchEvent) => { if (e.touches.length === 2 && pinch > 0) { e.preventDefault(); const d = span2(e); setZoom(live.current.zoom * pinch / d); pinch = d; } };
      const touchEnd = () => { pinch = 0; };
      const canvasEl = renderer.domElement;
      canvasEl.addEventListener('wheel', wheel, { passive: false });
      canvasEl.addEventListener('touchstart', touchStart, { passive: true });
      canvasEl.addEventListener('touchmove', touchMove, { passive: false });
      canvasEl.addEventListener('touchend', touchEnd);
      unbind.push(() => { canvasEl.removeEventListener('wheel', wheel); canvasEl.removeEventListener('touchstart', touchStart); canvasEl.removeEventListener('touchmove', touchMove); canvasEl.removeEventListener('touchend', touchEnd); });
    } catch {
      live.current.failed = true; setFailed(true); dispose();
    }
    return () => { stopped = true; if (draw.current) cancelAnimationFrame(draw.current); draw.current = 0; dispose(); setRigged(false); callbacks.current.onReady?.(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, home, away, players, quality, props.flat]);

  // Seek / restart from the parent.
  useEffect(() => {
    if ((props.seek ?? 0) !== live.current.seek) { live.current.seek = props.seek ?? 0; live.current.time = props.time; }
    if (!props.playing) requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.seek, props.time, props.playing]);
  useEffect(() => { requestDraw(); /* camera switch */ }, [props.camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (props.zoom !== undefined && Math.abs(props.zoom - live.current.zoom) > 1e-6) { live.current.zoom = props.zoom; requestDraw(); } }, [props.zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback loop: renders every display frame; React only hears about it ~10× a second.
  useEffect(() => {
    if (!props.playing) return;
    let raf = 0, last = performance.now(), lastReport = 0;
    const speed = props.speed ?? 1;
    const report = (t: number, now: number, force = false) => {
      if (!force && now - lastReport < (live.current.failed ? 33 : 100)) return;
      lastReport = now; callbacks.current.onTime?.(t, live.current.seek);
    };
    const tick = (now: number) => {
      const dt = Math.min(.1, (now - last) / 1000); last = now;
      const before = live.current.time;
      const t = Math.min(1, before + dt * speed / Math.max(.5, clip.duration));
      live.current.time = t;
      controller.current?.(t);
      report(t, now, t >= 1 || (before < clip.goal && t >= clip.goal));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // On pause, hand the exact position back so the slider matches the picture.
    return () => { cancelAnimationFrame(raf); callbacks.current.onTime?.(live.current.time, live.current.seek); };
  }, [props.playing, props.speed, clip]);

  return <div className="absolute inset-0" data-replay-renderer={failed ? 'svg' : 'webgl'} data-replay-models={rigged && !failed ? 'rigged' : 'simple'}>
    <div ref={host} className={failed ? 'hidden' : 'w-full h-full'} />
    {!failed && props.overlay}
    {failed && <div className="w-full h-full p-3 bg-[#102335]" data-replay-flat={props.flat || undefined}><RinkSvg frame={clipFrame(clip, props.time)} home={home} away={away} players={players} /><span className="absolute bottom-2 left-3 text-[10px] text-white/70">{props.flat ? '2D-повтор · 3D можно включить в настройках' : 'WebGL недоступен — показан тот же эпизод сверху.'}</span></div>}
  </div>;
}
