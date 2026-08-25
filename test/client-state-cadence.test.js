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
