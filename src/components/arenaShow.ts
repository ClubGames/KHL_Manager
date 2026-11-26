import * as T from 'three';
import { RINK } from '../game/rinkGeometry';

/**
 * The arena show of the 3D match: laser beams from the lighting rigs and the corners of the bowl sweeping over
 * the ice (and their dots on it), a projection on the ice (rings and rays in the clubs' colours, as KHL arenas
 * do before the game), two follow spots, and the crowd's phone lights and camera flashes twinkling in the
 * stands. Everything is additive, unlit and cheap — a handful of draw calls: the show is on for the teams'
 * entrance and flares up briefly for a home goal; the flashes in the stands are always there (faintly).
 *
 * World space as in replayArena (metres, origin at centre ice, +y up).
 */
export type ArenaShow = {
  group: T.Group;
  /** level 0…1 (lasers, projection, spots); team colours (0 home, 1 away, −1 both); focus of the spots; burst of flashes */
  update(now: number, o: { level: number; team: 0 | 1 | -1; focus: { x: number; z: number }; burst: number; flashes: number; /** px per world unit at distance 1 (canvas height / 2·tan(fov/2)) */ scale: number }): void;
  dispose(): void;
};

const HL = RINK.length / 2, HW = RINK.width / 2;

export function buildArenaShow(colors: [string, string], detail: 'normal' | 'hi'): ArenaShow {
  const group = new T.Group(); group.name = 'arena-show';
  const geometries: T.BufferGeometry[] = [], materials: T.Material[] = [];
  const home = new T.Color(colors[0]), away = new T.Color(colors[1]);
  // a club colour that is too dark for a laser is lifted (a laser is light)
  const lift = (c: T.Color) => { const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl); return new T.Color().setHSL(hsl.h, Math.max(.75, hsl.s), Math.max(.55, hsl.l)); };
  const palette = [lift(home), lift(away), new T.Color('#38e8ff'), new T.Color('#ffffff'), new T.Color('#b84dff')];

  // ---- lasers: thin cones from fixed heads, each sweeping its own figure ----
  const beamGeo = new T.CylinderGeometry(.035, .32, 1, 6, 1, true); beamGeo.translate(0, -.5, 0); geometries.push(beamGeo);
  const beamMat = (color: T.Color) => {
    const m = new T.ShaderMaterial({
      uniforms: { uColor: { value: color.clone() }, uOpacity: { value: 0 } },
      vertexShader: 'varying float vAlong; void main() { vAlong = -position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; varying float vAlong; void main() { float a = uOpacity * (1.0 - vAlong * .55); gl_FragColor = vec4(uColor * a, a); }',
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
    });
    materials.push(m); return m;
  };
  const heads: { x: number; y: number; z: number }[] = [];
  for (const x of [-HL * .7, -HL * .25, HL * .25, HL * .7]) for (const z of [-7.5, 7.5]) heads.push({ x, y: 19, z });
  if (detail === 'hi') for (const sx of [-1, 1]) for (const sz of [-1, 1]) heads.push({ x: sx * (HL + 6), y: 13.5, z: sz * (HW + 6) });
  const dotGeo = new T.CircleGeometry(.35, 16); dotGeo.rotateX(-Math.PI / 2); geometries.push(dotGeo);
  const beams = heads.map((h, i) => {
    const color = palette[i % palette.length];
    const mat = beamMat(color);
    const mesh = new T.Mesh(beamGeo, mat); mesh.position.set(h.x, h.y, h.z); mesh.frustumCulled = false; group.add(mesh);
    const dotMat = new T.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }); materials.push(dotMat);
    const dot = new T.Mesh(dotGeo, dotMat); dot.position.y = .03; dot.renderOrder = 3; group.add(dot);
    return { head: h, mesh, mat, dot, dotMat, color, seed: i * 1.7 + .3 };
  });

  // ---- the ice projection: rings and rays in the clubs' colours, clipped to the rink ----
  const projMat = new T.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uHome: { value: lift(home) }, uAway: { value: lift(away) }, uTeam: { value: -1 }, uFocus: { value: new T.Vector2() } },
    vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime; uniform float uLevel; uniform vec3 uHome; uniform vec3 uAway; uniform float uTeam; uniform vec2 uFocus; varying vec2 vP;
      void main() {
        vec2 p = vP;
        // inside the rink (rounded corners)
        vec2 q = abs(p) - vec2(${(HL - RINK.corner).toFixed(2)}, ${(HW - RINK.corner).toFixed(2)});
        float inside = 1.0 - smoothstep(-.4, 0.0, length(max(q, 0.0)) - ${RINK.corner.toFixed(2)});
        float r = length(p), ang = atan(p.y, p.x);
        float rings = smoothstep(.75, 1.0, sin(r * 1.1 - uTime * 5.0)) * smoothstep(34.0, 4.0, r);
        float rays = smoothstep(.85, 1.0, sin(ang * 10.0 + uTime * 1.3 + r * .05)) * smoothstep(2.0, 10.0, r);
        float sweep = smoothstep(.92, 1.0, sin(p.x * .35 - uTime * 3.0));
        vec3 colA = uTeam < -.5 ? mix(uHome, uAway, step(0.0, p.x)) : (uTeam < .5 ? uHome : uAway);
        vec3 col = colA * (rings * .9 + rays * .55) + vec3(.75, .9, 1.0) * sweep * .35;
        // the follow spot pool
        float spot = smoothstep(7.0, 1.5, length(p - uFocus)) * step(-.5, uTeam);
        col += vec3(1.0, .97, .9) * spot * .55;
        float a = uLevel * inside;
        gl_FragColor = vec4(col * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
  });
  materials.push(projMat);
  const projGeo = new T.PlaneGeometry(HL * 2, HW * 2, 1, 1); geometries.push(projGeo);
  const proj = new T.Mesh(projGeo, projMat); proj.rotation.x = -Math.PI / 2; proj.position.y = .02; proj.renderOrder = 1;
  // plane x → world x, plane y → world −z (the shader only uses distances and the x sign; the spot is mapped)
  group.add(proj);

  // ---- the follow spots' beams (two soft cones from the roof onto the focus) ----
  const coneGeo = new T.CylinderGeometry(.4, 4.2, 1, 20, 1, true); coneGeo.translate(0, -.5, 0); geometries.push(coneGeo);
  const coneMat = beamMat(new T.Color('#fff4dc'));
  const cones = [-1, 1].map(s => { const m = new T.Mesh(coneGeo, coneMat); m.position.set(s * 14, 19.5, 6); m.frustumCulled = false; group.add(m); return m; });

  // ---- the crowd: phone lights and camera flashes ----
  const count = detail === 'hi' ? 1600 : 700;
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  let s = 12345; const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < count; i++) {
    // a point on the stands: out from the boards (lower tier 5.2…12.6 m up to 6.9 m, upper 13.5…21 m up to 13.6 m)
    const upper = rand() < .45, o = upper ? 13.5 + rand() * 7.5 : 5.2 + rand() * 7.4;
    const y = upper ? 8.75 + (o - 13.5) / 7.5 * 4.85 : 1.9 + (o - 5.2) / 7.4 * 5;
    const a = rand() * Math.PI * 2;
    // around the rounded rink outline, pushed out by o
    const cx = HL - RINK.corner, cz = HW - RINK.corner, R = RINK.corner + o;
    let x = Math.cos(a) * (cx + R), z = Math.sin(a) * (cz + R);
    const ex = Math.abs(x) - cx, ez = Math.abs(z) - cz;
    if (ex > 0 && ez > 0) { const d = Math.hypot(ex, ez); x = Math.sign(x) * (cx + ex / d * R); z = Math.sign(z) * (cz + ez / d * R); }
    else if (ex > 0) x = Math.sign(x) * (cx + R); else z = Math.sign(z) * (cz + R);
    pos.set([x, y + .9, z], i * 3); seed[i] = rand();
  }
  const flashGeo = new T.BufferGeometry();
  flashGeo.setAttribute('position', new T.BufferAttribute(pos, 3)); flashGeo.setAttribute('seed', new T.BufferAttribute(seed, 1));
  geometries.push(flashGeo);
  const flashMat = new T.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLevel: { value: .3 }, uBurst: { value: 0 }, uScale: { value: 300 } },
    vertexShader: `attribute float seed; uniform float uTime; uniform float uLevel; uniform float uBurst; uniform float uScale; varying float vA; varying float vPhone;
      void main() {
        vPhone = step(.6, fract(seed * 7.13));
        // camera flashes: short sharp pops; phone lights: a steady glow that sways
        float pop = pow(max(0.0, sin(uTime * (1.3 + seed * 2.1) + seed * 40.0)), 60.0) * (1.0 + uBurst * 2.0);
        float phone = vPhone * uLevel * (.55 + .45 * sin(uTime * 1.7 + seed * 30.0));
        vA = clamp(max(pop * (.35 + uLevel), phone), 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, (vPhone > .5 ? .22 : .5) * uScale / -mv.z * (.4 + vA));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: 'varying float vA; varying float vPhone; void main() { vec2 d = gl_PointCoord - .5; float a = vA * smoothstep(.5, .0, length(d)); if (a < .01) discard; gl_FragColor = vec4(mix(vec3(1.0, .98, .92), vec3(.85, .93, 1.0), vPhone) * a, a); }',
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
  });
  materials.push(flashMat);
  const flashes = new T.Points(flashGeo, flashMat); flashes.frustumCulled = false; group.add(flashes);

  const target = new T.Vector3(), dir = new T.Vector3(), down = new T.Vector3(0, -1, 0);
  return {
    group,
    update(now, o) {
      const t = now / 1000, L = o.level;
      flashMat.uniforms.uTime.value = t; flashMat.uniforms.uLevel.value = Math.max(L, o.flashes * .25); flashMat.uniforms.uBurst.value = o.burst; flashMat.uniforms.uScale.value = o.scale;
      flashes.visible = o.flashes > 0 || L > 0;
      const show = L > .01;
      proj.visible = show; cones.forEach(c => { c.visible = show && o.team >= 0; });
      beams.forEach(b => { b.mesh.visible = b.dot.visible = show; });
      if (!show) return;
      projMat.uniforms.uTime.value = t; projMat.uniforms.uLevel.value = L * .8; projMat.uniforms.uTeam.value = o.team;
      projMat.uniforms.uFocus.value.set(o.focus.x, -o.focus.z);
      beams.forEach((b, i) => {
        // each head draws its own sweeping figure over the ice; the beams of one team's colour flare for its entrance
        const ph = t * (.55 + (i % 3) * .17) + b.seed;
        target.set(Math.sin(ph) * 22 + Math.sin(ph * .37) * 6, 0, Math.cos(ph * 1.3) * 11);
        if (o.team >= 0 && i % 2 === 0) target.lerp(new T.Vector3(o.focus.x, 0, o.focus.z), .6);
        dir.copy(target).sub(b.mesh.position);
        const len = dir.length(); dir.normalize();
        b.mesh.quaternion.setFromUnitVectors(down, dir); b.mesh.scale.set(1, len, 1);
        const strong = o.team < 0 || (i % 5 === o.team) || i % 5 > 1 ? 1 : .35;
        b.mat.uniforms.uOpacity.value = L * .85 * strong * (.75 + .25 * Math.sin(t * 9 + i));
        b.dot.position.set(target.x, .03, target.z); b.dotMat.opacity = L * strong;
      });
      cones.forEach(c => {
        dir.set(o.focus.x, 0, o.focus.z).sub(c.position); const len = dir.length(); dir.normalize();
        c.quaternion.setFromUnitVectors(down, dir); c.scale.set(1, len, 1);
      });
      coneMat.uniforms.uOpacity.value = L * .16;
    },
    dispose() { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); group.removeFromParent(); },
  };
}
