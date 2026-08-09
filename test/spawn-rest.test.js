import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { getManifest } from '../server/assets.js';
import { RaceSim } from '../server/game/raceSim.js';
import { ROOM_STATE } from '../shared/protocol.js';
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

  // Teljesen kinyúlt felfüggesztéssel ilyen magasan lenne a kasztni; nyugalomban
  // ennél alacsonyabban kell állnia, de nem eshet a rugóúton túl.
  const extended = -WHEEL_POSITIONS[0].y + SUSPENSION_REST_LENGTH + WHEEL_RADIUS;
  assert.ok(first < extended, `${first} < ${extended}: a rugónak össze kell nyomódnia`);
  assert.ok(first > extended - SUSPENSION_REST_LENGTH, 'a kocsi nem ülhet a rugóút alá');
});

test('the grid pose the client uses is exactly where the server builds the car', async () => {
  const map = (await getManifest()).maps.find((entry) => entry.collision && entry.spawns?.length);
  assert.ok(map, 'a baked map with spawn points is required');

  // Több játékos, mint rajtpont: így a hátrébb sorolás ága is lefut. Ez az,
  // ami a kliensen és a szerveren korábban külön élt volna.
  const count = map.spawns.length + 2;
  const players = new Map();
  for (let i = 0; i < count; i++) players.set('p' + i, { id: 'p' + i, slot: i, carId: 'car' });
  const room = {
    code: 'TEST', players, state: ROOM_STATE.LOADING, laps: 1, mapId: map.id,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
  const sim = new RaceSim(room, { map, broadcast: () => {} });
  room.sim = sim;
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;

  try {
    for (let slot = 0; slot < count; slot++) {
      const pose = gridSlotPose(map.spawns, slot);
      const car = sim.cars.get('p' + slot);
      // A szerver a KIOSZTOTT rajtpontot őrzi meg (ide tesz vissza az "R" is) —
      // ennek bitre egyeznie kell azzal, amit a kliens számol. A magasság
      // szándékosan nincs benne: azt a szerver a pálya geometriájából keresi ki.
      assert.ok(
        Math.hypot(car.respawn.x - pose.x, car.respawn.z - pose.z) < 1e-9,
        `${slot}. rajthely: a kliens (${pose.x.toFixed(2)}, ${pose.z.toFixed(2)}) `
        + `és a szerver (${car.respawn.x.toFixed(2)}, ${car.respawn.z.toFixed(2)}) eltér`
      );
      assert.equal(car.respawn.heading, pose.heading, `${slot}. rajthely: eltérő irány`);

      // A tényleges test már leülepedett, tehát lejtőn csúszhatott néhány
      // centit — de nem méreteket. Ez fogja meg, ha a rajtrács elcsúszna.
      const body = car.body.translation();
      assert.ok(
        Math.hypot(body.x - pose.x, body.z - pose.z) < 0.5,
        `${slot}. rajthely: a kocsi ${Math.hypot(body.x - pose.x, body.z - pose.z).toFixed(2)} m-re került a rajtponttól`
      );
    }
  } finally {
    sim.stop();
  }
});

test('cars spawn already settled, so the race does not start with a drop', async () => {
  const map = (await getManifest()).maps.find((entry) => entry.collision);
  assert.ok(map, 'at least one baked map is required');

  const players = new Map([
    ['one', { id: 'one', slot: 0, carId: 'car' }],
    ['two', { id: 'two', slot: 1, carId: 'car' }],
  ]);
  const room = {
    code: 'TEST', players, state: ROOM_STATE.LOADING, laps: 3, mapId: map.id,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
  const sim = new RaceSim(room, { map, broadcast: () => {} });
  room.sim = sim;
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;

  try {
    for (const [id, car] of sim.cars) {
      const start = car.body.translation();
      const ground = sim.groundAt(start.x, start.z);
      assert.notEqual(ground, null, `${id}: a rajtpont alatt kell lennie pályának`);

      // Ott áll, ahol a felfüggesztés magától megtartja — nem fölötte.
      const height = start.y - ground;
      assert.ok(
        Math.abs(height - restHeightAboveGround(RAPIER)) < 0.05,
        `${id}: ${height.toFixed(3)} m magasan indul a mért nyugalmi magasság helyett`
      );
    }

    // A rajt utáni első képkockákon a kocsi ne mozduljon látható mértékben.
    // A régi, 1,0 méteres rajtmagasság itt 22 centit esett volna.
    const before = [...sim.cars.values()].map((car) => car.body.translation().y);
    for (let i = 0; i < 30; i++) sim.step();
    const after = [...sim.cars.values()].map((car) => car.body.translation().y);
    const moved = Math.max(...after.map((y, i) => Math.abs(y - before[i])));
    assert.ok(moved < 0.01, `a kocsi ${(moved * 100).toFixed(1)} cm-t mozdult a rajt után`);
  } finally {
    sim.stop();
  }
});
