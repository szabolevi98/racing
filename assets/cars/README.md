# Kocsik (`assets/cars/`)

Minden kocsi egy `.glb` fájl, amit a `list.php` automatikusan felvesz a
menübe — nincs kézzel karbantartandó lista. A `.glb` mellé, **ugyanazzal
a névvel**, tehető egy `<név>.json` config fájl a kocsi-specifikus
beállításokhoz. A config teljesen opcionális — ha nincs, a játék
alapértelmezéssel tölti be a kocsit (nincs kerékforgás, nincs extra
forgatás).

**Semmi nincs beégetve a kódba (`main.js`) egyik kocsihoz sem.** A
`main.js`-ben csak általános logika van (forgatás, méretezés,
kerék-felismerés/szétvágás), ami minden kocsira ugyanúgy lefut — a
kocsi-specifikus adatok (előre-irány, melyik mesh a kerék) mind a JSON-ban
vannak.

## A JSON mezői

```json
{
  "yawDegrees": 0,
  "wheelPattern": "TIRE|BRAKE_"
}
```

- **`yawDegrees`** — extra elforgatás fokban, ha a modell nem előre néz.
  A hossz-tengelyt (X vagy Z) a játék magától felismeri; ez csak az
  előre/hátra felcserélést javítja (tipikusan `0` vagy `180`).
- **`wheelPattern`** — reguláris kifejezés (kis-nagybetű független),
  ami megmondja, mely mesh-ek tartoznak a kerekekhez. A minta a mesh
  (és szülei) NEVÉHEZ **és** az anyag(ok) nevéhez is illeszkedik —
  van modell, ahol a kerékre utaló infó csak az egyikben van meg.
  Ha nincs `wheelPattern`, a kerekek nem forognak/kormányoznak
  vizuálisan (a fizika attól még rendben megy).

Mindkét mező elhagyható. `_megjegyzes`-szerű, aláhúzással kezdődő
mezők csak dokumentáció, a játék nem olvassa őket — ide írjuk, HOGYAN
találtuk ki az adott értéket, hogy legközelebb ne kelljen újra
kinyomozni.

## Hogyan dönti el a játék, melyik a kerék, és hogyan forgatja

1. A `wheelPattern` regex-nek megfelelő mesh-eket összegyűjti
   (`buildWheelPivots` a `main.js`-ben).
2. Ha egy találat MAGA is túl nagy egy kerékhez (mindkét vízszintes
   irányban), az azt jelenti, hogy több kerék van egyetlen
   geometriába összeolvasztva (tipikus Sketchfab-exportoknál,
   anyagonként egy mesh) — a játék ekkor a saját háromszögeit
   pozíció szerint szétvágja (`splitMergedWheelMesh`), a TELJES
   kerék-készlet közepéhez képest, nem a mesh saját közepéhez képest
   (különben egy csak-egy-tengelynyi darabot tévesen kettévágna).
3. A (esetleg szétvágott) darabokat pozíció szerint 4 sarokba
   csoportosítja (elöl-jobb/bal, hátul-jobb/bal). Ha csak bal/jobb
   van külön (elöl/hátul összeolvadva), "tengely-módra" vált: a
   kerekek gördülnek, de nem kormányoznak.
4. Minden sarokhoz egy pivot-ot hoz létre a csoport LEGNAGYOBB
   TÉRFOGATÚ darabjának (szinte mindig a gumi) középpontján — nem az
   átlagon, mert egy féknyereg/tárcsa messze eshet a valódi
   tengelytől, és az átlag "kilendítené" a kereket forgás közben.

## Automatikus középre-igazítás (X/Z)

Ha van `wheelPattern`, a játék betöltéskor (a `setCar`-ban, MÉG a
`carPivot`-hoz adás előtt) megméri, hol van a LÁTHATÓ kerekek
középpontja, és eltolja az egész modellt, hogy az pontosan a fizikai
kerekek helyére (X=0, Z=0, ahol a fizika ±1.5-nél várja őket) essen.

Ez azért kell, mert néhány letöltött fájl saját origója nincs a
tengelytáv közepén (pl. a 2004 Ferrari F2004-nél a látható kerekek
z=+2.79/-0.21-nél voltak a fájl saját koordinátáiban, nem ±1.5-nél) —
enélkül az egész látható kocsi eltolva ülne a láthatatlan fizikai
dobozhoz képest, és az egyik vége jobban belelógna a falba
ütközéskor, mint kellene. Ez a lépés MINDEN `wheelPattern`-es kocsinál
lefut, nem csak az F2004-nél — a már jól középre igazított kocsiknál
(M3 GTR, M6 GT3, stb.) csak egy alig észrevehető, tört egységnyi
korrekciót ad, nem árt nekik.

## Hogyan tegyünk be egy új kocsit

1. Tedd be a `.glb`-t ide, ez automatikusan megjelenik a menüben.
2. Nézd meg, néz-e előre alapból (indítsd el, nézd meg a menü-
   előnézetben) — ha nem, írj egy `yawDegrees`-t a JSON-ba.
