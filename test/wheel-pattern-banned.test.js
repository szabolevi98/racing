// A kerék-minta javaslója ne fogja meg a féknyerget.
//
// A féknyereg geometriailag a kerék BELSEJÉBEN ül, tehát minden mérethatárt
// teljesít, amit a javasló használ — mégsem forog vele, mert az ÁLLÓ
// felfüggesztésre van szerelve. A kerék pivotjára kerülve körbeleng.
//
// Kézzel hat autónál kellett utólag kivenni (F2004, RB7 Showrun, Mazda Furai,
// McLaren 650S GT3, Koenigsegg CCGT, Nissan GT-R), 24-49%-os kilengéssel —
// ezért került név alapú tiltásra.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const forras = await fs.readFile(new URL('../tools/propose.mjs', import.meta.url), 'utf8');
const sor = (nev) => forras.match(new RegExp(`^const ${nev} = /(.*)/i;$`, 'm'))?.[1] ?? '';

test('a féknyereg tiltva van tokenként és részstringként is', () => {
  const token = new RegExp(sor('BANNED_TOKEN'), 'i');
  const resz = new RegExp(sor('BANNED_PART'), 'i');
  for (const n of ['caliper', 'calipers', 'Caliper', 'calliper', 'brakecaliper']) {
    assert.ok(token.test(n) || resz.test(n), `${n} nincs tiltva`);
  }
  // Részstringként is: "Brake_Caliper.004" nem tokenizálódik "caliper"-re
  // minden modellben.
  assert.ok(resz.test('Brake_Caliper.004'));
  assert.ok(resz.test('FL_brake_caliper_red'));
});

test('a féktárcsa NEM tiltott — az valóban forog a kerékkel', () => {
  const token = new RegExp(sor('BANNED_TOKEN'), 'i');
  const resz = new RegExp(sor('BANNED_PART'), 'i');
  for (const n of ['rotor', 'disc', 'disk', 'brake_disc', 'BRAKE']) {
    assert.ok(!token.test(n) && !resz.test(n), `${n} nem lehet tiltva`);
  }
});

test('a felfüggesztés tiltása megmaradt', () => {
  const resz = new RegExp(sor('BANNED_PART'), 'i');
  for (const n of ['ae2_susp_front_stup.003', 'wishbone_fl', 'upright_rear', 'pushrod']) {
    assert.ok(resz.test(n), `${n} nincs tiltva`);
  }
});

test('egy token akkor is kiesik, ha csak a TALÁLATA tiltott alkatrész', () => {
  // A Koenigsegg CCGT-nél a "lip" (első légterelő) a "caLIPer"-re is
  // illeszkedett. A token maga ártatlan, a találata nem — ezért a javasló a
  // találatokat is átnézi, nem csak a token nevét.
  assert.match(forras, /hits\.some\(\(p\) => BANNED_PART\.test\(p\.fullName \+ ' ' \+ p\.mat\)\)/);
  const resz = new RegExp(sor('BANNED_PART'), 'i');
  assert.ok(resz.test('CCGT_front_lip caliper_mat'), 'a caliper-találat kiszűrhető');
  assert.ok(!resz.test('CCGT_front_lip body_mat'), 'ártatlan találat maradjon bent');
});
