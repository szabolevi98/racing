# Kocsi-modell elemző eszközök

Offline (Node.js, függőség nélküli) GLB-elemzők, amikkel egy új autó
`wheelPattern`-jét meg lehet határozni anélkül, hogy a böngészőben kellene
kézzel vadászni a mesh-neveket.

## Használat

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
