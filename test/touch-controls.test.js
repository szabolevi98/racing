import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('mobile steering uses left and right buttons instead of a joystick', async () => {
  const html = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../web/style.css', import.meta.url), 'utf8');
  const steering = html.match(/<div class="touch-steering-buttons"[\s\S]*?<\/div>/)?.[0] || '';

  assert.match(steering, /data-touch-key="KeyA"/);
  assert.match(steering, /data-touch-key="KeyD"/);
  assert.doesNotMatch(html, /data-touch-joystick=/);
  assert.match(css, /\.touch-steering-buttons[\s\S]*left: max\(var\(--touch-drive-inline\)/);
  assert.match(css, /\.touch-pedals[\s\S]*right: max\(var\(--touch-drive-inline\)/);
  assert.match(css, /\.touch-steering-buttons[\s\S]*bottom: calc\(var\(--touch-control-bottom\) \+ var\(--touch-lower-row-height\)\)/);
});
