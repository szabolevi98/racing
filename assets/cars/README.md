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

A középpont-számítás (mind itt, mind a szétvágásnál) a talált darabok
Z/X **mediánját** veszi, NEM az átlagát/min-max közepét — egyetlen
eltévedt, aszimmetrikus kis darab (pl. a McLaren MP4/21 forrás-
modelljében egy duplikált 'tread' töredék, ami messze a kerekektől,
z=-1.95-nél lógott) a min-max közepet teljesen félrecsúsztatná
(a kocsi jóval "előrébb" ülne, mint kellene), a mediánt viszont nem
zavarja meg egyetlen kilógó pont.

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

## Ha egy kocsi "lehetetlennek" tűnik: az Y-tartomány trükk

Néhány kocsinál a teljes modell mindössze pár (akár 5) mesh-ből áll,
mindegyik generikus néven (`Material_1`, `material_0` stb.), és mindegyik
mesh bounding boxa kb. a TELJES kocsit lefedi — első ránézésre úgy tűnik,
a karosszéria és a kerekek egyetlen anyagba vannak összeolvasztva,
szétválaszthatatlanul. **Ez megtévesztő**: egy versenyautó 4 kerekének
együttes fesztávja (szélesség + tengelytáv) már önmagában majdnem akkora,
mint a teljes kocsi lábnyoma, szóval egy "kocsi méretű" bounding box NEM
bizonyítja, hogy karosszéria is van benne.

A working teszt: nézd meg **anyagonként a világ-Y tartományt** (min/max
magasság), ne csak az X/Z méretet. Ha egy anyag Y-maximuma SOHA nem
emelkedik a talajszint fölé (kb. 0 körül vagy az alatt), az szinte biztos,
hogy csak a kerekeket (gumi+felni, alacsony profil) tartalmazza,
karosszéria/kokpit nélkül — azt onnantól a szokásos módon (geometria-
szétvágással) fel lehet dolgozni `wheelPattern`-ként.

Élő böngészős ellenőrzéshez (a `window.__debug` hook-on keresztül):

```js
const THREE = window.__debug.THREE;
const cp = window.__debug.carPivot;
let root = null;
cp.children.forEach(c => { let hasMesh=false; if(c.traverse) c.traverse(o=>{if(o.isMesh) hasMesh=true;}); if(hasMesh) root=c; });
root.traverse(o => {
  if (o.isMesh) {
    const b = new THREE.Box3().setFromObject(o);
    console.log(o.material.name, b.min.y.toFixed(2), b.max.y.toFixed(2));
  }
});
```

Ezzel a módszerrel derült ki, hogy a 2015 Sauber C34 és a 2014 Red Bull
RB10 EGYÁLTALÁN NEM volt lehetetlen (elsőre annak tűntek) — csak az
`inspect_glb.py` puszta X/Z méret alapján megtévesztő volt.

**Az `inspect_glb.py` script is hibázhat** — a 2014 Mercedes W05-nél
minden mesh-re kb. nulla méretet/pozíciót adott vissza (a fájl valamiért
nem olvasható helyesen a szkript egyszerű buffer-olvasásával), pedig a
modell teljesen normális. Ha a script kimenete értelmetlennek tűnik
(minden mesh kb. egy pontban, nulla mérettel), NE hidd el azonnal, hogy a
modell hibás — nézd meg élőben a fenti JS kóddal, mielőtt feladnád.

## Kocsinkénti állapot

Ezt NEM itt tartjuk nyilván (túl sok kocsi lesz ahhoz, hogy egy közös
táblázat kezelhető maradjon) — minden kocsi saját `<név>.json`-jában, a
`_wheelPattern`/`_yawDegrees` mezőkben van dokumentálva, HOGYAN lett
kitalálva a mintája, milyen csapdák voltak benne, és mit ellenőriztünk
élőben. Ha egy régebbi kocsinál nincs `wheelPattern`, érdemes újra
megpróbálni a fenti lépésekkel, mielőtt "lehetetlennek" könyvelnénk el
— korábban több kocsi is csak azért tűnt annak, mert a geometria-
szétvágás még nem létezett.

**Törölt kocsik** (a felhasználó törölte, buggos eredeti modellek — nem
a kerék-szétvágással volt gond, magukkal a fájlokkal): `2016_bmw_m6_gt3`.
(A `mercedes-benz_clk_gtr`-t a felhasználó visszatette, és a
kerék-szétvágással most már rendben megy — lásd a saját JSON-ját.)
