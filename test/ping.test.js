import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPing } from '../shared/ping.js';

test('ping quality uses the multiplayer HUD boundaries', () => {
  assert.deepEqual(classifyPing(0), { value: 0, quality: 'good' });
  assert.deepEqual(classifyPing(29), { value: 29, quality: 'good' });
  assert.deepEqual(classifyPing(30), { value: 30, quality: 'warning' });
  assert.deepEqual(classifyPing(59), { value: 59, quality: 'warning' });
  assert.deepEqual(classifyPing(60), { value: 60, quality: 'bad' });
  assert.deepEqual(classifyPing(125.6), { value: 126, quality: 'bad' });
});
