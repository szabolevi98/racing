import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setDifference, validGate, validSpawn, validateCollisionFile } from '../tools/verify-assets.mjs';

test('asset verifier validates spawn points, gates and exact set differences', () => {
  assert.equal(validSpawn({ x: 1, z: 2, heading: 0 }), true);
  assert.equal(validSpawn({ x: NaN, z: 2 }), false);
  assert.equal(validGate({ x1: 0, z1: 0, x2: 1, z2: 1 }), true);
  assert.equal(validGate({ x1: 0, z1: 0, x2: 0, z2: 0 }), false);
  assert.deepEqual(setDifference(['a', 'b', 'c'], ['b']), ['a', 'c']);
});

test('asset verifier accepts only a complete v2 collision file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'racing-assets-'));
  const valid = path.join(dir, 'collision.bin');
  const broken = path.join(dir, 'broken.bin');
  try {
    const buffer = Buffer.alloc(4 + 8 + 3 * 12 + 3 * 4 + 8);
    let offset = 0;
    buffer.writeUInt32LE(0xc0111505, offset); offset += 4;
    buffer.writeUInt32LE(3, offset); buffer.writeUInt32LE(3, offset + 4); offset += 8;
    offset += 3 * 12 + 3 * 4;
    buffer.writeUInt32LE(0, offset); buffer.writeUInt32LE(0, offset + 4);
    await fs.writeFile(valid, buffer);
    await fs.writeFile(broken, buffer.subarray(0, -1));
    await validateCollisionFile(valid);
    await assert.rejects(() => validateCollisionFile(broken), /csonka|méreteltérés/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
