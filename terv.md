# Terv: Böngészős multiplayer autóverseny-játék

## Cél
Egy böngészőben futó autóverseny-játék, multiplayer támogatással — valós pályákkal és kocsikkal, nem Trackmania-stílusú ugratós/loopingos aréna. Backend PHP alapon, meglévő Ubuntu VPS-en (Apache + PHP + MySQL már fut, más projektek is élnek rajta — azokat nem szabad megzavarni).

## Fő architektúra

- **Kliens (frontend)**: Three.js a 3D megjelenítéshez, Cannon-es a jármű-fizikához (gyorsulás, kormányzás, felfüggesztés, valós pálya-domborzat követése). Sima HTML5 canvas + JS.
- **Real-time réteg**: PHP + **Swoole** — külön, hosszú életű PHP processz, ami WebSocket szervert futtat. Ez kezeli a szobákat (race room-ok), játékos pozíció broadcastot, ghost adatokat, élő versenyzést.
- **"Sima" backend**: a meglévő Apache + PHP (pl. Laravel/Symfony vagy akár sima PHP) marad a fiókkezelésre, pályaszerkesztőre, ranglistákra, ghost fájlok mentésére. Adatbázis: MySQL (már megvan).
- **Fizika-modell**: ha éles ütközéses verseny kell, a szerver legyen az "igazság forrása" (authoritative server), a kliens csak predict-el és korrigál a szerver visszajelzése alapján. Ez a legnehezebb technikai rész.

## Két lehetséges szint (nehézség szerint)

1. **Ghost-alapú multiplayer (egyszerűbb)**: mindenki külön futja a pályát, az időket és a "szellem" (ghost) replay-eket osztják meg egymással utólag vagy élőben megjelenítve. Ehhez elég egy sima REST API, nem kell Swoole/WebSocket. Gyorsan összerakható hobbi projektként.
2. **Élő, valós idejű verseny (nehezebb)**: mindenki egyszerre versenyzik, látják egymást mozogni valós időben, esetleg ütköznek is. Ehhez kell a Swoole WebSocket réteg, lag compensation, client-side prediction — hetek-hónapok munkája.
   (Utóbbi kell!)

## Swoole és a meglévő VPS (Apache + PHP + MySQL) együttélése

- A Swoole **nem helyettesíti** Apache-ot, külön, önálló PHP CLI processzként fut (pl. `php server.php`), saját maga event-loop szerverként hallgat egy portot (pl. 9502).
- Nem kell hozzá Apache, Nginx vagy PHP-FPM — a Swoole processz maga birtokolja a portot és tartja életben a kapcsolatokat.
- A meglévő Apache + PHP projektek **változatlanul** futnak a 80/443-as porton, semmilyen hatással nincs rájuk.
- A frontend az oldalt a 80/443-on tölti be (Apache-tól), a WebSocket kapcsolatot pedig közvetlenül a Swoole portjára nyitja (`ws://szerver.hu:9502`).
- Opcionális, de ajánlott: Nginx reverse proxy elé, hogy a WebSocket forgalom is a 443-as (SSL) porton menjen át szépen.

### Telepítési lépések vázlatosan
1. PHP-verzió ellenőrzése (Swoole PHP 8.x-hez optimális)
2. `pecl install swoole` (vagy forrásból build, ha nincs PECL)
3. Swoole-szerver szkript futtatása PHP CLI-vel — nem kell globálisan bekapcsolni Apache-nak, nem érinti a meglévő projekteket
4. Tűzfal (ufw) port megnyitása a WebSocket-nek
5. `systemd` service írása, hogy a szerver induláskor automatikusan elinduljon, crash esetén újrainduljon

## Nyitott döntési pontok / következő lépések
- Melyik szintet célozzuk meg először: ghost-alapú (gyors MVP) vagy élő verseny (komolyabb netcode)?
- Konkrét Swoole telepítési parancssor + minimál `server.php` példa kidolgozása a célszerveren
- Pályaszerkesztő adatformátum és tárolás (MySQL séma)
- Autentikáció / fiókkezelés módja (meglévő rendszerhez illesztve, ha van ilyen a VPS-en)

## Válaszok:
- élő verseny (komolyabb netcode)
- autentikáció elég egy játékos nevet megadni kezdésnek, szobákat lehet majd létrehozni amihez kóddal lehet csatlakozni, és a szoba tulajdonos tudja indítani a versenyt ha mindenki belépett