import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteExtrapolationTiming, remoteSnapshotSample } from '../shared/remoteSnapshot.js';

test('a repeated per-car state does not become fresh at every snapshot', () => {
  const previous = { t: 1_000, seq: 7 };
  assert.deepEqual(remoteSnapshotSample(previous, { at: 1_000, seq: 7 }, 1_050), {
    stateTime: 1_000,
    sequence: 7,
    isNew: false,
  });
  assert.equal(remoteSnapshotSample(previous, { at: 1_050, seq: 8 }, 1_050).isNew, true);
});

test('legacy snapshots deduplicate by sequence instead of their global time', () => {
  const previous = { t: 1_000, seq: 7 };
  assert.equal(remoteSnapshotSample(previous, { seq: 7 }, 1_050).isNew, false);
  assert.equal(remoteSnapshotSample(previous, { seq: 8 }, 1_050).isNew, true);
});

test('a server reset may update per-car time without inventing a sequence', () => {
  const previous = { t: 1_000, seq: 7 };
  assert.equal(remoteSnapshotSample(previous, { at: 1_100, seq: 7 }, 1_100).isNew, true);
});

test('extrapolated velocity stops when its position reaches the prediction cap', () => {
  assert.deepEqual(remoteExtrapolationTiming(1_000, 1_200, 250), {
    ageMs: 200,
    moving: true,
  });
  assert.deepEqual(remoteExtrapolationTiming(1_000, 1_400, 250), {
    ageMs: 250,
    moving: false,
  });
});
