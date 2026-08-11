import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findGateHit, findSpawnHit, pointToSegmentDistance } from '../shared/editorSelection.js';

const dev = fs.readFileSync(new URL('../web/dev.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/dev.html', import.meta.url), 'utf8');

test('checkpoint picking distinguishes endpoints from moving the whole gate', () => {
  const gates = [
    { x1: 0, z1: 10, x2: 20, z2: 10 },
    { x1: 0, z1: 30, x2: 20, z2: 30 },
  ];
  assert.deepEqual(findGateHit(gates, 0.25, 10.1, 2)?.part, 'p1');
  assert.deepEqual(findGateHit(gates, 19.8, 9.9, 2)?.part, 'p2');
  assert.deepEqual(findGateHit(gates, 10, 10.5, 2), { index: 0, part: 'move', distance: 0.5 });
  assert.deepEqual(findGateHit(gates, 10, 30.5, 2)?.index, 1);
  assert.equal(findGateHit(gates, 100, 100, 2), null);
  assert.equal(pointToSegmentDistance(10, 14, 0, 10, 20, 10), 4);
});

test('spawn picking distinguishes position and heading handles', () => {
  const points = [{ x: 5, z: 10, heading: Math.PI / 2 }];
  assert.equal(findSpawnHit(points, 5.2, 10, 1)?.part, 'position');
  assert.equal(findSpawnHit(points, 13, 10.2, 1)?.part, 'heading');
  assert.equal(findSpawnHit(points, 50, 50, 1), null);
});

test('dev editor keeps selected checkpoints in place and exposes drag instructions', () => {
  assert.match(dev, /findGateHit\(/);
  assert.match(dev, /selectedZoneObject = \{ kind: start \? 'start' : 'checkpoint', index: hit\.index \}/);
  assert.match(dev, /editingGate\.part === 'move'/);
  assert.match(dev, /editingSpawn\.part === 'position'/);
  assert.match(html, /meglévőre kattintva szerkesztheted/i);
  assert.match(html, /iránytű.*forgatod/i);
});
