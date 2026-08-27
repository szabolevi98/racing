import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_GRAPHICS_QUALITY, GRAPHICS_PROFILES, effectiveRenderPixelRatio,
  normalizeGraphicsQuality,
} from '../shared/graphicsQuality.js';

const main = readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

test('graphics presets use the agreed render scales and proportional shadow profiles', () => {
  assert.deepEqual(GRAPHICS_PROFILES, {
    low: {
      renderScale: 0.6, shadowMapSize: 1024, shadowRange: 50, environmentCubeSize: 256,
    },
    medium: {
      renderScale: 0.8, shadowMapSize: 2048, shadowRange: 100, environmentCubeSize: 512,
    },
    high: {
      renderScale: 1, shadowMapSize: 4096, shadowRange: 200, environmentCubeSize: 1024,
    },
  });
  for (const profile of Object.values(GRAPHICS_PROFILES)) {
    assert.equal((profile.shadowRange * 2) / profile.shadowMapSize, 400 / 4096,
      'all profiles keep the same nearby shadow texel density');
  }
  assert.deepEqual(
    Object.values(GRAPHICS_PROFILES).map((profile) => profile.environmentCubeSize),
    [256, 512, 1024],
  );
});

test('render pixel ratio never exceeds one and scales down from the capped value', () => {
  assert.equal(effectiveRenderPixelRatio(1, 'high'), 1);
  assert.equal(effectiveRenderPixelRatio(1.5, 'high'), 1);
  assert.equal(effectiveRenderPixelRatio(2, 'medium'), 0.8);
  assert.equal(effectiveRenderPixelRatio(1, 'low'), 0.6);
  assert.equal(effectiveRenderPixelRatio(0.75, 'high'), 0.75);
  assert.equal(effectiveRenderPixelRatio(NaN, 'high'), 1);
});

test('unknown saved graphics quality safely falls back to high', () => {
  assert.equal(normalizeGraphicsQuality('broken'), DEFAULT_GRAPHICS_QUALITY);
  assert.equal(normalizeGraphicsQuality('medium'), 'medium');
});

test('main menu applies and remembers graphics quality immediately', () => {
  assert.match(html, /class="graphics-quality-options" role="radiogroup"/);
  assert.match(html, /name="graphicsQuality" value="low"[\s\S]*name="graphicsQuality" value="medium"[\s\S]*name="graphicsQuality" value="high"/);
  assert.match(
    html,
    /class="race-options-row"[\s\S]*id="ghostModeCheckbox"[\s\S]*id="tireWearCheckbox"[\s\S]*class="graphics-quality-field"[\s\S]*name="graphicsQuality"/,
    'the two race options share a row and graphics sits beneath them',
  );
  assert.equal((html.match(/class="option-info"/g) || []).length, 2,
    'both compact race options expose their explanation through an info button');
  assert.equal((html.match(/class="option-tooltip"/g) || []).length, 2);
  assert.match(main, /renderer\.setPixelRatio\(activeEffectivePixelRatio\(\)\)/);
  assert.match(main, /setShadowSettings\(\{\s*range: profile\.shadowRange,\s*mapSize: profile\.shadowMapSize/);
  assert.match(main, /loadLastChoice\('graphics', DEFAULT_GRAPHICS_QUALITY\)/);
  assert.match(main, /graphicsQualityInputs\.forEach\(\(input\) => input\.addEventListener\('change'/);
  assert.match(main, /saveLastChoice\('graphics', applied\)/);
  assert.match(main, /new THREE\.WebGLCubeRenderTarget\(targetCubeSize/);
  assert.match(main, /pmremGenerator\.fromCubemap\(reducedCube\.texture\)/);
  assert.match(main, /currentEnvironmentCubeSize !== environmentCubeSize/,
    'changing graphics quality rebuilds the active skybox at the selected runtime size');
});

test('debug console can temporarily override the render scale', () => {
  assert.match(main, /setRenderScale:\s*setDebugRenderScale/);
  assert.match(main, /renderScale < 0\.1 \|\| renderScale > 1/);
  assert.match(main, /renderScaleOverride = renderScale/);
  assert.match(main, /renderScaleOverride = null;[\s\S]*setShadowSettings/,
    'choosing a named preset clears the temporary console override');
});
