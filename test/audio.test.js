import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateDopplerFactor } from '../web/audio.js';

test('remote engine Doppler follows relative closing speed and stays subtle', () => {
  const listenerPosition = [0, 0, 0];
  const sourcePosition = [100, 0, 0];

  assert.equal(
    calculateDopplerFactor(sourcePosition, [0, 0, 0], listenerPosition, [0, 0, 0]),
    1
  );
  assert.ok(Math.abs(
    calculateDopplerFactor(sourcePosition, [-34.3, 0, 0], listenerPosition, [0, 0, 0]) - 1.1
  ) < 1e-12);
  assert.ok(Math.abs(
    calculateDopplerFactor(sourcePosition, [34.3, 0, 0], listenerPosition, [0, 0, 0]) - 0.9
  ) < 1e-12);
  assert.equal(
    calculateDopplerFactor(sourcePosition, [80, 0, 0], listenerPosition, [80, 0, 0]),
    1
  );
  assert.equal(
    calculateDopplerFactor(sourcePosition, [-300, 0, 0], listenerPosition, [0, 0, 0]),
    1.1
  );
});
