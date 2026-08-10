import test from 'node:test';
import assert from 'node:assert/strict';
import { raceClockTimes } from '../shared/raceClock.js';

test('Hot Lap current and total clocks both exclude the warm-up', () => {
  const times = raceClockTimes({
    now: 25_000,
    raceStartedAt: 10_000,
    lapStartedAt: 20_000,
    hotLap: true,
  });

  assert.deepEqual(times, { currentTime: 5_000, totalTime: 5_000 });
});

test('multiplayer total clock still starts with the race', () => {
  const times = raceClockTimes({
    now: 25_000,
    raceStartedAt: 10_000,
    lapStartedAt: 20_000,
    hotLap: false,
  });

  assert.deepEqual(times, { currentTime: 5_000, totalTime: 15_000 });
});
