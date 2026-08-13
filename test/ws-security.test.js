import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { attachWebSocket, roomStats } from '../server/net/wsServer.js';
import { getManifest } from '../server/assets.js';

function waitFor(ws, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('WebSocket válasz időtúllépés.'));
    }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

async function waitForStats(expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (JSON.stringify(roomStats()) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(roomStats(), expected);
}

test('rapid room creation is serialized and disconnect leaves no orphan rooms', async () => {
  const server = http.createServer();
  const wss = attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const welcome = waitFor(ws, (message) => message.type === 'welcome');
    ws.send(JSON.stringify({ type: 'hello', name: 'Audit' }));
    await welcome;

    const manifest = await getManifest();
    const request = {
      type: 'createRoom',
      mapId: manifest.maps[0].id,
      carId: manifest.cars[0].id,
      laps: 3,
      isPublic: false,
    };
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify(request));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(roomStats(), { rooms: 1, players: 1 });

    ws.close();
    await new Promise((resolve) => ws.once('close', resolve));
    await waitForStats({ rooms: 0, players: 0 });
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test('oversized WebSocket payload is rejected before JSON parsing', async () => {
  const server = http.createServer();
  const wss = attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(70 * 1024) }));
    assert.equal(await closed, 1009);
    await waitForStats({ rooms: 0, players: 0 });
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test('control-message flood is closed with policy violation', async () => {
  const server = http.createServer();
  const wss = attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ type: 'unknown' }));
    assert.equal(await closed, 1008);
    await waitForStats({ rooms: 0, players: 0 });
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test('invalid JSON cannot bypass the connection-wide rate limit', async () => {
  const server = http.createServer();
  const wss = attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    for (let i = 0; i < 200; i++) ws.send('{');
    assert.equal(await closed, 1008);
    await waitForStats({ rooms: 0, players: 0 });
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
