import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');

test('remote cars use the measured chassis height instead of the old fixed offset', () => {
  assert.match(mp, /model\.position\.y = -box3\.min\.y - G\.getCarGroundOffset\(\)/);
  assert.doesNotMatch(mp, /model\.position\.y = -box3\.min\.y - 0\.85/);
  assert.match(main, /getCarGroundOffset\(\) \{ return groundOffset; \}/);
});

test('remote wheel steering and rolling survive buffering and reach wheel pivots', () => {
  assert.match(mp, /st: c\.st \?\? 0, wr: c\.wr \?\? 0/);
  assert.match(mp, /st: \(a\.st \?\? 0\) \+ /);
  assert.match(mp, /wr: \(a\.wr \?\? 0\) \+ /);
  assert.match(mp, /createRemoteWheelRig\(model, car\.config\?\.wheelPattern, group\)/);
  assert.match(mp, /\.rotation\.set\(s\.wr \?\? 0, source\?\.steer \? \(s\.st \?\? 0\) : 0, 0\)/);
});
