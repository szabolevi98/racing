import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/dev.html', import.meta.url), 'utf8');
const dev = fs.readFileSync(new URL('../web/dev.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');

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

test('polygon drawing applies asphalt, runoff, wall or smoothing to the same mask', () => {
  assert.match(dev, /function applyZonePolygon\(\)/);
  assert.match(dev, /ctx\.closePath\(\)/);
  assert.match(dev, /ctx\.globalCompositeOperation = 'destination-out'/);
  assert.match(dev, /brush === '2' \? WALL_COLOR : SMOOTHING_COLOR/);
  assert.match(dev, /ctx\.fill\(\)/);
  assert.match(html, /id="brushSmoothing"[^>]*value="smooth"/);
});

test('a smoothing selection limits asphalt smoothing but old maps keep the full asphalt fallback', () => {
  assert.match(dev, /api\.hasSmoothingSelection\(\)/);
  assert.match(dev, /smoothingSelectionActive \? api\.isSmoothingAt : api\.isAsphaltAt/);
  assert.match(dev, /smoothAsphaltToPlane\(floor\.positions, floor\.indices, smoothingAt/);
  assert.match(main, /const smoothing = DEV_MODE \? decodeSmoothingMask/);
});

test('polygon can close at its first point and has point editing controls', () => {
  assert.match(dev, /zonePolygonPoints\.length >= 3/);
  assert.match(dev, /Math\.hypot\(x - first\.x, z - first\.z\) <= zonePickTolerance\(\)/);
  assert.match(dev, /undoPolygonPointBtn\.addEventListener\('click'/);
  assert.match(dev, /clearPolygonBtn\.addEventListener\('click', clearZonePolygon\)/);
});
