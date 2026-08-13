# Racing

Böngészőben futó autóverseny-játék valós pályákkal és autókkal. Three.js
megjelenítés, Rapier fizika, Node.js szerver, WebSocket multiplayer és opcionális
MySQL/MariaDB ranglista.

A jelenlegi assetkészlet 204 autót, 13 pályát és 6 környezetet tartalmaz. A menü
ezeket nem beégetett listából, hanem a szerver által felépített asset-manifestből
olvassa, ezért az új modellek automatikusan megjelennek.

## Indítás

Követelmény: Node.js 20 vagy újabb.

```bash
npm install
npm start
```

Ezután a játék a **http://localhost:3000** címen érhető el.

Fejlesztés közben automatikus Node-újraindítással:

```bash
npm run dev
```

Apache és PHP helyben nem kell: ugyanaz a Node folyamat szolgálja ki a statikus
fájlokat, a REST API-t és a WebSocket kapcsolatot.

MySQL/MariaDB opcionális. Ha elérhető, a szerver létrehozza a szükséges táblákat,
és megőrzi a játékosokat, köridőket, eredményeket és szellemköröket. Adatbázis
nélkül is elindul a játék, csak ezek nem maradnak meg. A beállításokhoz másold a
`.env.example` fájlt `.env` néven.

Tesztek:

```bash
npm test
```

## Játékmódok

### Egyjátékos

Hagyományos verseny választható körszámmal. A rajtvonalat és a checkpointokat
sorrendben kell teljesíteni. A kihagyott checkpoint, a teljes pályaelhagyás és
egyes szabálytalan mozgások érvénytelenítik az aktuális kört, de a játék folytatódik.

### Időmérés

Körszámkorlát nélküli Hot Lap mód külön időmérő rajtponttal. Indulás előtt a
ranglistáról választható szellemkocsi, de szellem nélkül is elindítható. A delta
az aktuális checkpointnál a kiválasztott szellemhez, vagy szellem nélkül az előző
saját körhöz viszonyít.

A szellemkocsi nem vesz részt a fizikában, így nem lehet vele ütközni. Ugyanazt a
legfeljebb 5 MB-os optimalizált modellt használja, mint a multiplayer ellenfelei,
de sima, szemcsézés nélküli áttetszőséggel jelenik meg.

### Többjátékos

Legfeljebb 8 játékos versenyezhet egy szobában. A szoba lehet publikus, ekkor
megjelenik a szobakeresőben, vagy privát, ekkor a hatjegyű kóddal lehet belépni.
A host választja ki a pályát, a körszámot és a szabályokat, majd elindítja a futamot.

A verseny csak akkor számol vissza, amikor minden csatlakozott játékos betöltött,
vagy lejárt a 30 másodperces betöltési időkorlát. A középső értesítés név szerint
mutatja, kire várunk; ha már minden játékos kész, „Várakozás a rajtra…” jelenik meg.
Egy megszakadt kapcsolat nem tartja bent korlátlanul a többieket.

Normál módban az autók ütköznek. A választható **Ghost mód** kikapcsolja az
autó–autó ütközést. Célba érés után a játék automatikusan nézői módba vált; a
következő gombbal a még versenyző játékosok között lehet lépkedni. A nézett autó
teljes vizuális és hangfrissítést kap akkor is, ha távol van.

## Kötelező kerékcsere

A szabály az Egyjátékos és Többjátékos módhoz kapcsolható be; Időmérésben nincs
értelme, ezért ott nem aktív.

- A boxbejárat átlépése után a rendszer legfeljebb 100 km/h-ra lassítja az autót.
- Minden rajthelyhez saját, azonos sorszámú boxhely tartozik.
- A saját boxhelyen 3 másodpercig folyamatosan állni kell.
- A boxkijárat átlépése után megszűnik a sebességkorlátozás és a már teljesített
  kerékcsere értesítése eltűnik.
- A kiállás bármelyik körben teljesíthető.
- Aki nem áll ki, annak az utolsó köre érvénytelen lesz, de a versenyt befejezheti.
- Egykörös futamban, illetve hiányos boxkonfiguráció esetén a szabály automatikusan
  inaktív, így nem tud hibásan érvényteleníteni egy futamot.

