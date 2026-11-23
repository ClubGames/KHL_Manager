import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import type { Player, Team } from '../types';
import { clamp, samplePath, type Point, type ReplayClip } from '../game/rinkPlayback';
import { clipFrame, RinkSvg } from './RinkView';

export type ReplayCamera = 'broadcast' | 'ice' | 'net';
type Props = { clip: ReplayClip; time: number; camera: ReplayCamera; home: Team; away: Team; players: Record<string, Player> };
const world = (p: Point) => new T.Vector3((p.x - 50) * .6, p.h + .08, (p.y - 50) * .3);

/** Real perspective geometry, lighting and depth testing, not CSS-transformed sprites. */
export function ReplayScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<((time: number, camera: ReplayCamera) => void) | null>(null);
  const [failed, setFailed] = useState(false);
  const { clip, home, away, players } = props;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: T.WebGLRenderer | undefined;
    const geometries = new Set<T.BufferGeometry>(), materials = new Set<T.Material>(), textures: T.Texture[] = [];
    let observer: ResizeObserver | undefined;
    let stopped = false;
    const dispose = () => {
      observer?.disconnect(); controller.current = null;
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
    try {
      if (typeof window.WebGLRenderingContext === 'undefined' && typeof window.WebGL2RenderingContext === 'undefined') throw new Error('WebGL unavailable');
      renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
      renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.setClearColor('#081421');
      renderer.domElement.setAttribute('aria-label', 'Объёмная реконструкция голевого эпизода');
      element.appendChild(renderer.domElement);
      renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
      renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (!stopped) setFailed(true); });
      const scene = new T.Scene(); scene.fog = new T.Fog('#081421', 65, 140);
      const camera = new T.PerspectiveCamera(44, 2, .1, 180);
      scene.add(new T.HemisphereLight('#e0f4ff', '#233448', 2.5));
      const sun = new T.DirectionalLight('#fff7e9', 3.4); sun.position.set(8, 25, 12); sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -34; sun.shadow.camera.right = 34; sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24; sun.shadow.normalBias = .04; scene.add(sun);
      const mat = (color: string, extra: T.MeshStandardMaterialParameters = {}) => { const m = new T.MeshStandardMaterial({ color, roughness: .65, ...extra }); materials.add(m); return m; };
      const ice = mat('#dcecf3', { roughness: .28, metalness: .12 }), white = mat('#e9f3f8'), red = mat('#d8314b'), dark = mat('#15283d'), steel = mat('#93aab8', { metalness: .5 }), yellow = mat('#e9ae35');
      const addMesh = (parent: T.Object3D, geometry: T.BufferGeometry, material: T.Material, x = 0, y = 0, z = 0) => {
        geometries.add(geometry); const m = new T.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
      };
      const box = (parent: T.Object3D, sx: number, sy: number, sz: number, material: T.Material, x = 0, y = 0, z = 0) => addMesh(parent, new T.BoxGeometry(sx, sy, sz), material, x, y, z);
      const rod = (parent: T.Object3D, a: T.Vector3, b: T.Vector3, radius: number, material: T.Material) => {
        const mesh = addMesh(parent, new T.CylinderGeometry(radius, radius, a.distanceTo(b), 6), material);
        mesh.position.copy(a).add(b).multiplyScalar(.5); mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return mesh;
      };
      const rink = new T.Shape();
      rink.moveTo(-22, -15); rink.lineTo(22, -15); rink.absarc(22, -7, 8, -Math.PI / 2, 0, false); rink.lineTo(30, 7); rink.absarc(22, 7, 8, 0, Math.PI / 2, false); rink.lineTo(-22, 15); rink.absarc(-22, 7, 8, Math.PI / 2, Math.PI, false); rink.lineTo(-30, -7); rink.absarc(-22, -7, 8, Math.PI, 1.5 * Math.PI, false);
      const floor = addMesh(scene, new T.ShapeGeometry(rink, 16), ice); floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
      box(scene, 60, .55, 30, dark, 0, -.5);
      const outline = rink.getPoints(8);
      const glass = mat('#a8d4e7', { transparent: true, opacity: .15, depthWrite: false, roughness: .1 });
      for (let i = 1; i < outline.length; i++) {
        const a = outline[i - 1], b = outline[i], length = a.distanceTo(b), x = (a.x + b.x) / 2, z = -(a.y + b.y) / 2;
        const wall = box(scene, length + .03, 1.05, .22, white, x, .52, z); wall.rotation.y = Math.atan2(b.y - a.y, b.x - a.x);
        const trim = box(scene, length + .03, .13, .25, yellow, x, .10, z); trim.rotation.copy(wall.rotation);
        const rail = box(scene, length + .03, .12, .28, red, x, 1.08, z); rail.rotation.copy(wall.rotation);
        const pane = box(scene, length, 1.6, .06, glass, x, 1.92, z); pane.rotation.copy(wall.rotation); pane.castShadow = false;
      }
      // Tiered seating is actual geometry too: silhouettes read from low rink-side cameras.
      for (let tier = 0; tier < 5; tier++) {
        const seats = mat(tier % 2 ? '#243c56' : '#1a3049');
        for (const sign of [-1, 1]) {
          box(scene, 79, 1.1, 2.5, seats, 0, 1.3 + tier * 1.3, sign * (18 + tier * 2.4));
          box(scene, 2.5, 1.1, 36, seats, sign * (34 + tier * 2.4), 1.3 + tier * 1.3);
        }
      }
      const line = (points: T.Vector3[], color: string, opacity = 1) => {
        const g = new T.BufferGeometry().setFromPoints(points); geometries.add(g); const m = new T.LineBasicMaterial({ color, transparent: opacity < 1, opacity }); materials.add(m); const l = new T.Line(g, m); scene.add(l); return l;
      };
      const circle = (x: number, z: number, r: number, color: string) => line(Array.from({ length: 81 }, (_, i) => new T.Vector3(x + r * Math.cos(i / 80 * Math.PI * 2), .018, z + r * Math.sin(i / 80 * Math.PI * 2))), color);
      [-13.2, 13.2].forEach(x => box(scene, .3, .018, 29.5, mat('#367bb8'), x, .012));
      [-25.8, 0, 25.8].forEach(x => box(scene, .09, .018, 28, red, x, .014));
      circle(0, 0, 4.5, '#397da9');
      [-18, 18].forEach(x => [-7, 7].forEach(z => { circle(x, z, 4.4, '#d25c6c'); circle(x, z, .14, '#d25c6c'); }));
      for (const dir of [-1, 1]) {
        const crease = addMesh(scene, new T.CircleGeometry(2, 28), mat('#92cce4')); crease.rotation.x = -Math.PI / 2; crease.position.set(dir * 25.2, .008, 0); crease.castShadow = false;
        const front = dir * 25.8, back = dir * 27.3;
        for (const z of [-.915, .915]) { rod(scene, new T.Vector3(front, .05, z), new T.Vector3(front, 1.22, z), .055, red); rod(scene, new T.Vector3(front, 1.22, z), new T.Vector3(back, .15, z), .035, steel); }
        rod(scene, new T.Vector3(front, 1.22, -.915), new T.Vector3(front, 1.22, .915), .055, red);
        for (let z = -.915; z < .94; z += .16) line([new T.Vector3(front, 1.22, z), new T.Vector3(back, .12, z), new T.Vector3(front, .05, z)], '#9db4bd', .55);
        for (let y = .15; y < 1.2; y += .16) {
          const x = back + (front - back) * y / 1.22;
          line([new T.Vector3(front, y, -.915), new T.Vector3(x, y, -.915), new T.Vector3(x, y, .915), new T.Vector3(front, y, .915)], '#9db4bd', .55);
        }
      }
      const actors = clip.tracks.map(track => {
        const team = track.side === 0 ? home : away;
        const jersey = mat(team.primaryColor), trim = mat(track.side === 0 ? team.secondaryColor : '#f4f7fa');
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
        // Jersey number on a real textured plane, legible with correct perspective.
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.strokeStyle = '#142337'; ctx.lineWidth = 6;
          const num = String(players[track.id]?.number ?? ''); ctx.strokeText(num, 32, 34); ctx.fillText(num, 32, 34);
          const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace; textures.push(tex);
          const m = new T.MeshBasicMaterial({ map: tex, transparent: true, side: T.DoubleSide }); materials.add(m);
          const number = addMesh(group, new T.PlaneGeometry(.42, .44), m, -.31, 1.25, 0); number.rotation.y = -Math.PI / 2;
        }
        return { track, group, legs, stick, torso, glove };
      });
      const puck = addMesh(scene, new T.CylinderGeometry(.16, .16, .075, 12), mat('#090f19'));
      const puckShadow = addMesh(scene, new T.CircleGeometry(.20, 16), mat('#203548', { transparent: true, opacity: .25 })); puckShadow.rotation.x = -Math.PI / 2; puckShadow.castShadow = false;
      const trailGeometry = new T.BufferGeometry().setFromPoints(Array.from({ length: 18 }, () => new T.Vector3())); geometries.add(trailGeometry);
      const trailMaterial = new T.LineBasicMaterial({ color: '#efad3d', transparent: true, opacity: .8 }); materials.add(trailMaterial);
      const trail = new T.Line(trailGeometry, trailMaterial); scene.add(trail);
      const lamp = new T.PointLight('#ff2847', 0, 15); lamp.position.set(clip.attacking ? -27 : 27, 3, 0); scene.add(lamp);
      let activeCamera = '';
      const update = (time: number, view: ReplayCamera) => {
        if (stopped || !renderer) return;
        const p = samplePath(clip.puck, time); puck.position.copy(world(p)); puckShadow.position.set(puck.position.x, .023, puck.position.z);
        actors.forEach(({ track, group, legs, stick, torso, glove }, index) => {
          const pos = samplePath(track.keys, time), next = samplePath(track.keys, Math.min(1, time + .008));
          group.position.copy(world(pos)); group.position.y = 0;
          if (track.goalie) {
            group.rotation.y = clip.attacking ? 0 : Math.PI;
            const drop = clamp((time - clip.release + .05) / .10, 0, 1);
            group.scale.y = 1 - .3 * drop;
            torso.rotation.z = -.13 - drop * .2;
            if (glove) { glove.position.y = 1.12 + drop * .25; glove.position.z = -.58 - drop * .2; }
            legs.forEach((leg, i) => { leg.rotation.x = (i ? -1 : 1) * drop * .9; });
          } else {
            const dx = next.x - pos.x, dz = (next.y - pos.y) * .5;
            if (Math.abs(dx) + Math.abs(dz) > .01) group.rotation.y = Math.atan2(-dz, dx);
            group.position.y = Math.abs(Math.sin(time * 65 + index)) * .045 * (time < clip.goal ? 1 : .3);
            legs.forEach((leg, i) => { leg.rotation.z = Math.sin(time * 65 + i * Math.PI + index) * .16; });
            // Paths identify blade positions: carrying the puck no longer floats a metre from the stick.
            const bladeOffset = new T.Vector3(1.02, 0, .56).applyAxisAngle(new T.Vector3(0, 1, 0), group.rotation.y);
            group.position.sub(bladeOffset);
            const windup = time < clip.release ? clamp((time - clip.release + .10) / .10, 0, 1) : clamp(1 - (time - clip.release) / .10, 0, 1);
            if (track.id === clip.scorer) {
              stick.rotation.y = time <= clip.release ? -.8 * Math.sin(windup * Math.PI) : .6 * Math.sin(windup * Math.PI);
              torso.rotation.z = -.13 - .2 * Math.sin(windup * Math.PI);
              group.rotation.z = time > clip.goal ? Math.sin((time - clip.goal) * 10) * .08 : 0;
            }
          }
        });
        const attr = trailGeometry.getAttribute('position');
        for (let i = 0; i < 18; i++) { const v = world(samplePath(clip.puck, Math.max(0, time - i * .0025))); attr.setXYZ(i, v.x, v.y + .04, v.z); } attr.needsUpdate = true; trailGeometry.computeBoundingSphere();
        lamp.intensity = time >= clip.goal ? 14 : 0;
        if (activeCamera !== view) {
          activeCamera = view;
          const dir = clip.attacking ? -1 : 1;
          const shot = world(samplePath(clip.puck, clip.release));
          const narrow = element.clientWidth < 600;
          if (view === 'broadcast') { camera.position.set(dir * 18, narrow ? 34 : 24, narrow ? 39 : 29); camera.lookAt(dir * 15, 0, 0); }
          else if (view === 'ice') { camera.position.set(shot.x - dir * 15, 5, shot.z + 18); camera.lookAt(dir * 24, .5, 0); }
          else { camera.position.set(dir * 30, 4.8, 10); camera.lookAt(dir * 18, .4, 0); }
        }
        renderer.render(scene, camera);
      };
      const resize = () => { if (!renderer) return; const w = Math.max(1, element.clientWidth), h = Math.max(1, element.clientHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); activeCamera = ''; update(0, 'broadcast'); };
      observer = new ResizeObserver(resize); observer.observe(element); resize(); controller.current = update;
    } catch {
      setFailed(true); dispose();
    }
    return () => { stopped = true; dispose(); };
  }, [clip, home, away, players]);
  useEffect(() => { controller.current?.(props.time, props.camera); }, [props.time, props.camera]);
  return <div className="absolute inset-0" data-replay-renderer={failed ? 'svg' : 'webgl'}>
    <div ref={host} className={failed ? 'hidden' : 'w-full h-full'} />
    {failed && <div className="w-full h-full p-3 bg-[#102335]"><RinkSvg frame={clipFrame(clip, props.time)} home={home} away={away} players={players} /><span className="absolute bottom-2 left-3 text-[10px] text-white/70">WebGL недоступен — показан тот же эпизод сверху.</span></div>}
  </div>;
}
