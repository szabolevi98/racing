# Car pack modellek behozatala

Egy „car pack" egyetlen GLB, amiben több kocsi áll egymás mellett. Ez a leírás
végigvezet a szétvágástól az élesítésig, és megnevezi azokat a buktatókat is,
amikbe menet közben belefutottunk — azok kerülnek a legtöbbe.

A 2010-es, 2013-as és 2014-es F1 pack ezen az úton került be, összesen 34 kocsi.

## 0. Milyen pack van előtted?

Ez dönti el, melyik eszköz kell. Először mindig nézd meg:

```bash
node tools/split-car-pack.mjs <pack.glb>
```

**A) Kocsinként külön node.** A kimenet annyi csoportot talál, ahány autó van,
és a nevek is beszédesek (`ferrari_2014_1`). Ez a könnyű eset — maradhatsz a
`split-car-pack.mjs`-nél.

**B) Egyetlen node, mindent átfogó mesh-ekkel.** A kimenet egy csoportot talál,
és a méret gyanúsan nagy (a 2010-esnél 117 egység széles). Ilyenkor a
hierarchia így néz ki:

```
GLTF_SceneRootNode
  bodywithwheels_0        <- egyetlen node
    Object_4 [mesh]       <- mindegyik az EGÉSZ mezőnyt átfogja
    Object_5 [mesh]
    ...
```

Itt nincs mit átcsoportosítani, mert egy mesh több kocsi geometriáját
tartalmazza. Ehhez a `tools/slice-car-pack.mjs` kell, ami háromszög szinten vág.

Gyors ellenőrzés a két eset megkülönböztetésére: ha a primitívek egy része a
teljes szélességet átfogja, B-ről van szó.

## 1. Szétvágás

### A eset — node-szintű

```bash
node tools/split-car-pack.mjs <pack.glb> --write
```

Nem farag geometriát: kocsinként másolatot készít, amiben az elágazó node
gyereklistája csak az adott kocsira szűkül, majd a `gltfpack` újraépíti a
puffert.

### B eset — háromszög-szintű

```bash
node tools/slice-car-pack.mjs <pack.glb> --write
```

Minden háromszöget a súlypontja szerint sorol egy kocsihoz, és kocsinként új
puffert épít. Csak akkor működik, ha a pack indexelt háromszögekből áll
`POSITION`/`NORMAL`/`TEXCOORD` attribútumokkal, tömörítés és csontváz nélkül —
mindhárom eddigi pack ilyen volt. Ellenőrizhető:

```bash
node --input-type=module -e "
import { loadGlb } from './tools/glb.mjs';
const { json: g } = loadGlb('<pack.glb>');
console.log(g.extensionsUsed, [...new Set(g.meshes.flatMap(m => m.primitives.flatMap(p => Object.keys(p.attributes))))]);
"
```

## 2. A kocsik azonosítása

A packok jellemzően semmit nem árulnak el (`Body27Mtl`, `Object_4`,
`MIRRORS.013_18`). **A festés textúrája viszont igen**: rajta van a rajtszám és
a pilóták neve, amiből az évjárat és a csapat egyértelmű.

Kocsinként pontosan egy EGYEDI anyag van (a karosszériáé), a többi közös a
mezőnyben. Ezt kiexportálva ránézésre azonosítható mind.

