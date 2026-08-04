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
web/       ← EZ és csak ez publikus (index.html, main.js, mp.js, vendor/, assets/)
server/    ← Node játékszerver: statikus kiszolgálás + REST + WebSocket + fizika
shared/    ← a kliens ÉS a szerver is használja (protocol.js, vehicleConfig.js)
tools/     ← offline GLB-elemzők (kerék-minták meghatározásához)
backup/    ← a kocsi-konfigurációk felülvizsgálat előtti állapota
```

A szerver **hiteles (authoritative)**: a teljes fizikát ő futtatja, a kliensek
bemenetet küldenek és a kapott állapothoz igazodnak. Enélkül két autó ütközése
nem nézne ki ugyanúgy a két képernyőn.

Ez azon áll vagy bukik, hogy a két oldal ugyanazt számolja:

- a `shared/vehicleConfig.js` tartalmaz **minden** fizikai állandót, és
  mindkét oldal onnan veszi — egy csak az egyik oldalon módosított érték
  tartósan elcsúsztatná a két szimulációt;
- a böngészőbe bemásolt Rapier build **bitre azonos** az npm-es
  `@dimforge/rapier3d-compat@0.14.0`-val (ha frissül, egyszerre kell mindkét
  oldalon);
- a szerver **ugyanazt a `collision.bin`-t** olvassa, amit a böngésző letölt.

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
  `collision.bin`-be. Multiplayerhez **kötelező**: így kap minden kliens és a
  szerver bitre azonos geometriát.
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

## Ami még hátravan

- **Client-side prediction.** A saját autó jelenleg a szerver állapotát
  követi, ezért nagy késleltetésnél lomha. (A késleltetés fölösleges fele már
  ki van véve.) Minden készen áll hozzá: közös fizika, azonos Rapier build, és
  a protokollban a `seq` mező.
- **Éles kiszolgálás**: systemd unit és `wss://` reverse proxy a VPS-en.
- A `main.js` egyetlen, ~4000 soros fájl, aminek nagyjából a fele fejlesztői
  eszköz — a multiplayer kliensnek nincs rá szüksége, szétszedhető.
