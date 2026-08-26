import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const batching = fs.readFileSync(new URL('../web/carVisualBatch.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const multiplayer = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');

test('car visual batching keeps risky or independently moving meshes separate', () => {
  assert.match(batching, /mesh\.isSkinnedMesh/);
  assert.match(batching, /mesh\.isInstancedMesh/);
  assert.match(batching, /mesh\.material\.transparent/);
  assert.match(batching, /mesh\.matrixWorld\.determinant\(\) < 0/);
  assert.match(batching, /mesh\.material\.uuid/);
  assert.match(batching, /mergeGeometries\(geometries, false\)/);
});

test('own and remote cars batch only after their wheel pivots exist', () => {
  assert.match(
    main,
    /const wheelRig = buildWheelPivots\([\s\S]*?batchCarVisual\(carPivot, \[carRoot, \.\.\.wheelRig\.pivots\]\)/,
  );
  assert.match(
    multiplayer,
    /createRemoteWheelRig\([\s\S]*?batchCarVisual\([\s\S]*?\[model, \.\.\.group\.userData\.wheelRig\.pivots\]/,
  );
});
