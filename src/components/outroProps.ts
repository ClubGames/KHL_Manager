import * as T from 'three';
import { CARPET, CUP_TABLE } from './matchOutro';

/**
 * The props of the post-match scene (three.js; the plan is matchOutro's): the Cup (a silver bowl on a stepped
 * base), the table it stands on and the red carpet rolled out to it from the boards, confetti falling from the roof,
 * the sticks and gloves thrown into the air at the final siren.
 */
export type OutroProps = {
  group: T.Group;
  /** the Cup: its origin is where the hands hold it (the bowl's waist) */
  cup: T.Group;
  /** the carpet rolled out 0…1, the table set 0…1 */
  set(carpet: number, table: number): void;
  /** the Cup on the table (where its grip point is then) */
  tableGrip: T.Vector3;
  /** confetti: how much is falling 0…1 at `t` seconds */
  confetti(level: number, t: number): void;
  /** the thrown sticks and gloves: `throws` resolved to world positions; posed at `t` */
  throws(t: number): void;
  dispose(): void;
};
export type OutroThrow = { t: number; from: { x: number; z: number }; to: { x: number; z: number }; seed: number; glove: boolean; color: string };

/** The Cup's profile (radius, height) from the foot up: a stepped base, the stem, the wide bowl with its rim. */
const CUP_PROFILE: [number, number][] = [
  [0, 0], [.17, 0], [.17, .05], [.15, .06], [.15, .12], [.13, .13], [.13, .2], [.1, .22], [.07, .25], [.055, .3],
  [.05, .36], [.06, .4], [.09, .43], [.14, .46], [.22, .5], [.29, .55], [.32, .6], [.33, .64], [.34, .66], [.335, .68], [.3, .67], [0, .62],
];
/** The grip point's height above the Cup's foot (the hands hold it at the waist under the bowl). */
export const CUP_GRIP = .42;

