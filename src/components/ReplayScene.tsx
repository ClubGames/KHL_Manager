import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as T from 'three';
import type { Player, Team } from '../types';
import { attackDir, clamp, samplePath, sampleSmooth, type Key, type ReplayClip } from '../game/rinkPlayback';
import { clipFrame, RinkSvg } from './RinkView';
import { getClubLogoSources, getOfficialClubPalette, hexLuminance } from '../game/clubColors';
import type { Kit, PlayerFigure } from './playerModel';
import { buildArena } from './replayArena';
import { cameraPose, toWorld, viewFor, ZOOM, type ReplayCamera } from './replayCameras';

export { broadcastFocus, CAMERAS, autoCamera, viewFor, VIEW_LABEL, ZOOM, type ReplayCamera, type ReplayView } from './replayCameras';

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
};

const contrast = (a: string, b: string) => Math.abs(hexLuminance(a) - hexLuminance(b)) > 70;
/** Real puck: 7.62 cm × 2.54 cm, drawn 1.25× so it still reads on a phone-sized broadcast shot. */
const PUCK_R = .0381 * 1.25, PUCK_H = .0254 * 1.25;
const STRIDE = 3.3; // metres per full stride cycle (left + right push)

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
      glove: dark === primary ? secondary : primary, number, name, numberFill: fill, numberStroke: contrast(secondary, fill) ? secondary : dark, goalie, pads: '#f4f6f8', crest };
  }
  const ink = hexLuminance(primary) < 200 ? primary : dark;
  const trim2 = hexLuminance(secondary) < 200 && secondary.toLowerCase() !== ink.toLowerCase() ? secondary : accent;
  return { jersey: '#f4f7fa', trim: ink, trim2, pants: dark, socks: '#f4f7fa', sockTrim: ink, helmet: '#f4f7fa', glove: ink,
    number, name, numberFill: ink, numberStroke: '#ffffff', goalie, pads: '#f4f6f8', crest };
}

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
  // Live values read by the render loop (no React re-render per frame).
  const live = useRef({ time: props.time, seek: props.seek ?? 0, camera: props.camera, zoom: props.zoom ?? 1, failed: false });
  live.current.camera = props.camera;
  const callbacks = useRef({ onTime: props.onTime, onZoom: props.onZoom });
  callbacks.current = { onTime: props.onTime, onZoom: props.onZoom };
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
    let disposeFigures = () => {};
    let disposeArena = () => {};
    const unbind: (() => void)[] = [];
    const dispose = () => {
      observer?.disconnect(); controller.current = null; disposeFigures(); disposeArena(); unbind.forEach(f => f());
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
    try {
      if (typeof window.WebGLRenderingContext === 'undefined' && typeof window.WebGL2RenderingContext === 'undefined') throw new Error('WebGL unavailable');
      renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      // Adaptive resolution: start sharp, step down while frames are slow, step back up when there is headroom.
      const maxRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      let ratio = maxRatio;
      renderer.setPixelRatio(ratio);
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFShadowMap;
      renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
      renderer.setClearColor('#081421');
      renderer.domElement.setAttribute('aria-label', 'Объёмная реконструкция голевого эпизода');
      element.appendChild(renderer.domElement);
      renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
      renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (!stopped) { live.current.failed = true; setFailed(true); } });
      const scene = new T.Scene(); scene.fog = new T.Fog('#081421', 70, 150);
      const camera = new T.PerspectiveCamera(40, 2, .05, 200);
      scene.add(new T.HemisphereLight('#e6f4ff', '#26384c', 2.1));
      // The arena lights: one shadow-casting key light that follows the play (tight, sharp shadow map) and a fill.
      const sun = new T.DirectionalLight('#fff7e9', 2.9); sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -16; sun.shadow.camera.right = 16; sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12;
      sun.shadow.camera.near = 1; sun.shadow.camera.far = 60; sun.shadow.normalBias = .03; sun.shadow.bias = -.0005;
      scene.add(sun); scene.add(sun.target);
      const fill = new T.DirectionalLight('#dbe8ff', .9); fill.position.set(-14, 20, -18); scene.add(fill);
      const arena = buildArena(scene, home, away, Math.min(8, renderer.capabilities.getMaxAnisotropy()), () => requestDraw());
      disposeArena = arena.dispose;

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
      const actors = clip.tracks.map(track => {
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
      const crestFor = (team: Team) => {
        const m = new T.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, alphaTest: .05 }); m.visible = false; materials.add(m);
        const sources = getClubLogoSources(team), loader = new T.TextureLoader();
        const next = (i: number) => {
          if (i >= sources.length || stopped) return;
          loader.load(sources[i], tex => {
            if (stopped) { tex.dispose(); return; }
            tex.colorSpace = T.SRGBColorSpace; textures.push(tex); m.map = tex; m.visible = true; m.needsUpdate = true; requestDraw();
          }, undefined, () => next(i + 1));
        };
        next(0);
        return m;
      };
      // Loaded on demand (also keeps the GLB out of node-side imports of this component).
      import('./playerModel').then(model => model.loadPlayerTemplate().then(template => {
        if (stopped) return;
        const crests = [crestFor(home), crestFor(away)];
        const built: PlayerFigure[] = [];
        try {
          clip.tracks.forEach((track, i) => {
            const figure = new model.PlayerFigure(template, kitFor(track.side === 0 ? home : away, track.side, !!track.goalie, players[track.id], crests[track.side]));
            figure.root.rotation.y = Math.PI / 2; // model faces +z, replay bodies face +x
            built.push(figure); actors[i].group.add(figure.root);
          });
        } catch { built.forEach(f => f.dispose()); return; }
        disposeFigures = () => built.forEach(f => f.dispose());
        figures = built; setRigged(true);
        actors.forEach(a => a.group.children.forEach(c => { if (!built.some(f => f.root === c)) c.visible = false; }));
        requestDraw();
      })).catch(() => { /* keep the simple figures */ });

      const puck = addMesh(scene, new T.CylinderGeometry(PUCK_R, PUCK_R, PUCK_H, 20), mat('#07090d', { roughness: .45 }));
      const puckShadow = addMesh(scene, new T.CircleGeometry(PUCK_R * 1.5, 16), mat('#0b1622', { transparent: true, opacity: .35, depthWrite: false }), 0, 0, 0, false); puckShadow.rotation.x = -Math.PI / 2;
      const trailGeometry = new T.BufferGeometry().setFromPoints(Array.from({ length: 18 }, () => new T.Vector3())); geometries.add(trailGeometry);
      const trailMaterial = new T.LineBasicMaterial({ color: '#efad3d', transparent: true, opacity: .7 }); materials.add(trailMaterial);
      const trail = new T.Line(trailGeometry, trailMaterial); trail.frustumCulled = false; scene.add(trail);
      const dir = attackDir(clip);
      const lamp = new T.PointLight('#ff2847', 0, 15); lamp.position.set(dir * 27.5, 3, 0); scene.add(lamp);

      const puckWorld = new T.Vector3(), local = new T.Vector3(), vecUp = new T.Vector3(0, 1, 0), legacy = new T.Vector3();
      const ahead = .2 / Math.max(.5, clip.duration); // ±0.2 s window for headings and speeds
      const update = (time: number) => {
        if (stopped || !renderer) return;
        const view = viewFor(live.current.camera, clip, time);
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
        renderer.render(scene, camera);
      };
      const resize = () => { if (!renderer) return; const w = Math.max(1, element.clientWidth), h = Math.max(1, element.clientHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); update(live.current.time); };
      observer = new ResizeObserver(resize); observer.observe(element); resize();
      // Frame-time governor for the adaptive resolution.
      let slow = 0, fast = 0, lastFrame = 0;
      controller.current = (time: number) => {
        const now = performance.now(), dt = now - lastFrame; lastFrame = now;
        update(time);
        if (dt > 0 && dt < 250) {
          if (dt > 24) { slow++; fast = 0; } else if (dt < 15) { fast++; slow = 0; } else { slow = Math.max(0, slow - 1); fast = Math.max(0, fast - 1); }
          if (renderer && slow > 20 && ratio > .6) { ratio = Math.max(.6, ratio - .2); renderer.setPixelRatio(ratio); resize(); slow = 0; }
          else if (renderer && fast > 120 && ratio < maxRatio) { ratio = Math.min(maxRatio, ratio + .1); renderer.setPixelRatio(ratio); resize(); fast = 0; }
        }
      };
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
    return () => { stopped = true; if (draw.current) cancelAnimationFrame(draw.current); draw.current = 0; dispose(); setRigged(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, home, away, players]);

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
    {failed && <div className="w-full h-full p-3 bg-[#102335]"><RinkSvg frame={clipFrame(clip, props.time)} home={home} away={away} players={players} /><span className="absolute bottom-2 left-3 text-[10px] text-white/70">WebGL недоступен — показан тот же эпизод сверху.</span></div>}
  </div>;
}
