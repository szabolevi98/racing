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

  // A feliratok a nyelvfájlban élnek; a kód csak a KULCSRA hivatkozik. A
  // magyar szöveget ezért a hu.json-ban ellenőrizzük, nem a forrásban.
  const hu = JSON.parse(await fs.readFile(new URL('../web/lang/hu.json', import.meta.url), 'utf8'));

  assert.match(html, /id="startBtn"[^>]*data-i18n="menu\.solo"/);
  assert.equal(hu['menu.solo'], 'Egyjátékos');
  assert.match(multiplayer, /hotLapBtn\.textContent = t\('mp\.hotLap'\)/);
  assert.match(multiplayer, /btn\.textContent = t\('menu\.multiplayer'\)/);
  assert.equal(hu['mp.hotLap'], 'Időmérés');
  assert.equal(hu['menu.multiplayer'], 'Többjátékos');
  assert.equal(hu['menu.gameMode'], 'Játékmód');
  assert.match(
    html,
    /class="graphics-quality-field"[\s\S]*class="mode-section"[\s\S]*id="modeButtons"/,
    'all settings come before the final game-mode action section',
  );
  assert.match(css, /\.mode-buttons\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /\.btn-mp\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(css, /\.race-options-row\s*\{[^}]*margin-top:\s*var\(--menu-section-gap\)/s);
  assert.match(css, /\.graphics-quality-field\s*\{[^}]*margin-top:\s*var\(--menu-section-gap\)/s);
  assert.match(css, /\.mode-section\s*\{[^}]*margin-top:\s*var\(--menu-section-gap\)/s);
  assert.match(multiplayer, /data-i18n="mp\.ui\.startHotLap"/);
  assert.equal(hu['mp.ui.startHotLap'], 'Időmérés indítása');
  assert.equal(hu['mp.hotLapOver'], 'Időmérés vége');
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
  assert.match(html, />Copyright © <span id="copyrightYear"><\/span> szabolevi98<\/a>/);
  assert.match(main, /copyrightYear'\)\.textContent = new Date\(\)\.getFullYear\(\)/);

  // A kocsimodellek túlnyomó része Tyler_Dave munkája (263-ból 233), és a
  // kredit-sor szándékosan van ott. Teszt védi, hogy egy későbbi menü-átszabás
  // ne tüntesse el csendben.
  assert.match(html, /id="menuCredits"/);
  assert.match(html, /https:\/\/sketchfab\.com\/Tyler_Dave/);
  assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.doesNotMatch(main, /setMenuStatus\('(?:Pálya|Kocsi) betöltése\.\.\.'\)/);
});
