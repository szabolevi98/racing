import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, sanitizePlayerToken } from '../shared/protocol.js';

test('player login token accepts canonical UUIDs and rejects malformed values', () => {
  assert.equal(
    sanitizePlayerToken(' 550E8400-E29B-41D4-A716-446655440000 '),
    '550e8400-e29b-41d4-a716-446655440000'
  );
  assert.equal(sanitizePlayerToken('not-a-token'), '');
  assert.equal(sanitizePlayerToken('550e8400-e29b-01d4-a716-446655440000'), '');
});

test('renamed player names use the shared multiplayer sanitization', () => {
  assert.equal(sanitizeName('  Otthoni    kettő  '), 'Otthoni kettő');
  assert.equal(sanitizeName(''), 'Névtelen');
});
