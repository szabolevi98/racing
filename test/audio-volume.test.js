import test from 'node:test';
import assert from 'node:assert/strict';
import { getVolume, setVolume } from '../web/audio.js';

test('master volume accepts a normalized value and clamps its limits', () => {
  assert.equal(setVolume(0.42), 0.42);
  assert.equal(getVolume(), 0.42);
  assert.equal(setVolume(-1), 0);
  assert.equal(setVolume(2), 1);
  assert.equal(setVolume('invalid'), 1);
});
