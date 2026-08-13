import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const setTrack = main.slice(main.indexOf('async function setTrack('), main.indexOf('\nasync function setCar('));

test('track loading preserves the material side setting from the GLB', () => {
  assert.match(setTrack, /const materialSeen = new Set\(\)/);
  assert.doesNotMatch(setTrack, /\.side\s*=\s*THREE\.(?:DoubleSide|FrontSide|BackSide)/);
  assert.match(setTrack, /m\.transparent && m\.map && isMaskLikeTexture\(m\.map\)/);
});
