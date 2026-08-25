import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NET_DIAG_CAPACITY,
  NET_DIAG_EVENT,
  NET_DIAG_INCIDENT,
  NET_DIAG_MAX_INCIDENTS,
  NetDiagnosticsRecorder,
} from '../web/netDiagnostics.js';

test('net diagnostics is a fixed-size typed-array ring buffer', () => {
  let now = 0;
  const recorder = new NetDiagnosticsRecorder({ capacity: 4, now: () => now });
  const initialBytes = recorder.memoryBytes();

  for (let sequence = 1; sequence <= 6; sequence++) {
    now += 10;
    recorder.record(NET_DIAG_EVENT.STATE_OUT, sequence, sequence * 2);
  }

  assert.equal(recorder.count, 4);
  assert.equal(recorder.memoryBytes(), initialBytes);
  assert.deepEqual(
    recorder.buildReport().current.events.map((event) => event[2]),
    [3, 4, 5, 6],
  );
});

test('live report keeps only the latest 30 seconds', () => {
  let now = 0;
  const recorder = new NetDiagnosticsRecorder({ capacity: 16, now: () => now });
  recorder.record(NET_DIAG_EVENT.PING, 10);
  now = 10_000;
  recorder.record(NET_DIAG_EVENT.PING, 20);
  now = 31_000;
  recorder.record(NET_DIAG_EVENT.PING, 30);

  const current = recorder.buildReport().current;
  assert.deepEqual(current.events.map((event) => event[2]), [20, 30]);
  assert.equal(current.durationMs, 21_000);
});

test('incidents freeze their numeric window with cooldown and bounded memory', () => {
  let now = 20_000;
  let wallNow = 1_700_000_000_000;
  const recorder = new NetDiagnosticsRecorder({
    capacity: 32,
    now: () => now,
    wallNow: () => wallNow,
  });
  recorder.setContext({ mode: 'multiplayer', mapId: 'monza_2025', carId: 'f1-car' });
  recorder.record(NET_DIAG_EVENT.VALIDATION, 3, 2, 41);
  assert.equal(recorder.captureIncident(NET_DIAG_INCIDENT.SERVER_VALIDATION), true);
  assert.equal(recorder.captureIncident(NET_DIAG_INCIDENT.SERVER_VALIDATION), false);

  now += 15_001;
  wallNow += 15_001;
  recorder.record(NET_DIAG_EVENT.PING, 800, 600);
  assert.equal(recorder.captureIncident(NET_DIAG_INCIDENT.HIGH_PING), true);

  const report = recorder.buildReport();
  assert.equal(report.incidents.length, 2);
  assert.equal(report.incidents[0].reason, NET_DIAG_INCIDENT.SERVER_VALIDATION);
  assert.deepEqual(report.incidents[0].context, {
    mode: 'multiplayer', mapId: 'monza_2025', carId: 'f1-car',
  });
  assert.ok(recorder.memoryBytes() <= (recorder.times.byteLength
    + recorder.types.byteLength + recorder.values.byteLength) * (NET_DIAG_MAX_INCIDENTS + 1));
});

test('diagnostic context rejects text that could contain user data', () => {
  const recorder = new NetDiagnosticsRecorder({ now: () => 1, wallNow: () => 1 });
  recorder.setContext({
    mode: 'multiplayer',
    mapId: 'Monza; player=Béla',
    carId: 'car/token?secret',
  });
  recorder.record(NET_DIAG_EVENT.SERVER_ERROR, true);
  const report = recorder.buildReport();

  assert.deepEqual(report.current.context, { mode: 'multiplayer', mapId: null, carId: null });
  assert.doesNotMatch(JSON.stringify(report), /Béla|secret|token\?/);
});

test('default live recorder stays below 200 KiB and has enough room for 30 seconds', () => {
  const recorder = new NetDiagnosticsRecorder();
  assert.equal(recorder.capacity, NET_DIAG_CAPACITY);
  assert.ok(recorder.memoryBytes() < 200 * 1024);
  // 60 Hz állapot + 20 Hz snapshot + 20 Hz snapshot-sor + három 4 Hz-es
  // teljesítménysor + 1 Hz ping.
  assert.ok(recorder.capacity > 30 * (60 + 20 + 20 + 4 + 4 + 4 + 1));
});

