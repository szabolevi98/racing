# Kocsi-modell elemző eszközök

## Multiplayer/ghost modellek automatikus készítése

```bash
npm run cars:compress
```

A parancs az összes eredeti `web/assets/cars/*.glb` autóból legfeljebb 5 MB-os
változatot készít a `web/assets/cars/compressed/` mappába. Modellenként a
legjobb minőségű, limitbe beleférő profilt választja; a már naprakész fájlokat
kihagyja. A hivatalos `gltfpack` binárist a `tools/vendor/gltfpack/<verzió>/` mappában
tartjuk, verziózva és a repóba commitolva — így a konvertálás hálózat nélkül is
fut. Ha a binárisod platformjára még nincs ott (a repóban a Windowsos van),
első futáskor automatikusan letölti, és SHA-256 ellenőrzés után ide teszi.

Egy vagy több konkrét autó újragenerálása:

```bash
npm run cars:compress -- 2008_bmw_sauber_f1.08 --force
```

Más célméret tesztelése:

```bash
npm run cars:compress -- --target-mb=4
```

Az eredeti GLB-ket a script soha nem írja felül. A játék az eredetit használja
a saját autóhoz, a compressed változatot pedig multiplayer-ellenfélnél és
Hot Lap ghostnál. Mindkettő ugyanazt az eredeti JSON-konfigurációt kapja, ezért
a `wheelPattern` és a kerékanimáció is megmarad.

## Kerék-configok automatikus elkészítése

```bash
npm run cars:wheels
```

Végigmegy az összes autón, és megírja a hiányzó `wheelPattern`-eket. A **már
meglévő configokhoz nem nyúl**: azok kézzel szerzett tudást hordoznak, élőben
jelentett hibák javításait (kimaradt futófelület-anyag, szándékosan kikerült
kormánykerék-anyag), amit egy vak újragenerálás csendben eldobna.

Egy konkrét autó újragenerálása — a korábbi megjegyzés ilyenkor is megmarad a
fájlban, referenciaként:

```bash
npm run cars:wheels -- 2024_ford_mustang_gt3 --force
```

A `yawDegrees` mindig 0 (előre néző modellt feltételezve); ha egy kocsi
hátrafelé áll, azt a JSON-ban kézzel kell átírni, és az újragenerálás
megtartja. A futás végén kilistázza az alacsony pontszámú javaslatokat — azokat
érdemes élőben megnézni a kocsi-tesztelőben.

Offline (Node.js, függőség nélküli) GLB-elemzők, amikkel egy új autó
`wheelPattern`-jét meg lehet határozni anélkül, hogy a böngészőben kellene
kézzel vadászni a mesh-neveket.

## Egyetlen autó vizsgálata

```bash
node tools/propose.mjs 2024_ford_mustang_gt3
```

Kiírja a jelölt mintákat pontszámmal, a javasolt `wheelPattern`-t, és a mérést
(nyomtáv, tengelytáv, alkatrészszám, kilengés). Ha a minta olyan darabot is
megfogna, ami nem a kerekeken ül, azt külön jelzi.

A javaslatot **mindig ellenőrizd élőben** (kocsi-teszt mód) — az eszköz jó
kiindulást ad, de a végső szót a látvány mondja ki.

## Fájlok

- **`glb.mjs`** — minimál GLB/glTF olvasó: kibontja a JSON- és BIN-chunkot,
  bejárja a node-hierarchiát, és primitívenként megadja a névláncot, az
  anyagnevet és a világ-koordinátás AABB-t. Önállóan is használható bármilyen
  modell-vizsgálathoz.
- **`analyze.mjs`** — a `main.js` `setCar` + `buildWheelPivots` +
  `splitMergedWheelMesh` logikájának pontos offline replikája. Az `evaluate()`
  egy adott mintára megmondja, hogy a játék milyen kerék-csoportokat építene
  belőle. (A replika hitelességét az adja, hogy a repóban lévő MINDEN, kézzel
  ellenőrzött kocsi-konfigra ugyanazt az eredményt adja, mint a játék.)
- **`propose.mjs`** — a tényleges javaslattevő. A mesh- és anyagnevekből
  tokeneket képez, mindegyikre lefuttatja az `evaluate`-et, geometriai
  pontszámot ad (szimmetria, kerék-arányosság, kilengés, lefedettség), majd a
  legjobb "mag" köré geometriai alapon összegyűjti a többi kerék-alkatrészt.

## Amit az eszköz szándékosan kihagy

Ezek a kerék KÖZELÉBEN vannak, de nem forognak vele — ha bekerülnének a
kerék-pivotba, gördüléskor együtt pörögnének a kerékkel:

- **felfüggesztés** (susp, sospensioni, wishbone, lengőkar, damper) — csak a
  kormányzást követi;
- **kereszttengelyek, merevítő lapok** — a kerékmagasságban ülnek és
  "lefedik" a bal+jobb kereket, de laposak;
- **futómű / differenciálmű** — a bboxa véletlenül lehet kerék-arányú, ezért
  az eszköz szétvágja és megnézi, hogy a darabok tényleg a kerekekre esnek-e.

Egyedi eset, amit kézzel kellett megoldani: a **Brabham BT46B** fékje BELÜL, a
váltó mellett ül (inboard brakes), ezért a féktárcsa nem forgatható a kerékkel.
