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

await RAPIER.init();

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
  } finally {
    sim.stop();
  }
});