test('pipeline diagnostics separates proxy, physics and rendering work', () => {
  const recorder = new NetDiagnosticsRecorder({ now: () => 100, wallNow: () => 1 });
  recorder.record(NET_DIAG_EVENT.PIPELINE_TIMING, 0.2, 0.5, 1.1, 2.4, 0.8, 2.1, 3.2, 8.4);
  recorder.record(NET_DIAG_EVENT.RENDER_LOAD, 140, 250_000);
  const report = recorder.buildReport();
  assert.equal(report.schemaVersion, 7);
  assert.deepEqual(report.eventFields.pipeline_timing, [
    'relativeMs', 'proxySyncAvgMs', 'proxySyncMaxMs', 'physicsAvgMs', 'physicsMaxMs',
    'multiplayerFrameAvgMs', 'multiplayerFrameMaxMs', 'renderCpuAvgMs', 'renderCpuMaxMs',
  ]);
  assert.deepEqual(report.eventFields.render_load, ['relativeMs', 'renderCalls', 'renderTriangles']);
  assert.equal(report.current.events[0][1], 'pipeline_timing');
  assert.deepEqual(report.current.events[0].slice(2), [0.2, 0.5, 1.1, 2.4, 0.8, 2.1, 3.2, 8.4]);
  assert.deepEqual(report.current.events[1].slice(1), ['render_load', 140, 250_000]);
});

test('rendering diagnostics identify the GPU and actual drawing buffer without user data', () => {
  const recorder = new NetDiagnosticsRecorder({ now: () => 100, wallNow: () => 1 });
  recorder.setClientRendering({
    gpuRenderer: 'ANGLE (Intel UHD Graphics 630)',
    powerPreference: 'high-performance',
    graphicsQuality: 'medium',
    devicePixelRatio: 1.25,
    effectivePixelRatio: 0.8,
    renderScale: 0.8,
    shadowMapSize: 2048,
    shadowRange: 100,
    cssWidth: 1920,
    cssHeight: 1080,
    drawingBufferWidth: 2400,
    drawingBufferHeight: 1350,
  });
  const report = recorder.buildReport();
  assert.deepEqual(report.clientRendering, {
    gpuRenderer: 'ANGLE (Intel UHD Graphics 630)',
    powerPreference: 'high-performance',
    graphicsQuality: 'medium',
    devicePixelRatio: 1.25,
    effectivePixelRatio: 0.8,
    renderScale: 0.8,
    shadowMapSize: 2048,
    shadowRange: 100,
    cssWidth: 1920,
    cssHeight: 1080,
    drawingBufferWidth: 2400,
    drawingBufferHeight: 1350,
  });
});

test('snapshot backlog is coalesced without dropping ordered race events', () => {
  const root = resolve(import.meta.dirname, '..');
  const multiplayer = readFileSync(resolve(root, 'web', 'mp.js'), 'utf8');
  assert.match(multiplayer, /case S2C\.SNAPSHOT:\s*queueSnapshot\(m\)/);
  assert.match(multiplayer, /if \(m\.type !== S2C\.SNAPSHOT\) flushPendingSnapshot\(2\)/);
  assert.match(multiplayer, /function frame\([\s\S]*?flushPendingSnapshot\(1\)/);
  assert.match(multiplayer, /NET_DIAG_EVENT\.SNAPSHOT_QUEUE/);
  assert.match(multiplayer, /Math\.max\(0, count - 1\)/);
});

test('F9 downloads diagnostics without adding a permanent HUD control', () => {
  const root = resolve(import.meta.dirname, '..');
  const main = readFileSync(resolve(root, 'web', 'main.js'), 'utf8');
  const html = readFileSync(resolve(root, 'web', 'index.html'), 'utf8');
  const multiplayer = readFileSync(resolve(root, 'web', 'mp.js'), 'utf8');

  assert.match(main, /e\.code !== 'F9'[\s\S]*?netDiagnostics\.download\(\)/);
  assert.doesNotMatch(html, /netDiag|Netcode-riport/i);
  assert.match(multiplayer, /NET_DIAG_EVENT\.STATE_OUT/);
  assert.match(multiplayer, /NET_DIAG_EVENT\.SNAPSHOT_IN/);
  assert.match(multiplayer, /NET_DIAG_INCIDENT\.SERVER_VALIDATION/);
  assert.match(multiplayer, /takePipelineTimings/);
  assert.match(main, /NET_DIAG_EVENT\.PIPELINE_TIMING/);
  assert.match(main, /renderer\.info\.render\.triangles/);
  assert.match(main, /powerPreference: RENDER_POWER_PREFERENCE/);
  assert.match(main, /NET_DIAG_EVENT\.LOCAL_PLAYBACK/);
  assert.match(main, /requestCameraSnapAfterFrameStall/);
});
