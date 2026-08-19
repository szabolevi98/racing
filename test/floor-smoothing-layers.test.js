// A talaj-háló simítói csak AZONOS útfelület pontjait vehetik egy környezetbe.
//
// Az extractDrivableTriangles kizárólag a lapok NORMÁLISÁT nézi, a magasságukat
// nem — így a rajtvonal fölötti fémszerkezet, egy reklámkapu vagy egy felüljáró
// vízszintes lapja is bekerül a talaj-hálóba. Ha a simítás ezeket a helyi síkba
// veszi, az aszfaltot felfelé húzza, és a ±5 cm-es korlátnál megáll: pontosan
// ott, ahol tábla van, egy fekvőrendőr keletkezik.
//
// Mérve, tökéletesen sík aszfalton, 8 m széles táblával 5 m magasan: 1377 csúcs
// emelkedett meg, egyenként 5,00 cm-t. A tábla magassága (3, 5, 10 m) nem
// számított, mert a korlát telítődik.
//
// A védelem eredetileg CSAK a smoothAsphaltToPlane-ben volt meg, a
// smoothFloorHeights-ből hiányzott — ez a teszt azt őrzi, hogy mindkettőben
// legyen, mert egy hiányzó példány némán rontja el a pályát.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');

function fuggveny(nev) {
  const kezd = main.indexOf(`function ${nev}(`);
  assert.notEqual(kezd, -1, `${nev} nincs meg a main.js-ben`);
  const vege = main.indexOf('\n}\n', kezd);
  assert.notEqual(vege, -1, `${nev} vége nem található`);
  return main.slice(kezd, vege);
}

test('a rázókő-simítás nem vesz egy környezetbe eltérő magasságú rétegeket', () => {
  const forras = fuggveny('smoothFloorHeights');
  // A szomszédkeresés az Y-t is nézi, nem csak az X/Z távolságot.
  assert.match(forras, /const ddy = positions\[j \* 3 \+ 1\] - y/,
    'a szomszédkeresés nem számol magasságkülönbséget');
  assert.match(forras, /Math\.abs\(ddy\) <= SMOOTH_MAX_LAYER_GAP/,
    'a magasságkülönbség nincs korlátozva');
  assert.match(main, /const SMOOTH_MAX_LAYER_GAP = /, 'nincs magasság-korlát konstans');
});

test('az aszfalt-simítás megtartja ugyanezt a védelmet', () => {
  const forras = fuggveny('smoothAsphaltToPlane');
  assert.match(forras, /maxLayerGap/, 'a rétegkorlát eltűnt az aszfalt-simításból');
  assert.match(forras, /Math\.abs\(ddy\) <= maxLayerGap/,
    'a szomszédkeresés nem használja a rétegkorlátot');
});

test('a rétegkorlát átengedi a valódi bankolást, de kizárja a szerkezeteket', () => {
  // A konstans a sugárból származik; a számérték az, ami számít.
  const m = /const SMOOTH_MAX_LAYER_GAP = Math\.max\(([\d.]+), SMOOTH_RADIUS \* ([\d.]+)\)/.exec(main);
  assert.ok(m, 'a magasság-korlát képlete megváltozott');
  const sugar = Number(/const SMOOTH_RADIUS = ([\d.]+)/.exec(main)[1]);
  const korlat = Math.max(Number(m[1]), sugar * Number(m[2]));

  // Indianapolis oválja 9,2 fokos: a sugáron belül ennyit emelkedik a pálya.
  const bankolas = sugar * Math.tan(9.2 * Math.PI / 180);
  assert.ok(korlat > bankolas,
    `a korlát (${korlat.toFixed(2)} m) levágná a 9,2 fokos bankolást (${bankolas.toFixed(2)} m)`);
  // Egy kapu/tábla legalább 2 m-rel a pálya fölött van, hogy a kocsi elférjen.
  assert.ok(korlat < 2, `a korlát (${korlat.toFixed(2)} m) beengedne egy 2 m magas szerkezetet`);
});
