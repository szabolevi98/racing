import test from 'node:test';
import assert from 'node:assert/strict';

import { connectedVertexComponents } from '../shared/meshTopology.js';

test('nearby but disconnected road and fence meshes stay in separate components', () => {
  const components = connectedVertexComponents(8, new Uint32Array([
    0, 1, 2, 2, 1, 3,
    4, 5, 6, 6, 5, 7,
  ]));

  assert.equal(components[0], components[3]);
  assert.equal(components[4], components[7]);
  assert.notEqual(components[0], components[4]);
});

test('invalid mesh indices fail instead of silently mixing components', () => {
  assert.throws(
    () => connectedVertexComponents(3, new Uint32Array([0, 1, 3])),
    /kívül esik/,
  );
});
