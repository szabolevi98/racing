import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAP_PIPELINE_VERSION, alreadyOptimized, collapsedIndexedTriangleCount,
  restoreMaterialAlphaSemantics, triangleCount,
} from '../tools/build-maps.mjs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const dev = fs.readFileSync(new URL('../web/dev.js', import.meta.url), 'utf8');
const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const assets = fs.readFileSync(new URL('../server/assets.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const build = fs.readFileSync(new URL('../tools/build-maps.mjs', import.meta.url), 'utf8');

test('map optimizer recognizes compression and counts unchanged primitives', () => {
  const gltf = {
    extensionsUsed: ['EXT_meshopt_compression', 'KHR_texture_basisu'],
    accessors: [{ count: 12 }, { count: 8 }],
    meshes: [{ primitives: [
      { indices: 0 },
      { mode: 5, attributes: { POSITION: 1 } },
    ] }],
  };
  assert.equal(MAP_PIPELINE_VERSION, 2);
  assert.equal(alreadyOptimized(gltf), true);
  assert.equal(triangleCount(gltf), 4 + 6);
  assert.equal(alreadyOptimized({ extensionsUsed: [] }), false);
});

test('map optimizer preserves authored foliage transparency semantics', () => {
  const source = { materials: [
    { name: 'trees', alphaMode: 'BLEND' },
    { name: 'fence', alphaMode: 'MASK', alphaCutoff: 0.37 },
    { name: 'road' },
  ] };
  const candidate = { materials: [
    { name: 'trees' },
    { name: 'fence', alphaMode: 'MASK' },
    { name: 'road', alphaMode: 'BLEND' },
  ] };

  assert.equal(restoreMaterialAlphaSemantics(source, candidate), 3);
  assert.equal(candidate.materials[0].alphaMode, 'BLEND');
  assert.equal(candidate.materials[1].alphaMode, 'MASK');
  assert.equal(candidate.materials[1].alphaCutoff, 0.37);
  assert.equal(candidate.materials[2].alphaMode, undefined);
});

test('map optimizer only discounts explicitly collapsed cutter triangles', async () => {
  const indices = Buffer.alloc(12);
  [0, 1, 2, 3, 3, 3].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: indices.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: indices.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5123, count: 6, type: 'SCALAR' }],
    meshes: [{ primitives: [{ indices: 0, mode: 4 }] }],
  };
  const jsonSource = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(jsonSource.length / 4) * 4;
  const json = Buffer.alloc(jsonLength, 0x20);
  jsonSource.copy(json);
  const glb = Buffer.alloc(12 + 8 + json.length + 8 + indices.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(json.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  const binHeader = 20 + json.length;
  glb.writeUInt32LE(indices.length, binHeader);
  glb.writeUInt32LE(0x004e4942, binHeader + 4);
  indices.copy(glb, binHeader + 8);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'racing-map-test-'));
  const file = path.join(tempDir, 'collapsed.glb');
  try {
    await fsp.writeFile(file, glb);
    assert.equal(await collapsedIndexedTriangleCount(file, document), 1);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime and dev mode use different track sources', () => {
  assert.match(main, /new KTX2Loader\(\)[\s\S]*setKTX2Loader\(ktx2Loader\)[\s\S]*setMeshoptDecoder\(MeshoptDecoder\)/);
  assert.match(main, /DEV_MODE && entry\?\.master \? mapMasterUrl\(entry\) : assetUrl\(entry\)/);
  assert.match(main, /bytes: trackAssetBytes\(initialMap\)[\s\S]*setTrack\(trackAssetUrl\(initialMap\)/);
  assert.match(dev, /api\.trackAssetBytes\(entry\)[\s\S]*setTrack\(api\.trackAssetUrl\(entry\)/);
  assert.match(dev, /masters\/maps\/\$\{api\.currentMapId\}\/\$\{nev\}/);
  assert.match(mp, /bytes: G\.trackAssetBytes\(map\)[\s\S]*G\.trackAssetUrl\(map\)/);
});

test('master files stay outside webroot and behind the disabled production dev route', () => {
  assert.match(assets, /MAP_MASTERS_DIR/);
  assert.match(assets, /entry\.master\s*=\s*\{/);
  assert.match(server, /\/api\/dev\/map-master/);
  assert.match(server, /if \(!ALLOW_DEV_WRITES\)/);
  assert.match(build, /const MASTERS_DIR = path\.join\(ROOT, 'masters', 'maps'\)/);
  assert.match(build, /already optimized|már tömörített/i);
});
