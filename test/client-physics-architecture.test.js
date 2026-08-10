import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = (...parts) => readFileSync(resolve(root, ...parts), 'utf8');

test('online racing has one client-physics architecture without the old switch', () => {
  const protocol = source('shared', 'protocol.js');
  const websocket = source('server', 'net', 'wsServer.js');
  const client = source('web', 'mp.js');

  assert.doesNotMatch(protocol, /PHYSICS_AUTHORITY|INPUT:\s*'input'/);
  assert.doesNotMatch(websocket, /physicsAuthority|raceSim|clientRaceSim|C2S\.INPUT/);
  assert.doesNotMatch(client, /physicsAuthority|C2S\.INPUT|shared\/prediction|predict=0/);
  assert.match(websocket, /new RaceController\(/);

  assert.equal(existsSync(resolve(root, 'server', 'game', 'raceSim.js')), false);
  assert.equal(existsSync(resolve(root, 'server', 'config.js')), false);
  assert.equal(existsSync(resolve(root, 'shared', 'prediction.js')), false);
});

test('online state sequence stays monotonic across Hot Lap restarts', () => {
  const client = source('web', 'mp.js');
  const room = source('server', 'game', 'room.js');

  assert.match(client, /state:\s*\{\s*seq: inputSeq,/);
  assert.doesNotMatch(
    client,
    /function startInputLoop\(\)[\s\S]*?inputSeq\s*=\s*0[\s\S]*?const tick/,
  );
  assert.match(room, /p\.ready = false;[\s\S]*?p\.pendingInitialState = null;/);
});
