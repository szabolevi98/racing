import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { getManifest } from '../server/assets.js';
import { RaceSim } from '../server/game/raceSim.js';
import { ROOM_STATE } from '../shared/protocol.js';
import {
  GRAVITY, CHASSIS_SIZE, buildVehicle, applyChassisMassProperties,
  FLOOR_COLLIDER_GROUPS, CAR_PROXY_COLLIDER_GROUPS, WHEEL_RAY_FILTER_GROUPS,
} from '../shared/vehicleConfig.js';
import {
  conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rebasePredictedState,
} from '../shared/prediction.js';

await RAPIER.init();

test('prediction correction maps the acknowledged past onto the present without rollback', () => {
  const half = Math.PI / 4;
  const predicted = { p: [10, 2, 20], q: [0, 0, 0, 1], v: [0, 0, 8], w: [0, 0.2, 0] };
  const authoritative = { p: [12, 2, 18], q: [0, Math.sin(half), 0, Math.cos(half)], v: [8, 0, 0], w: [0, 0.2, 0] };
  const current = { p: [10, 2, 25], q: [0, 0, 0, 1], v: [0, 0, 10], w: [0, 0.3, 0] };
  const dq = normalizeQuaternion(multiplyQuaternions(
    authoritative.q,
    conjugateQuaternion(predicted.q)
  ));
  const correctedAnchor = rebasePredictedState(predicted, predicted, authoritative, dq);
  assert.deepEqual(correctedAnchor.p.map((n) => +n.toFixed(6)), authoritative.p);
  assert.deepEqual(correctedAnchor.q.map((n) => +n.toFixed(6)), authoritative.q.map((n) => +n.toFixed(6)));
  assert.deepEqual(correctedAnchor.v.map((n) => +n.toFixed(6)), authoritative.v);

  const correctedCurrent = rebasePredictedState(current, predicted, authoritative, dq);
  assert.deepEqual(correctedCurrent.p.map((n) => +n.toFixed(6)), [17, 2, 18]);
  assert.ok(Math.abs(Math.hypot(...correctedCurrent.q) - 1) < 1e-9);
});

test('the suspension ray sees the floor, not another car proxy', () => {
  const world = new RAPIER.World(GRAVITY);
  try {
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(20, 0.1, 20)
        .setTranslation(0, -0.1, 0)
        .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
      floorBody
    );
    const proxyBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setGravityScale(0)
    );
    const proxy = world.createCollider(
      RAPIER.ColliderDesc.cuboid(CHASSIS_SIZE.x, CHASSIS_SIZE.y, CHASSIS_SIZE.z)
        .setCollisionGroups(CAR_PROXY_COLLIDER_GROUPS),
      proxyBody
    );
    applyChassisMassProperties(proxy, proxyBody);
    world.step();

    const ray = new RAPIER.Ray({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 10, true, undefined, WHEEL_RAY_FILTER_GROUPS);
    assert.equal(hit?.collider?.handle, floor.handle);
  } finally {
    world.free();
  }
});

test('a nearby dynamic proxy can physically push the predicted car', () => {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = 1 / 60;
  try {
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(20, 0.1, 20)
        .setTranslation(0, -0.1, 0)
        .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
      floorBody
    );
    const own = buildVehicle(RAPIER, world, { x: 0, y: 1, z: 0 });
    const proxyBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 4)
        .setGravityScale(0)
        .setCanSleep(false)
        .setCcdEnabled(true)
    );
    const proxy = world.createCollider(
      RAPIER.ColliderDesc.cuboid(CHASSIS_SIZE.x, CHASSIS_SIZE.y, CHASSIS_SIZE.z)
        .setCollisionGroups(CAR_PROXY_COLLIDER_GROUPS),
      proxyBody
    );
    applyChassisMassProperties(proxy, proxyBody);
    world.step();

    const before = own.body.translation();
    for (let i = 0; i < 30; i++) {
      proxyBody.setTranslation({ x: 0, y: 1, z: 4 - i * 0.2 }, true);
      proxyBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      proxyBody.setLinvel({ x: 0, y: 0, z: -12 }, true);
      proxyBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      own.vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
      world.step();
    }
    const after = own.body.translation();
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 0.5);
    assert.ok(after.y < 1.5, 'the proxy must not launch the car vertically');
  } finally {
    world.free();
  }
});

