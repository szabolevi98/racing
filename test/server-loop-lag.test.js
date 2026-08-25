import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLoopLagDiagnostic, measureServerWork } from '../server/loopLag.js';

const wsServer = fs.readFileSync(new URL('../server/net/wsServer.js', import.meta.url), 'utf8');
const raceController = fs.readFileSync(
  new URL('../server/game/raceController.js', import.meta.url), 'utf8'
);
const staticServer = fs.readFileSync(new URL('../server/static.js', import.meta.url), 'utf8');

test('loop-lag report separates CPU, GC, server work and anonymous load context', () => {
  const report = createLoopLagDiagnostic({
    at: 0,
    blockMs: 100.04,
    intervalMs: 200,
    cpuUsage: { user: 50_000, system: 10_000 },
    eventLoopUtilization: { utilization: 0.75 },
    memory: { rss: 128 * 1024 * 1024, heapUsed: 32 * 1024 * 1024, external: 8 * 1024 * 1024 },
    work: [{ name: 'state_message', count: 24, totalMs: 20, maxMs: 3 }],
    gc: [{ durationMs: 80, kind: 'major' }],
    context: { multiplayer: { rooms: 1, connectedPlayers: 4 }, static: { activeTransfers: 0 } },
  });

  assert.equal(report.at, '1970-01-01T00:00:00.000Z');
  assert.equal(report.blockMs, 100);
  assert.equal(report.processCpuMs, 60);
  assert.equal(report.processCpuPercent, 30);
  assert.equal(report.eventLoopUtilizationPercent, 75);
  assert.deepEqual(report.memoryMb, { rss: 128, heapUsed: 32, external: 8 });
  assert.equal(report.gc[0].kind, 'major');
  assert.equal(JSON.stringify(report).includes('roomCode'), false);
});

test('measured server work preserves return values and thrown errors', () => {
  assert.equal(measureServerWork('unit', () => 42), 42);
  assert.throws(() => measureServerWork('unit', () => { throw new Error('boom'); }), /boom/);
});

test('the slow paths and active static transfers feed the loop-lag report', () => {
  assert.match(wsServer, /measureServerWork\('ws_parse'/);
  assert.match(wsServer, /'state_message'/);
  assert.match(wsServer, /'snapshot_broadcast'/);
  assert.match(raceController, /measureServerWork\('snapshot_build'/);
  assert.match(staticServer, /registerLoopLagContext\('static'/);
  assert.match(staticServer, /activeCompressedTransfers/);
});
