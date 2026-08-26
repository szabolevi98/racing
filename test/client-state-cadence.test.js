import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TICK_RATE, CLIENT_STATE_RATE, CLIENT_STATE_INTERVAL_TICKS, clientStateSendDue,
} from '../shared/protocol.js';

test('a 60 Hz-es helyi fizika mellett 30 állapot megy ki másodpercenként', () => {
  assert.equal(TICK_RATE, 60);
  assert.equal(CLIENT_STATE_RATE, 30);
  assert.equal(CLIENT_STATE_INTERVAL_TICKS, 2);
  const sent = Array.from({ length: TICK_RATE }, (_, phase) => clientStateSendDue(phase));
  assert.equal(sent.filter(Boolean).length, CLIENT_STATE_RATE);
  assert.deepEqual(sent.slice(0, 6), [true, false, true, false, true, false]);
});

test('a hálózati ritkítás nem ritkítja a fizikai lépést', () => {
  const client = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
  assert.match(client, /G\.stepLocalPhysics\(/);
  assert.match(client, /const sendStateNow = shouldSend && clientStateSendDue\(stateSendPhase\)/);
  assert.match(client, /if \(sendStateNow && !backlogFull\)/);
  assert.match(client, /seq: sendStateNow \? \+\+inputSeq : inputSeq/);
});

test('a fix helyi fizika a képkocka elején fut, nem versengő timerben', () => {
  const client = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
  assert.match(client, /function pumpInputLoop\(now = performance\.now\(\)\)/);
  assert.match(client, /while \(nextInputTickAt <= now && steps < 3\)/);
  assert.match(client, /const latestCatchupStart = now - TICK_MS \* 2/);
  assert.match(client, /shiftPredictionTimeline\(droppedMs\)/);
  assert.match(
    client,
    /flushPendingSnapshot\(1\);\s*const nowLocal = performance\.now\(\);\s*pumpInputLoop\(nowLocal\);[\s\S]*?interpolatedPhys\(nowLocal\)/,
  );
  assert.doesNotMatch(client, /inputTimer|setTimeout\(tick/);
});
