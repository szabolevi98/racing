import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  GRAVITY, CHASSIS_SIZE, CHASSIS_MASS, buildVehicle,
  FLOOR_COLLIDER_GROUPS, WALL_COLLIDER_GROUPS,
  CAR_COLLIDER_GROUPS, GHOST_CAR_COLLIDER_GROUPS, CAR_WALL_QUERY_GROUPS,
  WHEEL_RAY_FILTER_GROUPS, TRACK_FRICTION, WALL_FRICTION,
} from '../shared/vehicleConfig.js';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');

await RAPIER.init();

function simulateWallBrush(wallFriction, combineRule) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = 1 / 60;
  try {
    const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.1, 3, 100)
        .setTranslation(CHASSIS_SIZE.x + 0.1, 0, 0)
        .setFriction(wallFriction)
        .setFrictionCombineRule(combineRule)
        .setRestitution(0),
      wallBody,
    );
    const carBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0).setCcdEnabled(true),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(CHASSIS_SIZE.x, CHASSIS_SIZE.y, CHASSIS_SIZE.z)
        .setMass(CHASSIS_MASS),
      carBody,
    );
    carBody.setLinvel({ x: 5, y: 0, z: 80 }, true);
    for (let i = 0; i < 30; i++) world.step();
    return carBody.linvel().z;
  } finally {
    world.free();
  }
}

test('the suspension ray sees the floor through the canonical car filter', () => {
  const world = new RAPIER.World(GRAVITY);
  try {
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(20, 0.1, 20)
        .setTranslation(0, -0.1, 0)
        .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
      floorBody
    );
    const other = buildVehicle(RAPIER, world, { x: 0, y: 1, z: 0 });
    world.step();

    const ray = new RAPIER.Ray({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 10, true, undefined, WHEEL_RAY_FILTER_GROUPS);
    assert.equal(hit?.collider?.handle, floor.handle);
    assert.notEqual(hit?.collider?.handle, other.collider.handle);
  } finally {
    world.free();
  }
});

test('track walls slide on a light brush without weakening tyre grip', () => {
  assert.equal(TRACK_FRICTION, 1.0);
  assert.equal(WALL_FRICTION, 0.2);
  assert.match(main,
    /trimesh\(wall\.positions, wall\.indices\)[\s\S]{0,200}\.setFriction\(WALL_FRICTION\)[\s\S]{0,200}\.setFrictionCombineRule\(RAPIER\.CoefficientCombineRule\.Min\)[\s\S]{0,120}\.setRestitution\(0\)/,
  );
  assert.match(main,
    /trimesh\(floor\.positions, floor\.indices\)[\s\S]{0,160}\.setFriction\(TRACK_FRICTION\)/,
  );

  const oldWallSpeed = simulateWallBrush(1.0, RAPIER.CoefficientCombineRule.Average);
  const newWallSpeed = simulateWallBrush(WALL_FRICTION, RAPIER.CoefficientCombineRule.Min);
  assert.ok(newWallSpeed > oldWallSpeed + 2, `${newWallSpeed} vs old ${oldWallSpeed} m/s`);
});

test('multiplayer has no movable remote rigid body or Rapier proxy correction path', () => {
  assert.match(main, /const remoteCarContacts = new Map\(\)/);
  assert.match(main, /resolveCarContact\(/);
  assert.doesNotMatch(main, /remoteCarProxies/);
  assert.doesNotMatch(main, /world\.contactPair\(chassisCollider/);
  assert.doesNotMatch(main, /setRemoteCarContact[\s\S]{0,2000}RigidBodyDesc\.dynamic/);
  assert.doesNotMatch(mp, /setRemoteCarProxy|proxyPose|proxyActive/);
});

test('custom car contact changes only horizontal position, speed and yaw', () => {
  assert.match(main,
    /x: wallSafe\.position\.x,[\s\S]{0,80}y: position\.y,[\s\S]{0,80}z: wallSafe\.position\.z/);
  assert.match(main,
    /setLinvel\(\{ x: ownVelocity\.x, y: velocity\.y, z: ownVelocity\.z \}, true\)/);
  assert.match(main,
    /setAngvel\(\{[\s\S]{0,120}x: angularVelocity\.x,[\s\S]{0,120}y: yawRate,[\s\S]{0,120}z: angularVelocity\.z/);
});

test('contact separation is shape-cast against the real track wall', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const own = buildVehicle(RAPIER, world, { x: 0, y: 1, z: 0 });
    const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const wall = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.1, 3, 10)
        .setTranslation(2.5, 1, 0)
        .setCollisionGroups(WALL_COLLIDER_GROUPS),
      wallBody,
    );
    world.step();
    const hit = world.castShape(
      own.body.translation(),
      own.body.rotation(),
      { x: 3, y: 0, z: 0 },
      own.collider.shape,
      0.02,
      1,
      false,
      undefined,
      CAR_WALL_QUERY_GROUPS,
      own.collider,
      own.body,
    );
    assert.equal(hit?.collider?.handle, wall.handle);
    assert.ok(hit.time_of_impact > 0 && hit.time_of_impact < 1);
    assert.match(main, /world\.castShape\([\s\S]{0,500}CAR_WALL_QUERY_GROUPS/);
  } finally {
    world.free();
  }
});

test('normal and ghost cars share one chassis while ghost mode disables car contact', () => {
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
    assert.match(mp, /if \(starting\?\.ghostMode === true \|\| room\?\.ghostMode === true\) return;/);
  } finally {
    normalWorld.free();
    ghostWorld.free();
  }
});
