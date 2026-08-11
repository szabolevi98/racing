import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPing, HIGH_PING_ALERT_MS, shouldWarnAboutPing } from '../shared/ping.js';

test('ping quality uses the multiplayer HUD boundaries', () => {
  assert.deepEqual(classifyPing(0), { value: 0, quality: 'good' });
  assert.deepEqual(classifyPing(29), { value: 29, quality: 'good' });
  assert.deepEqual(classifyPing(30), { value: 30, quality: 'warning' });
  assert.deepEqual(classifyPing(59), { value: 59, quality: 'warning' });
  assert.deepEqual(classifyPing(60), { value: 60, quality: 'bad' });
  assert.deepEqual(classifyPing(125.6), { value: 126, quality: 'bad' });
});

// A doboz színe és a figyelmeztető sáv KÜLÖN küszöbön váltson: 60 és 100
// között a ping már piros, de a játék még játszható, tehát a sávnak nincs
// mit mondania.
test('the warning banner has its own threshold, well above the red colour', () => {
  assert.equal(HIGH_PING_ALERT_MS, 100);
  for (const ms of [0, 29, 30, 59, 60, 75, 99, 99.4]) {
    assert.equal(shouldWarnAboutPing(ms), false, `${ms} ms-nál még ne szóljon`);
  }
  for (const ms of [99.5, 100, 140, 400]) {
    assert.equal(shouldWarnAboutPing(ms), true, `${ms} ms-nál már szóljon`);
  }
  // A színezés ettől függetlenül marad 60-tól piros.
  assert.equal(classifyPing(60).quality, 'bad');
  assert.equal(shouldWarnAboutPing(60), false, 'piros ping még nem jelent figyelmeztetést');
});
