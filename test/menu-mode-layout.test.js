import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('menu shows single-player and timing together with multiplayer below', async () => {
  const [html, multiplayer, css, dev] = await Promise.all([
    fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/style.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/dev.html', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="startBtn"[^>]*>Egyjátékos</);
  assert.match(multiplayer, /hotLapBtn\.textContent = 'Időmérés'/);
  assert.match(multiplayer, /btn\.textContent = 'Többjátékos'/);
  assert.match(css, /\.mode-buttons\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /\.btn-mp\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(multiplayer, /Időmérés indítása/);
  assert.match(multiplayer, /Időmérés vége/);
  assert.match(dev, /Időmérés rajtpont/);
});

test('menu keeps a safe external copyright link instead of hidden loading text', async () => {
  const [html, main] = await Promise.all([
    fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/main.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /href="https:\/\/github\.com\/szabolevi98"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, />Copyright <span id="copyrightYear"><\/span> szabolevi98<\/a>/);
  assert.match(main, /copyrightYear'\)\.textContent = new Date\(\)\.getFullYear\(\)/);

  // A kocsimodellek CC BY 4.0 alatt vannak, ami MEGKÖVETELI a szerző és a
  // licenc feltüntetését — ez nem elhagyható díszítés, ezért teszt védi.
  assert.match(html, /id="menuCredits"/);
  assert.match(html, /https:\/\/sketchfab\.com\/Tyler_Dave/);
  assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.doesNotMatch(main, /setMenuStatus\('(?:Pálya|Kocsi) betöltése\.\.\.'\)/);
});