Egy teljes boxkonfigurációhoz legalább egy bejárat, legalább egy kijárat és
pontosan 8 boxhely szükséges. Bejáratból és kijáratból több vonal is megadható.

## Irányítás

- `W` / `↑`: gáz
- `S` / `↓`: fék, kis sebességnél tolatás
- `A`, `D` / `←`, `→`: kormányzás
- `Space`: kézifék
- `C`: kamera
- jobb egérgomb + húzás: körbenézés
- `R`: visszahelyezés az utolsó szabályosan érintett checkpoint környékére
- `M`: némítás

Az `R` csak az első rajtvonal-átlépés után használható. Ha a checkpointot aszfalton
lépte át az autó, oda kerül vissza, ahol áthaladt; pályán kívüli átlépésnél a
checkpoint közepére. A szerver engedélyezett teleportként kezeli, ezért önmagában
nem érvényteleníti a kört.

Mobilon külön kormány-, gáz- és fékgombok jelennek meg.

## Architektúra

```text
web/          publikus kliens és assetek
server/       statikus kiszolgálás, REST API, WebSocket és versenyvezérlés
shared/       kliens és szerver által közösen használt fizika és szabályok
tools/        autóelemző, kerékfelismerő és modelloptimalizáló eszközök
car-masters/  nagy autók nem publikus, teljes minőségű forrásmodelljei
test/         Node tesztcsomag
```

A saját autó fizikáját a játékos böngészője számolja fix 60 Hz-en, ezért a
kormányzás nem vár hálózati válaszra. A kliens az állapotát elküldi a szervernek;
a szerver ellenőrzi a mozgást, kezeli a rajtot, checkpointokat, köröket,
boxkiállást, eredményeket és szellemeket, majd 20 Hz-es snapshotokat továbbít.

A távoli autók késleltetett, adaptív interpolációval jelennek meg. A korrekció,
a kerékanimáció, a hang és a frissítési gyakoriság távolságfüggő; a nézett autó
mindig kivétel a ritkítás alól. A pillanatnyi kliens- vagy szerveroldali
főszálakadást a pingmérés kiszűri, a helyreállt alacsony pinget pedig gyorsabban
követi lefelé.

A szerver mozgásellenőrzése nem rúgja ki a játékost: valódi szabálytalanságnál az
aktuális kört érvényteleníti. A küszöbök számolnak a nagy sebességű pályákkal,
csomagtorlódással, pillanatnyi pingtüskékkel és a szabályos visszahelyezéssel.

A szobák memóriában élnek, mert folyamatosan változnak és szerver-újraindítás után
értelmüket vesztik. Az adatbázisba csak a tartós adatok kerülnek.

## Hálózati késleltetés tesztelése

Localhoston mesterséges ping és jitter kapcsolható az URL-ből:

```text
http://localhost:3000/?lag=150&jitter=30
```

Az értékek ezredmásodpercben, teljes oda-vissza útra értendők. Diagnosztika a
böngésző konzoljában:

```text
__mp.pingMs
__mp.jitterMs
__mp.interpDelayMs
__mp.rawPos
__mp.interpPos
```

## Fejlesztői mód

A menü **Fejlesztői mód** gombja szabad kamerás pályaszerkesztőt nyit.

### Zónák

Aszfalt, kifutó és opcionális, láthatatlan fal jelölhető:

- ecsettel, állítható sugárral;
- pontonként körberajzolt, kitölthető poligonnal;
- a pálya anyagainak elemzéséből automatikusan generálva.

A valódi falakat és kerítéseket elsősorban a pályamodellből sütött
`collision.bin` kezeli. A falzóna csak olyan extra lezárásokhoz kell, ahol nincs
megfelelő 3D geometria; attól még nem hiba, ha egy pálya alig használja.

### Rajtpontok, kapuk és boxutca

- Legfeljebb 8 normál rajtpont helyezhető el és forgatható.
- Külön időmérő rajtpont adható meg; hiányában a 8. normál rajthely az alapérték.
- A rajtvonal és bármely korábbi checkpoint utólag kijelölhető, mozgatható,
  átméretezhető és forgatható.
- Vezetővonal rajzolható az automatikus checkpoint-generáláshoz.
- Több boxbejárat és boxkijárat, valamint 8 számozott boxhely szerkeszthető.

