import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const multiplayer = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const warmUpPanel = multiplayer.slice(
  multiplayer.indexOf('if (isHotLap() && !myLapStartedAt)'),
  multiplayer.indexOf('// A jobb felső kör-panel HTML-je.'),
);
const runningLapPanel = multiplayer.slice(
  multiplayer.indexOf('function lapPanelHtml('),
  multiplayer.indexOf('// A kör-kijelző (jobb fent)'),
);

test('Hot Lap warm-up only shows its phase and start-line hint', () => {
  assert.match(warmUpPanel, /t\('hud\.warmUp'\)/);
  assert.match(warmUpPanel, /t\('hud\.warmUpHint'\)/);
  assert.doesNotMatch(warmUpPanel, /t\('hud\.(?:current|best|total)'\)/);
  assert.doesNotMatch(warmUpPanel, /t\('mp\.lapsDone'\)/);
});

test('running race and lap timing keep their normal clock rows', () => {
  assert.match(runningLapPanel, /t\('hud\.current'\)/);
  assert.match(runningLapPanel, /t\('hud\.best'\)/);
  assert.match(runningLapPanel, /t\('hud\.total'\)/);
  assert.match(runningLapPanel, /t\('mp\.lapsDone'\)/);
});
