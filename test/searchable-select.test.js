import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');

test('searchable select commits only after the full click gesture', () => {
  assert.match(main, /item\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/);
  assert.match(main, /item\.addEventListener\('click', \(e\) => \{/);
  assert.doesNotMatch(main, /item\.addEventListener\('mousedown', \(e\) => \{[\s\S]*?selectValue\(o\.value\)/);
});

test('searchable select closes before dispatching an async change handler', () => {
  const selectValue = main.match(/function selectValue\(value\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.ok(selectValue.indexOf('closeMenu();') >= 0);
  assert.ok(selectValue.indexOf('input.blur();') > selectValue.indexOf('closeMenu();'));
  assert.ok(selectValue.indexOf("dispatchEvent(new Event('change'))") > selectValue.indexOf('input.blur();'));
});

test('searchable select outside-close covers mouse and touch without stale blur timers', () => {
  assert.match(main, /document\.addEventListener\('pointerdown'/);
  assert.match(main, /blurTimer = setTimeout\(closeMenu, 120\)/);
  assert.match(main, /function renderMenu\(filterText\) \{\s*if \(blurTimer\)/);
});
