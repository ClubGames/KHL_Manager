// Rebuilds src/assets/hockey-player.glb from Quaternius "Ultimate Modular Men" Casual (CC0 1.0).
// Source: gh api -H "Accept: application/vnd.github.raw" repos/trebeljahr/quaternius-showcase/contents/public/glb/modular_men/Casual.glb > Casual.glb
// npm install --no-save @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer
// node scripts/build-player-model.mjs Casual.glb src/assets/hockey-player.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const apply = (m, p) => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const world = node.getWorldMatrix();
  for (const p of mesh.listPrimitives()) {
    p.setAttribute('TEXCOORD_0', null);
    if (p.getMaterial()?.getName() === 'Hair') { mesh.removePrimitive(p); p.dispose(); continue; }
    if (!/_(Body|Legs)$/.test(node.getName()) || (node.getName().endsWith('_Body') && p.getMaterial()?.getName() === 'Skin')) continue;
    // Rest-pose |x| and y/2 in character space, baked as COLOR_0 for the kit stripe shader.
    const pos = p.getAttribute('POSITION'), n = pos.getCount(), out = new Float32Array(n * 3), el = [];
    for (let i = 0; i < n; i++) { const w = apply(world, pos.getElement(i, el)); out[i*3] = Math.min(1, Math.abs(w[0])); out[i*3+1] = Math.min(1, w[1] / 2); out[i*3+2] = 0; }
    p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(out).setBuffer(root.listBuffers()[0]));
  }
}
const rename = { Purple: 'Jersey', LightBlue: 'Pants', White: 'Skate', Skin: 'Skin', Eye: 'Eye', Eyebrows: 'Brow' };
for (const mat of root.listMaterials()) if (rename[mat.getName()]) mat.setName(rename[mat.getName()]);
await doc.transform(dedup(), weld(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizeColor: 10 }));
await io.write(process.argv[3], doc);
for (const node of root.listNodes()) if (node.getMesh()) console.log(node.getName(), node.getMesh().listPrimitives().map(p => p.getMaterial()?.getName() + ':' + p.listSemantics().join('/')).join(' '));
