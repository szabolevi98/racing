# Racing

Böngészőben futó autóverseny-játék valós pályákkal és kocsikkal, élő
többjátékos módban. Three.js megjelenítés, Rapier fizika, Node.js szerver.

## Indítás

```bash
npm install
npm start
```

Utána: **http://localhost:3000**

Apache/PHP **nem kell** — a Node szerver szolgálja ki a statikus fájlokat, a
REST API-t és a WebSocket kapcsolatot is.

MySQL/MariaDB opcionális: ha fut, a szerver induláskor létrehozza a `racing`
adatbázist és a tábláit. Ha nem érhető el, a játék attól még megy, csak az
eredmények nem őrződnek meg. Beállítások: másold a `.env.example`-t `.env`-be.

## Mit tud

**Egyjátékos:** 146 kocsi, 6 pálya. Körmérés rajtvonallal és checkpointokkal,
érvénytelen kör jelzése (kihagyott checkpoint vagy mind a négy kerékkel
lehagyott aszfalt), visszaszámlálás, eredménytábla, `R` a visszahelyezéshez.

**Többjátékos:** a menüben a *Többjátékos* gomb. Név megadása → szoba
létrehozása (6 karakteres kódot ad) vagy csatlakozás kóddal → a szoba
tulajdonosa indítja a versenyt. A játékosok **ütköznek** egymással, látják
egymás nevét, és a körök/eredmények a szerveren dőlnek el.

## Architektúra

```
web/       ← EZ és csak ez publikus (index.html, main.js, mp.js, dev.js, vendor/, assets/)
server/    ← Node játékszerver: statikus kiszolgálás + REST + WebSocket + versenyvezérlés
shared/    ← a kliens ÉS a szerver is használja (protocol.js, vehicleConfig.js)
tools/     ← offline GLB-elemzők (kerék-minták meghatározásához)
backup/    ← a kocsi-konfigurációk felülvizsgálat előtti állapota
```

A saját autó fizikáját mindig a játékos böngészője számolja. A szerver a kapott
állapotokat ellenőrzi, továbbítja, és központilag kezeli a rajtot, köröket,
checkpointokat, eredményeket és szellemeket. Emiatt a saját autót nagy ping sem
rángatja vissza, viszont az autó–autó ütközés eltérhet a játékosok képernyőjén.
Az irreális sebesség vagy mozgás nem dobja ki a játékost, hanem érvényteleníti
az adott körét és figyelmeztetést küld.

A szobák memóriában élnek (másodpercenként sokszor változnak, és egy
újraindítás után értelmüket vesztenék); MySQL-be az kerül, ami túléli a
versenyt: játékosok, köridők, eredmények.

## Fejlesztői eszközök

A menüben a *Fejlesztői mód* gombbal érhetők el:

- **Zóna-szerkesztő** — felülnézeti ecsettel aszfalt / kifutó / fal maszk
  festése. A kifutó lassít, a fal visszatart. A pálya anyagainak bélyegképeiről
  a maszk automatikusan is legenerálható.
- **Checkpointok** — rajtvonal és checkpointok rajzolása, vagy automatikus
  generálás a pálya bejárásával.
- **Rajtrács** — akár 8 rajtpont iránnyal (a multiplayerhez).
- **Ütközés bekészítése** — a pálya háromszöghálójának kimentése
  `collision.bin`-be. Multiplayerhez **kötelező**: így minden kliens ugyanazt
  a geometriát használja.
- **Kocsi-teszt** — a kocsi egy helyben, forgó kerekekkel; az új kocsik
  kerék-mintájának ellenőrzésére.

Új kocsi kerék-mintájához: `node tools/propose.mjs <kocsi-id>` — részletek a
[tools/README.md](tools/README.md)-ben.

## Hogy tudjon más is játszani

A szerver minden interfészen figyel, tehát elég a **3000-es portot** kiengedni
(routeren átirányítva akár más külső portra), és a többiek a
`http://<cím>:<port>/` alatt elérik.

Számolj vele, hogy az **első** betöltés nagy: egy pálya 63–148 MB, és ez a te
feltöltési sávszélességeden megy át. A szöveges tartalmak tömörítve mennek (az
alapbetöltés 3,9 MB helyett 1,1 MB), a nagy fájlok pedig egy éves cache-t
kapnak — a **második** indulás ezért már azonnali. Ha ennél is gyorsabb kell,
magukat a modelleket kell zsugorítani (Draco geometria, KTX2 textúrák).

## Hálózati késleltetés kezelése

A saját autót a kliens szimulálja, ezért a vezérlés nem vár hálózati válaszra.
A szervernek 60 Hz-en állapotot küld; a szerver ezeket ellenőrzi, a többi
játékos pedig késleltetett interpolációval jeleníti meg. A ping főleg az
ellenfelek mozgásának késésében és az ütközések eltérő érzékelésében látszik.

Fejlesztéshez mesterséges késleltetés kapcsolható, mert localhoston a ping 0:

```
http://localhost:3000/?lag=150&jitter=30      # ms, teljes körbefordulás
```

Diagnosztika a konzolban: `__mp.pingMs`, `__mp.jitterMs`,
`__mp.interpDelayMs`, `__mp.rawPos` és `__mp.interpPos`.

## Ami még hátravan

- **A zóna-szerkesztő fal-ecsete opcionális.** A valódi falakat/kerítéseket a
  pálya 3D modelljéből kinyert, bekészített ütközési háló (`collision.bin`)
  állítja meg — ez a kasztnira külön collidert épít (lásd
  `shared/vehicleConfig.js`: `COLLISION_GROUP_WALL`/`FLOOR`,
  `WHEEL_RAY_FILTER_GROUPS`), a kerék-sugarat nem zavarja. A fal-ecset és a
  hozzá tartozó zóna-alapú visszalökés (`shared/zone.js`) ettől függetlenül
  tovább is megy, csak láthatatlan, extra falak kijelölésére kell ott, ahol
  nincs 3D geometria (pl. egy szakasz lezárása).
- **Éles kiszolgálás**: systemd unit és Apache reverse proxy a VPS-en. A kliens
  `wss://`-re már magától vált HTTPS alatt; a szerver oldali teendők leírva a
  [DEPLOY.md](DEPLOY.md)-ben.
- **Kisebb pályamodellek**: az első betöltés még mindig 63–148 MB. Draco
  geometria és KTX2 textúrák nélkül ez távoli játékosnál percekben mérhető.