**Ne színek alapján tippelj.** A 2010-es packban a `car_0` festése 71%-ban
piros, ezért Ferrarinak néztem — valójában a **Virgin VR-01** volt. A rajtszám
(#24 Glock, #25 di Grassi) döntötte el.

Nem kell 3D-nézőt írni: a textúra önmagában elég.

## 3. Kerék-minta

A packból jött kocsiknál a névre épülő `tools/propose.mjs` **nem talál semmit**,
mert minden anyag ugyanúgy hívják. Helyette:

```bash
node tools/audit/wheels-by-geometry.mjs <kocsi.glb vagy mappa>
```

Az az anyag kerék, amit négy sarokra vágva négy egyforma átmérőjű, a forgás
síkjában kerek és a gumival koncentrikus csoport áll össze. A minta a pontos
anyagneveket sorolja fel, szóhatárra kötve (`név(?![^\s])`) — enélkül a `rim` a
`blur_rim`-et is megfogná.

## 4. Behozatal és élesítés

```bash
# 1. a GLB-t a végleges néven a helyére
cp <szeletelt>.glb web/assets/cars/2013_ferrari_f138.glb

# 2. kerék-config (a fenti geometriai minta alapján)
# 3. tömörített változat a multiplayerhez
npm run cars:compress -- 2013_ferrari_f138

# 4. ellenőrzés
node tools/audit/wheel-orbit.mjs --scan
node tools/audit/missing-wheel-parts.mjs
```

Élesítéskor **a GLB-ket külön fel kell tölteni**, mert gitignore-ban vannak — a
commit csak a JSON-configot és a `compressed/manifest.json`-t viszi:

```bash
scp -P 62222 -i ~/.ssh/levente web/assets/cars/<id>.glb root@169.58.43.205:/opt/racing/web/assets/cars/
scp -P 62222 -i ~/.ssh/levente web/assets/cars/compressed/<id>.glb root@169.58.43.205:/opt/racing/web/assets/cars/compressed/
```

Utána HTTP-n is ellenőrizd, ne csak azt, hogy a fájl ott van a lemezen:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://racing.levente.net/assets/cars/<id>.glb
```

### Névütközés

Ha a kocsi már létezik, a **régi** kapja a `_2` jelölést, az újonnan behozott a
sima nevet. Átnevezéskor a szerveren `mv`-vel dolgozz, ne tölts fel újra —
és ne feledd a `compressed/manifest.json` kulcsait sem.

Egy következmény, amivel számolni kell: a köridő-rekordok a kocsi
azonosítójával vannak elmentve, tehát átnevezés után a régi rekordok az új
modellhez tartoznak.

## Buktatók, amikbe belefutottunk

**A `-kn -km` megakadályozza a takarítást.** Ez a két kapcsoló a NÉVVEL
ellátott node-okat és anyagokat tartja meg, egy packban viszont mindennek van
neve — így a gltfpack semmit nem dobott el, és mind a 11 kimenet 45,7 MB lett.
A neveket nem lehet elhagyni (a kerékfelismerés azokra épül), ezért a *többi*
kocsi nevét kell elvenni.

**A gltfpack a jelenetből elérhetetlen node-okat sem dobja el.** A mesh-
hivatkozásukat is el kell vágni.

**A nem hivatkozott képeket végképp nem takarítja.** A 2014-es packnál mind a
102 kép bent maradt (23,6 MB) azután is, hogy az anyagok már kiestek. Az
anyagokat, textúrákat és képeket magunknak kell szűrni, újraindexeléssel.

**Háromszög-szintű vágásnál a transzformációt be kell égetni.** Elsőre a
lokális csúcspozíciókat írtuk ki, így a Sketchfab-export forgatása elveszett és
a kocsik az oldalukon feküdtek: 8,7 × **23,9** × 5,2 a helyes 8,7 × 5,2 × 23,9
helyett. A pozíciókra a teljes mátrix, a normálisokra a forgatás-rész
vonatkozik.

**A hézag nem jó elválasztó.** A kocsik szinte összeérnek (1,8 m széles autók
1,96 méterenként), ezért a hézag-küszöb egybefogta őket. A helyes szabály az
ÁTFEDÉS: két külön kocsi nem lóg egymásba, egy kocsi darabjai viszont igen.

**A kerék-átmérőnek nincs abszolút alsó korlátja.** A felni természetéből
adódóan kisebb a guminál (az F14 T-nél 0,31 a 0,56-hoz képest), és egy fix
küszöb pont a kerék belső részeit zárja ki — a felhasználó élőben vette észre,
hogy „a felni nem forog". A korlát a gumihoz képest relatív legyen.

**Koncentricitást a tengelyre MERŐLEGES síkban mérj.** A kerék az X tengely
körül forog, tehát a tengely menti eltolás közömbös: a kerék külső és belső
oldala 0,13-mal odébb ül, és egy 3D-távolság ezeket tévesen kizárja. Ugyanez a
hiba a kilengés-mérésnél is előjött, kétszer.

## Kapcsolódó

- `tools/README.md` — a hétköznapi eszközök (`cars:wheels`, `cars:compress`)
- `tools/audit/` — kerék-ellenőrzők: `wheel-orbit.mjs` (kileng-e valami),
  `missing-wheel-parts.mjs` (kimaradt-e kerék-alkatrész),
  `fix-wheel-orbit.mjs`, `caliper-exact.mjs`, `drop-nonround.mjs`
