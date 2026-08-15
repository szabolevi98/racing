# Kocsi-modell elemző eszközök

## Teljes asset-ellenőrzés

```bash
npm run verify:assets
```

Csak olvassa a fájlokat, nem módosít semmit. Ellenőrzi az összes asset-JSON
szintaxisát, a normál/compressed/master autók és manifestjeik egyezését,
a tartalomalapú konverziós aláírásokat, a méretkorlátokat és a kerék-regexeket.
Az aktív pályáknál vizsgálja a modellt, a nyolc rajtpontot, a rajt- és
checkpointvonalakat, az opcionális boxkonfigurációt és zónatérképet, valamint a
multiplayerhez szükséges `collision.bin` formátumát. A környezeteknél HDR/EXR
fájlt keres. Hibánál nem nulla kilépési kódot ad, ezért deploy előtti ellenőrzésbe
vagy teljes assetkészlettel futó CI-folyamatba is beilleszthető.

A nagy GLB/BIN/HDR fájlok nincsenek Gitben, ezért egy assetek nélküli friss
klónban a hiányukat helyesen hibának jelenti.

## Nagy játékosmodellek optimalizálása

```bash
npm run cars:optimize
```

A parancs a 20 MB fölötti `web/assets/cars/*.glb` autókat teljes minőségben
elmenti a webrooton kívüli `car-masters/` mappába, majd legfeljebb 15 MB-os
játékosmodellt készít belőlük az eredeti helyükre. A 20 MB alatti autókat nem
duplázza: azok jelenlegi GLB-je egyszerre forrás és játékosmodell.

A 15 MB-os kereső először az eredeti textúrát és teljes geometriát próbálja.
Enyhe geometriai egyszerűsítés, majd WebP csak akkor következik, ha szükséges;
autónként azt az utat választja, amely a legkevesebb látható részletet áldozza
fel. A masterek nem publikus webes assetek és játék közben nem töltődnek le.

## Multiplayer/ghost modellek automatikus készítése

```bash
npm run cars:compress
```

A parancs minden autónál a `car-masters/` forrást használja, ha létezik;
egyébként közvetlenül a `web/assets/cars/*.glb` modellből készít legfeljebb
5 MB-os változatot a `web/assets/cars/compressed/` mappába. Így a remote modell
sosem egy már veszteséges 15 MB-os fájlból tömörül újra. A naprakész fájlokat
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

A játék a legfeljebb 15 MB-os modellt használja a saját autóhoz, a compressed
változatot pedig multiplayer-ellenfélnél és Hot Lap ghostnál. Mindkettő ugyanazt
a JSON-konfigurációt kapja, ezért
a `wheelPattern` és a kerékanimáció is megmarad.

### Hogyan választ beállítást

Két külön skála van, egy a geometriára és egy a textúrákra — nem egy
összefűzött profil-létra. Ez azért fontos, mert autónként más szorít: a
BMW 320i-nél a kép 4,17 MB és a geometria 2,19, a Porsche 911 GT1-nél pont
fordítva (2,20 / 5,13). Egy kötegelt létra mindkettőnél levágná azt is, ami
nem szorít.

A két tengely nem hat egymásra: a geometria aránya nem változtatja a textúrák
méretét és fordítva. Ezért a script mindkét tengelyt egyszer végigméri, utána
a teljes rács minden cellája ismert egy összeadással, és a legkisebb
minőségvesztésű beférő cellát választja. A skálák `cost` mezője mondja meg, mi
mennyit ér: egy 4096-os textúra felezése egy 20 méterre lévő ellenfélautón
észrevehetetlen (1), a háromszögek harmadolása viszont a sziluettet rontja (8).

A nyilvántartás minden autónál rögzíti, melyik oldal szorított (`limitedBy`),
így utólag látszik, hol van a tartalék.

A `-sp` (permissive simplification) **szándékosan nincs** a gltfpack-hívásban:
az UV-varratokon átnyúlva vonna össze csúcsokat, amitől a textúra láthatóan
elcsúszik a modellen. Mérve négy autón: az elhagyása +0,2…1,2% méret, és a
célarányt nélküle is eléri. A `-vt 16` ugyanezt védi a kvantálás oldaláról.

## Több kocsit tartalmazó modell szétvágása

```bash
node tools/split-car-pack.mjs <pack.glb>            # csak megnézi
node tools/split-car-pack.mjs <pack.glb> --write    # kiírja a darabokat
```

A „car pack" modellek egymás mellé állítva tartalmazzák a mezőnyt. A script a
node-ok világ-koordinátás dobozaiból keresi meg a hézagokat — nem a nevekből,
mert egy pack jellemzően `Object_47` stílusban nevez. Ha a hierarchia egyetlen
gyökérrel kezd (Sketchfab-export), addig ereszkedik, amíg a fa el nem ágazik.

Nem farag geometriát: kocsinként készít egy másolatot, amiben az elágazó node
gyereklistája csak az adott kocsira szűkül, majd a `gltfpack` újraépíti a
puffert és eldob mindent, amire nincs hivatkozás. A kiválasztott node-okat
NEM lépteti elő jelenet-gyökérré — a glTF-ben egy node-nak legfeljebb egy
szülője lehet, és a gltfpack az ilyen fájlt visszautasítja.

Ellenőrizve: egy-kocsis modelleken pontosan egy csoportot talál (nem vág szét
feleslegesen), és a kiírt fájl ugyanazt a darabszámot, méretet és
anyagkészletet adja vissza, mint az eredeti.

Utána a darabok a szokásos úton mennek tovább: `cars:wheels`, `cars:compress`,
majd `tools/audit/wheel-orbit.mjs`. Egy pack előtt érdemes megnézni, hogy a
festések közös textúra-atlaszon vannak-e — ha igen, minden darab magával viszi
az egészet, és a `gltfpack` egy atlaszt nem tud részlegesen megnyesni.

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
