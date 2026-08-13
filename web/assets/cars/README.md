# Autómodellek (`web/assets/cars/`)

A Node szerver a mappa gyökerében található `.glb` fájlokat automatikusan
felveszi az asset-manifestbe és a játékon belüli autóválasztóba. Nincs kézzel
karbantartott autólista.

## Fájlok

Egy autóhoz azonos azonosítóval ezek tartozhatnak:

```text
web/assets/cars/<azonosító>.glb             saját/játékosmodell
web/assets/cars/<azonosító>.json            opcionális konfiguráció
web/assets/cars/compressed/<azonosító>.glb  multiplayer- és Hot Lap-modell
car-masters/<azonosító>.glb                 eredeti master, ha készült
```

- A játékosmodell célmérete legfeljebb 15 MB.
- A `compressed/` modell célmérete legfeljebb 5 MB; ellenfelekhez és a Hot Lap
  szellemautóhoz ezt tölti le a kliens.
- A `car-masters/` nincs a webrootban, játék közben nem tölthető le. Ha van
  master, a tömörítő abból dolgozik, így nem egy már veszteséges modellből
  készít újabb változatot.
- A generált manifesteket ne szerkeszd kézzel; a modellfeldolgozó parancsok
  tartják őket naprakészen.

Az optimalizálás, a compressed modellek és a kerékkonfigurációk elkészítésének
aktuális parancsai a [modellfeldolgozó eszközök leírásában](../../../tools/README.md)
vannak.

## Autókonfiguráció

Az opcionális `<azonosító>.json` a modell mellett, azonos fájlnévvel található:

```json
{
  "yawDegrees": 0,
  "wheelPattern": "tyre|rim|disc|caliper"
}
```

- `yawDegrees`: extra Y tengely körüli forgatás fokban. Általában `0`; ha a
  modell hátrafelé néz, jellemzően `180`.
- `wheelPattern`: kis- és nagybetűtől független reguláris kifejezés. A játék a
  mesh, a szülő node-ok és az anyagok nevében keresi, majd ebből építi fel a
  gördülő és kormányzó vizuális kerékcsoportokat.
- Az aláhúzással kezdődő mezők, például `_wheelPattern` és `_yawDegrees`, csak
  megjegyzések. A szerver nem küldi őket a kliensnek.

Mindkét működési mező elhagyható. `wheelPattern` nélkül az autó használható,
de a kerekei vizuálisan nem gördülnek és nem kormányoznak. Hibás reguláris
kifejezés esetén a játék figyelmeztetést ír a konzolra, és kerékanimáció nélkül
folytatja a betöltést.

## Új autó feldolgozása

1. Másold a forrás `.glb` fájlt a mappa gyökerébe.
2. Futtasd a játékosmodell-optimalizálást: `npm run cars:optimize`.
3. Készítsd el vagy ellenőrizd a kerékkonfigurációt: `npm run cars:wheels`.
4. Készítsd el a multiplayer/ghost modellt: `npm run cars:compress`.
5. Ellenőrizd helyben az autó irányát és kerekeit a dev mód autókerék-
   tesztelőjében.

Egyetlen autó kerékjelöltjei külön is vizsgálhatók:

```bash
node tools/propose.mjs <azonosító>
```

A már kézzel javított konfigurációkat a kötegelt kerékfeldolgozó nem írja felül.
Kényszerített újragenerálás előtt mindig nézd át a meglévő `_wheelPattern`
megjegyzést, mert modellspecifikus kivételeket dokumentálhat.

## Kerékfelismerés röviden

A játék a `wheelPattern` találatait helyzet szerint négy sarokba csoportosítja.
Az egy meshbe összevont kerékgeometriát szükség esetén szétválasztja, majd a
látható kerekek közepe alapján X/Z irányban középre igazítja az egész modellt.
Ezért egy kerékmintába csak ténylegesen együtt gördülő elemek kerüljenek.
Felfüggesztést, lengőkart és más, kerék közelében lévő futóműelemet ne fogjon
meg a minta.

A végső ellenőrzés mindig vizuális: az automatikus elemző jó javaslatot ad, de
egy szokatlanul exportált modellnél kézi korrekcióra lehet szükség.