### Ütközési háló

Az **Ütközés bekészítése** a pálya geometriájából `collision.bin` fájlt készít.
Multiplayerhez ez kötelező, mert a szerver és minden kliens ugyanazt az ütközési
hálót használja. Szűrhetőek az apró törmelékek, simíthatóak a rázókövek és
kizárhatóak a magas lombkoronák.

### Autókerék-tesztelő

Az autót helyben mutatja forgó és kormányzott kerekekkel. Itt a `W`/`S` és a
fel/le nyíl végiglépteti az autókat; a normál menüben ezek a billentyűk nem
változtatják meg a kiválasztást.

## Autók feldolgozása

Az új autók teljes automatikus feldolgozása külön lépésekből áll.

### Játékosmodellek optimalizálása

```bash
npm run cars:optimize
```

A 20 MB fölötti eredeti modelleket a nem publikus `car-masters/` mappában őrzi
meg, és legfeljebb 15 MB-os játékosmodellt készít belőlük. A kisebb autókat nem
duplázza feleslegesen.

### Multiplayer- és szellemmodellek

```bash
npm run cars:compress
```

Minden autóból legfeljebb 5 MB-os változatot készít a
`web/assets/cars/compressed/` mappába. Ha van master, abból dolgozik, nem a már
optimalizált játékosmodellből. A játék ezt használja a multiplayer ellenfeleihez
és az időmérő szellemkocsihoz.

Egy konkrét autó újragenerálása:

```bash
npm run cars:compress -- 2008_bmw_sauber_f1.08 --force
```

### Kerékkonfigurációk

```bash
npm run cars:wheels
```

Megírja a hiányzó `wheelPattern` konfigurációkat, de a már kézzel javítottakat
nem írja felül. Egy autó kényszerített újraelemzése:

```bash
npm run cars:wheels -- 2024_ford_mustang_gt3 --force
```

Az eredményt mindig érdemes a fejlesztői autókerék-tesztelőben ellenőrizni.
Részletes algoritmus és további kapcsolók: [tools/README.md](tools/README.md).

## Új pálya hozzáadása

Egy pálya mappája a `web/assets/maps/<pálya-id>/` könyvtárban él. A teljes
konfiguráció jellemzően:

```text
<pálya-id>.glb       látható pályamodell
collision.bin        előre sütött fizikai geometria
spawn.json           legfeljebb 8 rajthely
hotlap_spawn.json    külön időmérő rajtpont
gates.json           rajtvonal és checkpointok
pit.json             boxbejáratok, boxkijáratok és 8 boxhely
zonemap.png          aszfalt/kifutó/fal térkép
zonemap.json         a zónatérkép koordinátái
bake.json            az ütközési háló sütési beállításai
```

A JSON- és PNG-fájlok Gitben vannak. A nagy `*.glb` és `*.bin` fájlok gitignore-osak,
ezért új pálya élesítésekor ezeket külön fel kell tölteni a VPS azonos mappájába.
Ezután a Node szolgáltatást újra kell indítani, mert az asset-manifest gyorsítótárazott.

## Éles kiszolgálás

Az éles rendszer systemd szolgáltatásként fut Apache HTTPS/WebSocket reverse proxy
mögött. A pontos első telepítés, `.env`, jogosultságok, assetfeltöltés, frissítés
és hibakeresés leírása: [DEPLOY.md](DEPLOY.md).

Kódfrissítéskor általában Git pull és a `racing` szolgáltatás újraindítása kell.
Új vagy módosított gitignore-os assetet külön is fel kell tölteni; önmagában a
Git pull nem viszi fel a GLB, BIN, HDR és többi nagy modellfájlt.

## Jelenlegi korlátok

- A pályamodellek nagyok, jelenleg nagyjából 60–150 MB közöttiek, ezért egy új
  pálya első betöltése lassabb lehet. A tartalomverziózott, egyéves böngészőcache
  miatt a következő betöltés lényegesen gyorsabb.
- A saját autó fizikája kliensoldali, ezért autó–autó ütközésnél két játékos
  képernyője pillanatnyilag eltérhet. A szerver ettől függetlenül hitelesen kezeli
  a versenyszabályokat és eredményeket.