export function buildOutroProps(o: { colors: [string, string]; detail: 'normal' | 'hi'; throws: OutroThrow[]; cup: boolean }): OutroProps {
  const geometries: T.BufferGeometry[] = [], materials: T.Material[] = [];
  const geo = <G extends T.BufferGeometry>(g: G) => { geometries.push(g); return g; };
  const mat = <M extends T.Material>(m: M) => { materials.push(m); return m; };
  const group = new T.Group();
  // ---- the Cup ----
  const silver = mat(new T.MeshStandardMaterial({ color: '#dfe3e8', metalness: 1, roughness: .18 }));
  const gold = mat(new T.MeshStandardMaterial({ color: '#d8b04a', metalness: 1, roughness: .25 }));
  const cup = new T.Group();
  const body = new T.Mesh(geo(new T.LatheGeometry(CUP_PROFILE.map(([r, h]) => new T.Vector2(r, h)), o.detail === 'hi' ? 40 : 24)), silver);
  body.position.y = -CUP_GRIP; body.castShadow = true; cup.add(body);
  // a gold band round the base and the handles on the bowl
  const band = new T.Mesh(geo(new T.CylinderGeometry(.152, .152, .03, 24, 1, true)), gold); band.position.y = .09 - CUP_GRIP; cup.add(band);
  for (const s of [-1, 1]) { const h = new T.Mesh(geo(new T.TorusGeometry(.06, .012, 6, 14, Math.PI)), silver); h.position.set(s * .31, .57 - CUP_GRIP, 0); h.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2; cup.add(h); }
  cup.visible = false; group.add(cup);
  // ---- the carpet and the table ----
  const red = mat(new T.MeshStandardMaterial({ color: '#a3121e', roughness: .85 }));
  const carpetLen = CARPET.z0 - CARPET.z1;
  const carpet = new T.Mesh(geo(new T.PlaneGeometry(CARPET.width, 1)), red);
  carpet.rotation.x = -Math.PI / 2; carpet.position.set(CARPET.x, .012, CARPET.z0); carpet.visible = false; carpet.receiveShadow = true; group.add(carpet);
  const table = new T.Group();
  const cloth = mat(new T.MeshStandardMaterial({ color: '#0f2a5c', roughness: .7 })), white = mat(new T.MeshStandardMaterial({ color: '#f4f6f8', roughness: .6 }));
  const top = new T.Mesh(geo(new T.BoxGeometry(1.5, .06, .8)), white); top.position.y = CUP_TABLE.h - .03; top.castShadow = true;
  const skirt = new T.Mesh(geo(new T.BoxGeometry(1.48, CUP_TABLE.h - .06, .78)), cloth); skirt.position.y = (CUP_TABLE.h - .06) / 2;
  table.add(top, skirt); table.position.set(CUP_TABLE.x, 0, CUP_TABLE.z); table.visible = false; group.add(table);
  const tableGrip = new T.Vector3(CUP_TABLE.x, CUP_TABLE.h + CUP_GRIP, CUP_TABLE.z);
  // ---- confetti: little squares in the teams' colours, gold and silver, fluttering down over the ice ----
  const nConf = o.cup ? (o.detail === 'hi' ? 900 : 420) : 0;
  let conf: T.InstancedMesh | null = null;
  const seeds: { x: number; z: number; ph: number; v: number; spin: number }[] = [];
  if (nConf) {
    const confMat = mat(new T.MeshBasicMaterial({ side: T.DoubleSide, toneMapped: false }));
    conf = new T.InstancedMesh(geo(new T.PlaneGeometry(.09, .06)), confMat, nConf);
    conf.frustumCulled = false;
    const palette = [o.colors[0], o.colors[1], '#ffd23f', '#e8edf2', '#ffffff'].map(c => new T.Color(c));
    let r = 7;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < nConf; i++) {
      seeds.push({ x: (rnd() - .5) * 46, z: (rnd() - .5) * 26, ph: rnd() * 30, v: .9 + rnd() * .7, spin: rnd() * 6 });
      conf.setColorAt(i, palette[i % palette.length]);
    }
    conf.count = 0; group.add(conf);
  }
  // ---- the thrown sticks and gloves ----
  const black = mat(new T.MeshStandardMaterial({ color: '#15181d', roughness: .5 }));
  const shaftGeo = geo(new T.CylinderGeometry(.016, .016, 1.48, 6)), bladeGeo = geo(new T.BoxGeometry(.31, .065, .018)), gloveGeo = geo(new T.BoxGeometry(.2, .12, .14));
  const flying = o.throws.map(th => {
    const g = new T.Group();
    if (th.glove) g.add(new T.Mesh(gloveGeo, mat(new T.MeshStandardMaterial({ color: th.color, roughness: .6 }))));
    else { const s = new T.Mesh(shaftGeo, black); const b = new T.Mesh(bladeGeo, black); b.position.set(.13, -.72, 0); g.add(s, b); }
    g.visible = false; group.add(g);
    return { th, g };
  });
  const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), p = new T.Vector3(), one = new T.Vector3(1, 1, 1);
  return {
    group, cup, tableGrip,
    set(c, tb) {
      carpet.visible = c > .01;
      if (carpet.visible) { const len = carpetLen * c; carpet.scale.set(1, len, 1); carpet.position.z = CARPET.z0 - len / 2; }
      table.visible = tb > .01;
      if (table.visible) table.scale.set(1, Math.max(.01, tb), 1);
    },
    confetti(level, t) {
      if (!conf) return;
      const n = Math.round(nConf * Math.min(1, level));
      conf.count = n;
      for (let i = 0; i < n; i++) {
        const s = seeds[i], fall = (t * s.v + s.ph) % 15;
        p.set(s.x + Math.sin(t * 1.3 + s.ph) * .5, 15 - fall, s.z + Math.cos(t * 1.1 + s.ph) * .4);
        e.set(t * s.spin, t * s.spin * .7, s.ph); q.setFromEuler(e);
        conf.setMatrixAt(i, m4.compose(p, q, one));
      }
      conf.instanceMatrix.needsUpdate = true;
    },
    throws(t) {
      for (const { th, g } of flying) {
        const u = (t - th.t) / 1.15;
        g.visible = u > 0;
        if (!g.visible) continue;
        const k = Math.min(1, u);
        // up out of his hands, spinning, down onto the ice where it then lies flat
        const h = k < 1 ? 1.3 + Math.sin(Math.PI * k) * (th.glove ? 2.6 : 3.4) - 1.3 * k : (th.glove ? .06 : .03);
        g.position.set(th.from.x + (th.to.x - th.from.x) * k, Math.max(th.glove ? .06 : .03, h), th.from.z + (th.to.z - th.from.z) * k);
        if (k < 1) g.rotation.set(t * (4 + th.seed * 5), th.seed * 6, t * (3 + th.seed * 3));
        else g.rotation.set(th.glove ? 0 : Math.PI / 2, th.seed * 6, 0);
      }
    },
    dispose() { group.removeFromParent(); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); conf?.dispose(); },
  };
}