3. A kerekekhez: futtasd le rá az `inspect_glb.py`-t (ebben a
   mappában, `python assets/cars/inspect_glb.py assets/cars/<fájl>.glb`)
   — kiírja minden mesh node nevét, anyagát, világ-középpontját és
   méretét. Ebből keresd meg a kerékhez tartozó mesh/anyag neveket.
   Két tipikus eset:
   - **Névvel ellátott, külön objektumok** (pl. `LOD_A_TYRE_...`,
     `wheel_fl_1`) — ezek NEVE alapján lehet mintát írni.
   - **Anyagonként egy mesh, generikus objektum-név** (pl.
     `lamborghini_countach_7`) — ilyenkor az ANYAG neve (pl. `Tyre`,
     `EXT_metal_rim`) alapján kell mintát írni; a mesh neve semmit
     nem árul el.
4. Az előre-irányt (ha nincs egyértelmű névminta) a fényszóró/hátsó
   lámpa anyagának Z-pozíciójából, vagy — ha az sincs — a hátsó
   gumik szélesebb méretéből lehet kitalálni (a hátsó gumi szinte
   mindig szélesebb).
5. Ellenőrzés: töltsd be a kocsit, nézd meg a `window.__debug.carPivot`
   gyerekei közül a 4 (vagy 2) `YXZ`-rendezésű `Group`-ot — a
   pozícióiknak szimmetrikusnak kell lenniük (pl. `x: ±0.8`), és a
   csoportok méretének egyformának (pl. 6/6/6/6, nem 7/7/10/18).
   Ha ez nem áll fönn, a `wheelPattern` túl sokat vagy túl keveset fog.

   **FIGYELEM méréskor**: a `carPivot` a menü-előnézetben a rajtpont
   iránya felé van forgatva (nem 0 fok) — ha ELFORGATVA méred egy
   `Box3().setFromObject(...)`-tal a kocsi méretét, az AABB torzul, és
   a kocsi valótlanul szélesebbnek tűnik (ez már kétszer becsapott:
   RB14, majd a Pagani "gyanús szélessége" is ez volt). Méréshez vagy
   `carPivot.rotation.set(0,0,0)` + `updateMatrixWorld(true)` után
   nézd meg (utána vissza kell állítani a mentett quaternion-t), vagy
   simán mérd az egyes mesh-eket helyi (nem világ-) koordinátában.

## Jelenlegi állapot (kocsinként)

| Kocsi | Kerék-mód | `wheelPattern` |
|---|---|---|
| `2001_bmw_m3_gtr_e46` | sarkonként (gördül + kormányoz) | `TIRE\|BRAKE_` |
| `2004_ferrari_f2004` | sarkonként | `wheel` |
| `1962_ferrari_250_gto` | sarkonként — geometria-szétvágással (eredetileg csak tengely-mód volt) | `LOD_A_TYRE\|LOD_A_WHEEL\|LOD_A_BRAKE_CALIPER` |
| `1988_lamborghini_countach` | sarkonként — geometria-szétvágással | `Tyre\|EXT_metal_rim\|EXT_metal_disk\|EXT_metal_caliper` |
| `2018_redbull_rb14` | sarkonként — geometria-szétvágással (4/4/4/4, tyre+rim+hub+disc sarkonként) | `Tyre_thread\|tyre_side\|redbull_wheel_hub\|discs` |
| `2010_pagani_zonda_cinque` | sarkonként (156/156/165/165 darab, nagyon rendetlen export) — a felhasználó megerősítette, hogy megy | `Wheel\|Caliper\|Tyre\|Tire\|Rim\|Disc\|Hub` |
| `2020_mclaren_mcl35` | sarkonként (2/2/2/2, kivételesen tiszta modell — gumi+felni már eleve külön node-onként a 4 sarokban, szétvágás sem kellett) | `LOD_A_TYRE\|LOD_A_WHEEL_` |
| `2011_bmw_z4_gt3` | sarkonként (5/5/5/5: gumi+felni+tárcsa+nyereg egy csomóban) — nagyon generikus export, a legtöbb anyagnak nincs neve (`Material_NN.001`), csak az `EXT_Tyre` kapott értelmes nevet; a felni/tárcsa/nyereg névtelen anyagait EXAKT névvel (`Material_59/60/62/63.001`) kellett felvenni a mintába, mert ezek a sorszámok csak ebben az egy fájlban stabilak | `EXT_Tyre\|Material_59.001\|Material_60.001\|Material_62.001\|Material_63.001` |
| `2006_mclaren_mp421` | sarkonként (~11/10/11/11, gumi+felni+küllő+tárcsa+nyereg+elmosás-textúra egy csomóban) — tiszta, névvel ellátott kerék-anyagok (brake/calliper/disk/blur1/blur2/MCLRIM/MCLSPOKES/side/tread/MCLHUB), geometria-szétvágással | `brake\|calliper\|disk\|blur1\|blur2\|MCLRIM\|MCLSPOKES\|side\|tread\|MCLHUB` |

**Törölt kocsik** (a felhasználó törölte, buggos eredeti modellek — nem a kerék-szétvágással volt gond, magukkal a fájlokkal):
- `mercedes-benz_clk_gtr`
- `2016_bmw_m6_gt3`

Ha egy kocsinál `wheelPattern` nélkül vagy "nincs" szöveggel áll a
config, az korábbi, a geometria-szétvágás ELŐTTI állapotot tükrözhet —
érdemes újrapróbálni, mielőtt "lehetetlennek" könyvelnénk el.
