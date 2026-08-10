import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  GRAVITY, CHASSIS_SIZE, buildVehicle, applyChassisMassProperties,
  FLOOR_COLLIDER_GROUPS, CAR_COLLIDER_GROUPS, GHOST_CAR_COLLIDER_GROUPS,
  CAR_PROXY_COLLIDER_GROUPS, WHEEL_RAY_FILTER_GROUPS,
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

test('a nearby dynamic proxy can physically push the local car', () => {
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

test('ghost vehicles keep track collision groups but cannot contact each other', () => {
  const normalWorld = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const ghostWorld = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const normalA = buildVehicle(RAPIER, normalWorld, { x: 0, y: 1, z: 0 });
    const normalB = buildVehicle(RAPIER, normalWorld, { x: 0, y: 1, z: 3 });
    const ghostA = buildVehicle(
      RAPIER, ghostWorld, { x: 0, y: 1, z: 0 }, { collideWithCars: false }
    );
    const ghostB = buildVehicle(
      RAPIER, ghostWorld, { x: 0, y: 1, z: 3 }, { collideWithCars: false }
    );

    normalWorld.step();
    ghostWorld.step();
    let normalContact = false;
    let ghostContact = false;
    normalWorld.contactPair(normalA.collider, normalB.collider, () => { normalContact = true; });
    ghostWorld.contactPair(ghostA.collider, ghostB.collider, () => { ghostContact = true; });

    assert.equal(normalA.collider.collisionGroups(), CAR_COLLIDER_GROUPS);
    assert.equal(ghostA.collider.collisionGroups(), GHOST_CAR_COLLIDER_GROUPS);
    assert.equal(normalContact, true);
    assert.equal(ghostContact, false);
  } finally {
    normalWorld.free();
    ghostWorld.free();
  }
});
