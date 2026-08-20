// A menü legördülője és a ténylegesen betöltött pálya nem csúszhat szét.
//
// Multiplayerben a SZOBA pályája dönt: ha valaki más Hungaroringjére
// csatlakozol, a 3D jelenet arra vált. Kilépéskor a legördülő korábban a mi
// választásunkon maradt, így a menü két különböző pályát állított — a felirat
// az egyiket, a mögötte látszó pálya és a köridőlista a másikat.
//
// A javítás iránya szándékos: NEM a pályát töltjük újra a felirathoz (az egy
// 100 MB fölötti letöltés lenne közvetlenül egy verseny után), hanem a
// feliratot igazítjuk a valósághoz.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A sorvégeket egységesítjük. A git core.autocrlf=true mellett CRLF-fel írja
// ki a fájlokat Windowson, a lenti daraboló viszont sortörés + } + sortörés
// mintát keres, ami CRLF-en SOSEM illeszkedik. Enélkül ez a teszt friss klón
// után elbukik, pedig a kód hibátlan.
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

test('a menübe visszatérés a betöltött pályához igazítja a legördülőt', () => {
  assert.match(main, /function syncMapSelectToLoadedTrack\(\)/);
  assert.match(main, /function enterMenu\(\)[\s\S]*?syncMapSelectToLoadedTrack\(\)/,
    'az enterMenu nem hívja a szinkront');
  // A ranglista eddig is a betöltötthöz igazodott — a kettőnek együtt kell mennie.
  assert.match(main, /syncMapSelectToLoadedTrack\(\);[\s\S]{0,200}?loadLeaderboard\(currentMapId\)/);
});

test('a szinkron mindent frissít, ami a pályaválasztásból következik', () => {
  const fn = main.slice(main.indexOf('function syncMapSelectToLoadedTrack()'));
  const vege = fn.indexOf('\n}\n');
  const test = fn.slice(0, vege);
  assert.match(test, /mapSelect\.value = entry\.id/);
  assert.match(test, /updateTrackAlert\(entry\)/, 'a pálya-figyelmeztetés nem frissül');
  assert.match(test, /updatePitOptionAvailability\(entry\)/, 'a boxkiállás elérhetősége nem frissül');
  assert.match(test, /saveLastChoice\('map', entry\.id\)/, 'a megjegyzett választás nem frissül');
  // Nem tölthet újra pályát: az a hibánál is rosszabb lenne.
  assert.doesNotMatch(test, /setTrack\(/, 'a szinkron nem tölthet újra pályát');
  assert.doesNotMatch(test, /showLoadingOverlay/, 'a szinkron nem indíthat betöltést');
});

test('a kocsi nem tud szétcsúszni: a multiplayer is a menü választóját küldi', () => {
  // Ha a lobbi saját kocsiválasztót kapna, ugyanez a hiba jönne elő a kocsira is.
  assert.match(mp, /carId: document\.getElementById\('carSelect'\)\?\.value/);
});
