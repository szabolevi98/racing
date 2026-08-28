import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const setTrack = main.slice(main.indexOf('async function setTrack('), main.indexOf('\nasync function setCar('));
const foliageShading = main.slice(
  main.indexOf('function applyFoliageShading('),
  main.indexOf('\nfunction refreshFoliageShading('),
);

test('track loading preserves the material side setting from the GLB', () => {
  assert.match(setTrack, /const materialSeen = new Set\(\)/);
  assert.doesNotMatch(setTrack, /\.side\s*=\s*THREE\.(?:DoubleSide|FrontSide|BackSide)/);
  assert.match(setTrack, /m\.transparent && m\.map && isMaskLikeTexture\(m\.map\)/);
});

test('foliage depth masking also works with unreadable compressed textures', () => {
  assert.match(main, /const FOLIAGE_ALPHA_TEST = 0\.5/);
  assert.match(foliageShading, /m\.alphaTest = Math\.max\(m\.alphaTest \|\| 0, FOLIAGE_ALPHA_TEST\)/);
  assert.match(foliageShading, /m\.depthWrite = true/);
  assert.doesNotMatch(foliageShading, /if\s*\([^)]*isMaskLikeTexture/);
});
