import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import type { Player, Team } from '../types';
import { clamp } from '../game/rinkPlayback';
import type { PlayerFigure } from './playerModel';
import { acquireRenderer, addStageLights, compileScene, kitFor, loadModel, onCacheRedraw, releaseRenderer, sharedProps, takeArena, takeFigures, type FigureRequest } from './replayCache';
import { liveCameraPose, toWorld, ZOOM, type LiveCamera } from './replayCameras';

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
};

type Props = {
  ai: LiveSource; ticker: { tau?: number; wait?: boolean }; home: Team; away: Team; players: Record<string, Player>;
  /** everyone who may come on the ice (dressed players, both goalies): their figures are prepared up front */
  roster: FigureRequest[];
  camera: LiveCamera; quality: ReplayQuality;
  /** WebGL unavailable / context lost: the parent shows the 2D rink instead */
  onFail: () => void;
};

export function LiveScene3D(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ ai: props.ai, camera: props.camera, zoom: 1 });
  live.current.ai = props.ai; live.current.camera = props.camera;
  const [ready, setReady] = useState(false);
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
    const dispose = () => {
      tickerRef.current.wait = false;
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
      const { sun, lamp } = addStageLights(scene, preset.shadow, preset.radius);
      const taken = takeArena(home, away, preset.detail, Math.min(preset.detail === 'hi' ? 16 : 8, renderer.capabilities.getMaxAnisotropy()));
      const arena = taken.arena;
      arena.iceReflection.texture.value = null; arena.iceReflection.strength.value = 0;
      scene.add(arena.group);
      releaseArena = () => taken.release();
      let dirty = true;
      unbind.push(onCacheRedraw(() => { dirty = true; }));

      const propMats = sharedProps();
      const puckGeo = new T.CylinderGeometry(PUCK_R, PUCK_R, PUCK_H, 20), shadowGeo = new T.CircleGeometry(PUCK_R * 1.5, 16);
      geometries.push(puckGeo, shadowGeo);
      const puck = new T.Mesh(puckGeo, propMats.puck); puck.castShadow = true; scene.add(puck);
      const puckShadow = new T.Mesh(shadowGeo, propMats.puckShadow); puckShadow.rotation.x = -Math.PI / 2; scene.add(puckShadow);
      const trailGeo = new T.BufferGeometry().setFromPoints(Array.from({ length: 14 }, () => new T.Vector3())); geometries.push(trailGeo);
      const trail = new T.Line(trailGeo, propMats.trail); trail.frustumCulled = false; scene.add(trail);
      // The referee at faceoffs (a simple figure: black and white).
      const refMat = new T.MeshStandardMaterial({ color: '#16191f', roughness: .7 }), refShirt = new T.MeshStandardMaterial({ color: '#f1f3f5', roughness: .7 });
      materials.push(refMat, refShirt);
      const official = new T.Group();
      { const legs = new T.CylinderGeometry(.15, .13, .85, 8), body = new T.CylinderGeometry(.24, .2, .62, 10), head = new T.SphereGeometry(.15, 10, 8); geometries.push(legs, body, head);
        const l = new T.Mesh(legs, refMat); l.position.y = .45; const b = new T.Mesh(body, refShirt); b.position.y = 1.18; const h = new T.Mesh(head, refMat); h.position.y = 1.65;
        [l, b, h].forEach(m => { m.castShadow = true; official.add(m); }); }
      official.visible = false; scene.add(official);
      // The played match: a ring on the ice under the skater the manager controls (and an arrow above him).
      const ringGeo = new T.RingGeometry(.52, .66, 40), arrowGeo = new T.ConeGeometry(.16, .3, 4);
      const ringMat = new T.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: .9, depthWrite: false, side: T.DoubleSide });
      geometries.push(ringGeo, arrowGeo); materials.push(ringMat);
      const ctrlRing = new T.Mesh(ringGeo, ringMat); ctrlRing.rotation.x = -Math.PI / 2; ctrlRing.renderOrder = 2;
      const ctrlArrow = new T.Mesh(arrowGeo, ringMat); ctrlArrow.rotation.x = Math.PI;
      ctrlRing.visible = ctrlArrow.visible = false; scene.add(ctrlRing, ctrlArrow);
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
        const go = () => {
          if (stopped) return;
          t.figures.forEach((f, i) => { const a = list[i]; a.figure = f; a.group.add(f.root); a.standIn.visible = false; });
          dirty = true; figuresIn();
        };
        if (!t.fresh.length) { go(); return; }
        const staging = new T.Scene(); t.fresh.forEach(f => staging.add(f.root));
        compileScene(renderer, staging, camera, scene, false).then(go);
      }).catch(() => { figuresIn(); /* stand-ins stay */ });

      let motion: LiveMotionLike | null = null, motionOf: LiveSource | null = null;
      const focus = { x: 0, z: 0, init: false };
      let lastTau = NaN, lastNow = performance.now(), lastCam = '', firstFrame = true;
      const puckWorld = new T.Vector3(), local = new T.Vector3(), puckOff = { x: 0, z: 0 };
      const aspect = () => camera.aspect;
      let settled = false, camSpeed = 0;

      const update = (now: number) => {
        if (!renderer) return;
        const ai = live.current.ai;
        if (!motion || motionOf !== ai) { motion = ai.motion ?? new LiveMotion(ai); motionOf = ai; focus.init = false; actors.forEach(a => { a.lx = NaN; a.save = null; }); }
        const tau = tickerRef.current.tau ?? 0;
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
        if (f.official) { const o = toWorld(f.official); official.visible = true; official.position.set(o.x, 0, o.z); official.rotation.y = Math.atan2(pw.x - o.x, pw.z - o.z); } else official.visible = false;

        const goal = motion.goalAt(tau);
        lamp.intensity = goal && tau - goal.tau < 3 ? 14 : 0;
        if (goal) lamp.position.set(goal.netX + Math.sign(goal.netX) * 1.6, 2.6, 0);

        const shown = shownSkaters(f);
        const ctl = shown.find(p => p.ctrl);
        ctrlRing.visible = ctrlArrow.visible = !!ctl;
        if (ctl) { const c = toWorld(ctl.pos); ctrlRing.position.set(c.x, .015, c.z); ctrlArrow.position.set(c.x, 2.35 + Math.sin(now / 180) * .06, c.z); ctrlArrow.rotation.y = now / 600; }
        const holder = f.carrier && !f.stopped ? shown.find(p => p.id === f.carrier && !p.goalie) : undefined;
        carrierRing.visible = !!holder;
        if (holder) { const c = toWorld(holder.pos); carrierRing.position.set(c.x, .017, c.z); const pulse = 1 + Math.sin(now / 160) * .05; carrierRing.scale.set(pulse, pulse, 1); }
        const onIce = new Set(shown.map(p => p.id));
        actors.forEach(a => { if (!onIce.has(a.id)) { a.group.visible = false; a.lx = NaN; } });
        const prevOf = new Map(fb.skaters.map(p => [p.id, p.pos])), prev2Of = new Map(fb2.skaters.map(p => [p.id, p.pos]));
        const alpha = 1 - Math.exp(-dTau * 9);
        let carrierW = 0;
        const poses: { figure: PlayerFigure; args: Parameters<PlayerFigure['skate']> ; w: number; carrier: boolean }[] = [];
        for (const p of shown) {
          const a = actorFor(p.id, p.side, !!p.goalie);
          const w = toWorld(p.pos), b = toWorld(prevOf.get(p.id) ?? p.pos), b2 = toWorld(prev2Of.get(p.id) ?? prevOf.get(p.id) ?? p.pos);
          a.group.visible = true;
          a.group.position.set(w.x, 0, w.z);
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
          const cheer = goal && goal.side === p.side ? clamp((tau - goal.tau) / .3, 0, 1) * (1 - smooth01((tau - goal.tau - 4) / 1.5)) * .7 : 0;
          local.copy(puckWorld); a.figure.root.worldToLocal(local);
          let reach: T.Vector3 | null = null, reachWeight = 0;
          const near = Math.hypot(local.x + .3 * hand, local.z - .85);
          if (p.move === 'reach' && pw.y < .4 && local.z > .2 && Math.hypot(local.x, local.z) < 2.8) reach = local.clone();
          if (pw.y < .25 && local.z > .1 && local.z < 1.8 && Math.abs(local.x) < 1.3 && near < 1.4 && !(shot !== undefined && shot > 0)) {
            reachWeight = (f.carrier === p.id ? 1 : .6) * (1 - smooth01((near - .55) / .85));
            carrierW = Math.max(carrierW, reachWeight);
            reach = local.clone();
          }
          poses.push({ figure: a.figure, args: [a.phase, amp * (1 - fall), shot, cheer, { bank, reach, reachWeight, kind: rel?.rel.kind, deke: p.deke, check: p.check, poke: p.poke, move: p.move, moveT: p.moveT, stagger: p.stagger, down: fall }], w: reachWeight, carrier: f.carrier === p.id });
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
        // Camera: follows a smoothed point of play, slightly ahead of the puck, in real time (not rink time).
        const lead = { x: pw.x + clamp(pv.x * .25, -4, 4), z: pw.z };
        if (!focus.init) { focus.x = lead.x; focus.z = lead.z; focus.init = true; }
        else { const k = 1 - Math.exp(-realDt * 2.6); focus.x += (lead.x - focus.x) * k; focus.z += (lead.z - focus.z) * k; }
        camSpeed += (Math.min(pSpeed, 30) - camSpeed) * (1 - Math.exp(-realDt * 1.6));
        settled = Math.hypot(lead.x - focus.x, lead.z - focus.z) < .01 && Math.abs(Math.min(pSpeed, 30) - camSpeed) < .05;
        const pose = liveCameraPose(live.current.camera, focus, live.current.zoom, aspect(), { attack: ai.attack ?? (ai.flipped ? -1 : 1), speed: camSpeed });
        camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
        camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
        if (Math.abs(camera.fov - pose.fov) > .01) { camera.fov = pose.fov; camera.updateProjectionMatrix(); }
        sun.position.set(pose.look.x + 8, 25, pose.look.z + 12); sun.target.position.set(pose.look.x, 0, pose.look.z); sun.target.updateMatrixWorld();
        camera.updateMatrixWorld();
        renderer.render(scene, camera);
        if (!readyRef) { readyRef = true; setReady(true); if (figuresDone) tickerRef.current.wait = false; }
      };
      const resize = () => {
        if (!renderer) return;
        const w = Math.max(1, element.clientWidth), h = Math.max(1, element.clientHeight);
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
      };
      observer = new ResizeObserver(resize); observer.observe(element); resize();
      // Adaptive resolution like the replay: step down while frames are slow, back up with headroom.
      let slow = 0, fast = 0, prevNow = 0;
      const tick = (now: number) => {
        if (stopped) return;
        const dt = now - prevNow; prevNow = now;
        try { update(now); } catch (e) { console.error(e); failRef.current(); return; }
        if (preset.adaptive && dt > 0 && dt < 250) {
          if (dt > 24) { slow++; fast = 0; } else if (dt < 15) { fast++; slow = 0; } else { slow = Math.max(0, slow - 1); fast = Math.max(0, fast - 1); }
          if (renderer && slow > 30 && ratio > preset.minDpr) { ratio = Math.max(preset.minDpr, ratio - .2); renderer.setPixelRatio(ratio); resize(); slow = 0; }
          else if (renderer && fast > 180 && ratio < maxRatio) { ratio = Math.min(maxRatio, ratio + .1); renderer.setPixelRatio(ratio); resize(); fast = 0; }
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
  </div>;
}
