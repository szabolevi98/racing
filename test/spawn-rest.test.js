import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { RaceController } from '../server/game/raceController.js';
import { GAME_MODE, ROOM_STATE } from '../shared/protocol.js';
import { restHeightAboveGround, forgetRestHeight } from '../shared/spawnRest.js';
import { gridSlotPose } from '../shared/grid.js';
import { WHEEL_POSITIONS, SUSPENSION_REST_LENGTH, WHEEL_RADIUS } from '../shared/vehicleConfig.js';

await RAPIER.init();

test('the measured rest height is repeatable and inside the suspension travel', () => {
  forgetRestHeight();
  const first = restHeightAboveGround(RAPIER);
  forgetRestHeight();
  const second = restHeightAboveGround(RAPIER);
  assert.equal(first, second, 'the measurement must not drift between runs');

  const extended = -WHEEL_POSITIONS[0].y + SUSPENSION_REST_LENGTH + WHEEL_RADIUS;
  assert.ok(first < extended, `${first} < ${extended}: the suspension must compress`);
  assert.ok(first > extended - SUSPENSION_REST_LENGTH, 'the car must remain within suspension travel');
});

test('the race controller uses the same grid pose as the client', async () => {
  const spawns = [
    { x: 10, z: 20, heading: 0.25 },
    { x: 8, z: 16, heading: 0.3 },
    { x: 6, z: 12, heading: 0.35 },
  ];
  const players = new Map();
  for (let i = 0; i < 5; i++) players.set(`p${i}`, { id: `p${i}`, slot: i, carId: 'car' });
  const room = {
    code: 'TEST', players, mode: GAME_MODE.MULTIPLAYER, state: ROOM_STATE.LOADING,
    laps: 1, raceGeneration: 1, raceId: 1,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
  const controller = new RaceController(room, { map: { spawns }, broadcast: () => {} });
  await controller.start();
  try {
    for (let slot = 0; slot < players.size; slot++) {
      const pose = gridSlotPose(spawns, slot);
      const car = controller.cars.get(`p${slot}`);
      assert.deepEqual(car.respawn, pose);
      assert.deepEqual([car.state.p[0], car.state.p[2]], [pose.x, pose.z]);
    }
  } finally {
    controller.stop();
  }
});

test('Hot Lap uses its dedicated start point', async () => {
  const hotLapSpawn = { x: -4, z: 27, heading: 1.2345 };
  const player = { id: 'driver', slot: 7, carId: 'car' };
  const room = {
    code: 'HOTLAP', mode: GAME_MODE.HOT_LAP, ghostMode: true,
    players: new Map([[player.id, player]]), state: ROOM_STATE.LOADING,
    laps: 1, raceGeneration: 1, raceId: 1,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
  const controller = new RaceController(room, {
    map: { spawns: Array.from({ length: 8 }, (_, i) => ({ x: i, z: -i, heading: 0 })), hotLapSpawn },
    broadcast: () => {},
  });
  await controller.start();
  try {
    assert.deepEqual(controller.cars.get(player.id).respawn, hotLapSpawn);
  } finally {
    controller.stop();
  }
});
