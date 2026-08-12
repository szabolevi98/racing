import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');

test('W/S and up/down switch cars only in the dev wheel tester', () => {
  assert.match(main, /if \(appState !== 'cartest' \|\| e\.repeat\) return;/);
  assert.doesNotMatch(main, /appState !== 'cartest' && appState !== 'menu'/);
  assert.match(main, /e\.code === 'ArrowUp' \|\| e\.code === 'KeyW'/);
  assert.match(main, /e\.code === 'ArrowDown' \|\| e\.code === 'KeyS'/);
});
