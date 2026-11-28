import * as T from 'three';

/**
 * Snow off the blades: a hard stop throws a fan of ice shavings out ahead of the skates (the way he slides, a little
 * up and to the sides), which falls back and fades on the ice. One pool of points for the whole rink.
 */
export function createIceSpray(scene: T.Scene, max = 360) {
  const pos = new Float32Array(max * 3), vel = new Float32Array(max * 3), life = new Float32Array(max), col = new Float32Array(max * 3);
  for (let i = 0; i < max; i++) pos[i * 3 + 1] = -50;
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  geo.setAttribute('color', new T.BufferAttribute(col, 3));
  const mat = new T.PointsMaterial({ size: .075, vertexColors: true, transparent: true, opacity: .95, depthWrite: false, sizeAttenuation: true });
  const points = new T.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 2;
  scene.add(points);
  let next = 0, owed = 0;
  // a snowy blue-white against the white ice, darker while it flies (it reads in front of the boards and the ice)
  const tint = (i: number, k: number) => { col[i * 3] = .62 + .3 * k; col[i * 3 + 1] = .72 + .24 * k; col[i * 3 + 2] = .86 + .12 * k; };
  return {
    /** A stop at (x, z) going (dx, dz) (unit) at `speed` m/s for `dt` s: shavings in proportion. */
    emit(x: number, z: number, dx: number, dz: number, speed: number, dt: number) {
      owed += dt * (40 + speed * 22);
      while (owed >= 1) {
        owed -= 1;
        const i = next; next = (next + 1) % max;
        const side = Math.random() - .5, sp = speed * (.35 + Math.random() * .45);
        // out ahead of the skates, fanned across
        const ax = dx - dz * side * 1.6, az = dz + dx * side * 1.6, n = Math.hypot(ax, az) || 1;
        pos[i * 3] = x + dx * .35 + (Math.random() - .5) * .3; pos[i * 3 + 1] = .03; pos[i * 3 + 2] = z + dz * .35 + (Math.random() - .5) * .3;
        vel[i * 3] = ax / n * sp; vel[i * 3 + 1] = .8 + Math.random() * 1.6; vel[i * 3 + 2] = az / n * sp;
        life[i] = .55 + Math.random() * .45; tint(i, 0);
      }
    },
    update(dt: number) {
      if (dt <= 0) return;
      let any = false;
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;
        any = true;
        life[i] -= dt;
        if (life[i] <= 0) { pos[i * 3 + 1] = -50; continue; }
        const k = Math.exp(-dt * 3.2);
        vel[i * 3] *= k; vel[i * 3 + 2] *= k; vel[i * 3 + 1] -= 9.8 * dt;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        if (pos[i * 3 + 1] < .015) { pos[i * 3 + 1] = .015; vel[i * 3 + 1] = 0; vel[i * 3] *= .6; vel[i * 3 + 2] *= .6; }
        tint(i, 1 - Math.min(1, life[i] / .5));
      }
      if (any) { geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; }
    },
    dispose() { scene.remove(points); geo.dispose(); mat.dispose(); },
  };
}