test('leaving a running race removes the server body, collider and controller', async () => {
  const map = (await getManifest()).maps.find((entry) => entry.collision);
  assert.ok(map, 'at least one baked map is required');
  const players = new Map([
    ['one', { id: 'one', slot: 0, carId: 'car' }],
    ['two', { id: 'two', slot: 1, carId: 'car' }],
  ]);
  const room = {
    code: 'TEST', players, state: ROOM_STATE.LOADING, laps: 3,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
  const snapshots = [];
  const sim = new RaceSim(room, {
    map,
    broadcast: (type, data) => { if (type === 'snapshot') snapshots.push(data); },
  });
  room.sim = sim;
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  try {
    const before = {
      bodies: sim.world.bodies.len(),
      colliders: sim.world.colliders.len(),
      controllers: sim.world.vehicleControllers.size,
    };
    sim.step();
    assert.equal(sim.cars.get('one').queueUnderflows, 0, 'loading is not a network underflow');
    const settledY = sim.cars.get('one').body.translation().y;
    sim.step();
    assert.ok(
      Math.abs(sim.cars.get('one').body.translation().y - settledY) < 0.01,
      'the first visible frozen ticks must start on settled suspension'
    );

    // A célba ért autó kapjon nulla motort és kormányt, viszont fékezzen,
    // majd pontosan nullán álljon meg — ne billenjen át hátramenetbe.
    const finishedCar = sim.cars.get('two');
    finishedCar.race.finished = true;
    finishedCar.input = { seq: 1, throttle: 1, steer: 1, brake: true, handbrake: true };
    finishedCar.body.setLinvel({ x: 0, y: 0, z: 10 }, true);
    sim.releaseAt(0);
    sim.step();
    assert.equal(finishedCar.vehicle.wheelEngineForce(2), 0);
    assert.equal(finishedCar.vehicle.wheelSteering(0), 0);
    assert.ok(finishedCar.vehicle.wheelBrake(0) > 0);
    assert.ok(finishedCar.body.linvel().z > 1, 'the finished car must clear the finish line first');
    for (let i = 0; i < 180; i++) sim.step();
    const stoppedAt = finishedCar.body.translation().z;
    assert.ok(Math.hypot(finishedCar.body.linvel().x, finishedCar.body.linvel().z) < 0.01);
    for (let i = 0; i < 30; i++) sim.step();
    assert.ok(Math.abs(finishedCar.body.translation().z - stoppedAt) < 0.01, 'must not roll backwards');
    finishedCar.race.finished = false;

    // A HUD rése ugyanazon hiteles checkpoint szerveridejének különbsége.
    // Ne a pillanatnyi métertávolságból becsüljünk időt.
    const leader = sim.cars.get('one');
    const splitBase = sim.simTimeMs - 2000;
    leader.race.progressKey = 1;
    leader.race.splits.set(1, splitBase);
    finishedCar.race.progressKey = 1;
    finishedCar.race.splits.set(1, splitBase + 750);
    sim.sendSnapshot(sim.simTimeMs + 0.001);
    const timedCars = snapshots.at(-1).cars;
    assert.equal(timedCars.find((car) => car.id === 'one').gap, 0);
    assert.equal(timedCars.find((car) => car.id === 'two').gap, 750);

    assert.equal(sim.removeCar('two'), true);
    assert.equal(sim.cars.size, 1);
    assert.equal(sim.world.bodies.len(), before.bodies - 1);
    assert.equal(sim.world.colliders.len(), before.colliders - 1);
    assert.equal(sim.world.vehicleControllers.size, before.controllers - 1);

    for (let seq = 1; seq <= 20; seq++) sim.queueInput('one', { seq, throttle: 1 });
    assert.equal(sim.cars.get('one').queue.length, 12);
    assert.equal(sim.cars.get('one').queueDrops, 8);
    sim.releaseAt(0);
    // A release nullázza a betöltési diagnosztikát, de magát a bemenetsort nem.
    assert.equal(sim.cars.get('one').queueDrops, 0);
    for (let i = 0; i < 13; i++) {
      sim.step();
    }
    assert.equal(sim.cars.get('one').queueUnderflows, 1);
    const times = snapshots.map((snapshot) => snapshot.t);
    assert.ok(times.length >= 3);
    assert.ok(times.every((time, i) => i === 0 || time > times[i - 1]));

    // Az utolsó bent maradt autó célba érése a fizikai lépés közepén
    // felszabadítja a világot. A step ezután nem próbálhat snapshotot
    // készíteni a már érvénytelen Rapier referenciákból.
    sim.cars.get('one').race.finished = true;
    assert.doesNotThrow(() => sim.step());
    assert.equal(sim.world, null);
  } finally {
    sim.stop();
  }
});
