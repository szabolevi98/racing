import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/dev.html', import.meta.url), 'utf8');
const dev = fs.readFileSync(new URL('../web/dev.js', import.meta.url), 'utf8');

test('zone editor offers brush and point-by-point area drawing modes', () => {
  assert.match(html, /name="zonePaintMode"[^>]*value="brush"/);
  assert.match(html, /name="zonePaintMode"[^>]*value="polygon"/);
  assert.match(html, /id="polygonPointCount"/);
  assert.match(html, /id="fillPolygonBtn"/);
  assert.match(dev, /isPolygonPaintMode\(\)/);
  assert.match(dev, /addZonePolygonPoint\(x, z\)/);
  assert.ok(html.indexOf('id="paintModeRow"') > html.indexOf('id="brushWall"'));
  assert.ok(html.indexOf('id="paintModeRow"') < html.indexOf('id="brushSpawn"'));
});

test('polygon drawing applies the selected asphalt, runoff or wall zone to the same mask', () => {
  assert.match(dev, /function applyZonePolygon\(\)/);
  assert.match(dev, /ctx\.closePath\(\)/);
  assert.match(dev, /ctx\.globalCompositeOperation = 'destination-out'/);
  assert.match(dev, /ctx\.fillStyle = brush === '1' \? OFFTRACK_COLOR : WALL_COLOR/);
  assert.match(dev, /ctx\.fill\(\)/);
});

test('polygon can close at its first point and has point editing controls', () => {
  assert.match(dev, /zonePolygonPoints\.length >= 3/);
  assert.match(dev, /Math\.hypot\(x - first\.x, z - first\.z\) <= zonePickTolerance\(\)/);
  assert.match(dev, /undoPolygonPointBtn\.addEventListener\('click'/);
  assert.match(dev, /clearPolygonBtn\.addEventListener\('click', clearZonePolygon\)/);
});
