import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V = [number, number, number];
const ONE = new T.Vector3(1, 1, 1), UP = new T.Vector3(0, 1, 0);

/** Geometry collected per material key and merged at the end. Keys: '#hex' (matte), 'lit:#hex' (unlit), 'metal:#hex', 'glass'. */
export class Parts {
  private by = new Map<string, T.BufferGeometry[]>();
  private frame = new T.Matrix4();
  /** Following parts are placed in a local frame: at (x, y, z), turned by yaw (local +z faces the ice when yaw makes it so). */
  at(x: number, y: number, z: number, yaw = 0) { this.frame.compose(new T.Vector3(x, y, z), new T.Quaternion().setFromAxisAngle(UP, yaw), ONE); return this; }
  world() { this.frame.identity(); return this; }
  add(key: string, g: T.BufferGeometry, p: V, r: V = [0, 0, 0], s: V = [1, 1, 1]) {
    g.applyMatrix4(new T.Matrix4().compose(new T.Vector3(...p), new T.Quaternion().setFromEuler(new T.Euler(...r)), new T.Vector3(...s)));
    g.applyMatrix4(this.frame);
    (this.by.get(key) ?? this.by.set(key, []).get(key)!).push(g);
  }
  box(key: string, sx: number, sy: number, sz: number, p: V, r?: V) { this.add(key, new T.BoxGeometry(sx, sy, sz), p, r); }
  ball(key: string, rad: number, p: V, s: V = [1, 1, 1]) { this.add(key, new T.SphereGeometry(rad, 10, 7), p, [0, 0, 0], s); }
  cyl(key: string, rt: number, rb: number, h: number, p: V, r?: V, s?: V, seg = 8) { this.add(key, new T.CylinderGeometry(rt, rb, h, seg), p, r, s); }
  /** A round limb from a to b (local coordinates). */
  limb(key: string, rad: number, a: V, b: V, rb = rad) {
    const va = new T.Vector3(...a), vb = new T.Vector3(...b), d = vb.clone().sub(va), len = d.length();
    if (len < 1e-4) return;
    const g = new T.CylinderGeometry(rb, rad, len, 7);
    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(UP, d.normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    g.applyMatrix4(this.frame);
    (this.by.get(key) ?? this.by.set(key, []).get(key)!).push(g);
  }
  build(parent: T.Object3D, mesh: (g: T.BufferGeometry, m: T.Material, parent: T.Object3D) => T.Mesh, material: (key: string) => T.Material) {
    this.by.forEach((list, key) => {
      const g = mergeGeometries(list, false); list.forEach(x => x.dispose());
      if (g) mesh(g, material(key), parent);
    });
    this.by.clear();
  }
  /** Everything matte in one mesh, the colours painted on the vertices (one draw call for a small figure). */
  buildTinted(parent: T.Object3D, mesh: (g: T.BufferGeometry, m: T.Material, parent: T.Object3D) => T.Mesh, tinted: T.Material, material: (key: string) => T.Material) {
    const all: T.BufferGeometry[] = [], col = new T.Color();
    this.by.forEach((list, key) => {
      if (!key.startsWith('#')) return;
      col.set(key).convertSRGBToLinear();
      for (const g of list) {
        const n = g.getAttribute('position').count, c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
        g.setAttribute('color', new T.BufferAttribute(c, 3));
        all.push(g.index ? g.toNonIndexed() : g);
      }
      this.by.delete(key);
    });
    const g = mergeGeometries(all, false); all.forEach(x => x.dispose());
    if (g) mesh(g, tinted, parent);
    this.build(parent, mesh, material);
  }
}

