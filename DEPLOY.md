# Éles kiszolgálás — racing.levente.net

Hogyan kerül a játék a VPS-re, hogy a te géped nélkül, magától fusson, saját
aldomainen, HTTPS-sel — **anélkül, hogy a már ott futó `levente.net`-hez
hozzányúlnánk**.

> **Ez terv, nem kipróbált recept.** Egyik lépés sincs élesben végigjátszva —
> amikor sorra kerül, várható, hogy apróságokon igazítani kell.

## Mi van már készen

- **A DNS beállítva.** `racing.levente.net` → `169.58.43.205`, közvetlenül.
  A `levente.net` maga Cloudflare-en megy, de ez az aldomain **nem** — ami itt
  előny: a 100+ MB-os pályaletöltések és a WebSocket közvetlenül mennek, nincs
  köztes szolgáltatói limit, és a certbot HTTP-ellenőrzése is gond nélkül fut.
- **A `wss://` a kódban megoldott.** Nincs vele semmi teendő: a kliens magától
  dönt (`web/mp.js:205`), `location.protocol === 'https:' ? 'wss' : 'ws'`.
  Amint HTTPS-en szolgálod ki az oldalt, a WebSocket is titkosítva megy.
- **Nincs build-lépés.** A `package.json`-ban csak `start` és `dev` van, a
  kliens nyers ES-modulokat használ. Amit felviszel, az fut.

## Mi az a reverse proxy — röviden

Az Apache már fut a gépen, és ő birtokolja a 80/443-as portot. A játék egy Node
folyamat, ami a 3000-esen figyel. A reverse proxy annyit tesz, hogy az Apache a
`racing.levente.net`-re jövő kéréseket **továbbadja** a Node-nak, a választ meg
visszaküldi a böngészőnek:

```
böngésző ──https://racing.levente.net──> [Apache :443] ──http://127.0.0.1:3000──> Node
              TLS, tanúsítvány                            belső, titkosítás nélkül
```

Két dolgot nyerünk: a Node-nak nem kell tanúsítványt kezelnie, és nem kell
rootként futnia ahhoz, hogy a 443-as porton legyen elérhető. A `levente.net`
ettől függetlenül megy tovább a saját VirtualHostjában — külön fájl, külön
`ServerName`, nem érnek egymáshoz.

Ehhez kell még egy **systemd unit**: az a ~15 soros fájl írja le, hogyan induljon
a Node folyamat. Cserébe elindul bootoláskor, újraindul összeomlás után, a
`console.log`-ok naplóba mennek (`journalctl`), és nem rootként fut.

## Előfeltételek

- ~4 GB szabad lemez (a kód elenyésző, az assetek 2,9 GB)
- **Node 20+** — ez még nincs a gépen, az 1. lépés telepíti

## 1. Node telepítése

Az Ubuntu saját csomagja túl régi lehet, ezért a NodeSource tárolóból:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # v22.x kell, minimum v20
```

## 2. A kód és az assetek felvitele

Ez két külön menet, mert a nagy binárisok **nincsenek** a gitben (`.gitignore`:
`*.glb`, `*.hdr`, `*.bin`, textúrák). A gitben csak a kód és a kézzel készített,
pótolhatatlan adat van (`zonemap.png`, `spawn.json`, `gates.json`).

A repo **privát**, ezért a VPS-nek olvasási jogot kell adni hozzá. Erre a
*deploy key* való: egy kulcs, ami **csak ehhez az egy repóhoz** ad hozzáférést,
csak olvasásra, és bármikor visszavonható a GitHubon. Jelszót nem kell hozzá
begépelni, tehát a `git pull` később automatizálható.

```bash
# 1) kulcs a VPS-en (a -N "" jelenti, hogy nincs rajta jelszó)
sudo ssh-keygen -t ed25519 -C "racing-vps-deploy" -f /root/.ssh/id_ed25519 -N ""
sudo cat /root/.ssh/id_ed25519.pub        # ezt a sort másold ki

# 2) a github.com kulcsának elfogadása előre, hogy a klónozás ne kérdezzen
sudo ssh-keyscan github.com | sudo tee -a /root/.ssh/known_hosts
```

A kimásolt `ssh-ed25519 AAAA...` sort a GitHubon:
**repo → Settings → Deploy keys → Add deploy key** — illeszd be, az *Allow write
access* pipát **hagyd üresen** (a VPS-nek nem kell írnia).

```bash
# 3) klónozás SSH-val
sudo git clone git@github.com:szabolevi98/racing.git /opt/racing
cd /opt/racing && sudo npm ci --omit=dev
```

> Ha a repo mégis publikus marad, mindez kihagyható:
> `sudo git clone https://github.com/szabolevi98/racing.git /opt/racing`

Az assetek a **te gépedről** mennek fel (~2,9 GB, egyszeri). Git Bashból:

```bash
rsync -avP /d/xampp/htdocs/racing/web/assets/ root@169.58.43.205:/opt/racing/web/assets/
```

Ha nincs `rsync` a Git Bashban, `scp -r` is működik — csak nem folytatható, ha
megszakad, ami 2,9 GB-nál nem mindegy. Alternatíva Windowsra: WinSCP.

## 3. Adatbázis

A MariaDB már fut. A játéknak **saját adatbázis és saját felhasználó** kell —
ne a rootot használd, és ne a `levente.net` adatbázisát:

```bash
sudo mariadb -e "CREATE DATABASE racing CHARACTER SET utf8mb4;"
sudo mariadb -e "CREATE USER 'racing'@'127.0.0.1' IDENTIFIED BY 'IDE-EGY-HOSSZU-JELSZO';"
sudo mariadb -e "GRANT ALL PRIVILEGES ON racing.* TO 'racing'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

A táblákat az app magától létrehozza az induláskor. Ha nincs adatbázis, a játék
attól még megy, csak az eredmények nem őrződnek meg.

## 4. `.env` élesre

```bash
cd /opt/racing && sudo cp .env.example .env && sudo nano .env
```

Élesen ez a három sor a lényeg:

```ini
ALLOW_DEV_WRITES=0
HOST=127.0.0.1
DB_PASSWORD=IDE-A-FENTI-JELSZO
```

Plusz `DB_USER=racing`.

> ⚠️ Az `ALLOW_DEV_WRITES` alapból **BE van kapcsolva**: a kód
> `process.env.ALLOW_DEV_WRITES !== '0'` (`server/index.js`). Ha elfelejted
> kikapcsolni, a dev mentések élnek — azok jogosultság-ellenőrzés nélkül írnak
> lemezre, tehát bárki felülírhatná a zónatérképeket és az ütközési hálókat.

> A `HOST=127.0.0.1` nélkül a Node **minden interfészen** figyel, vagyis a
> 3000-es port kívülről közvetlenül is elérhető lenne, megkerülve a proxyt és
> vele a HTTPS-t. Öv és nadrágtartó: `sudo ufw deny 3000`.

## 5. systemd unit

`/etc/systemd/system/racing.service`:

```ini
[Unit]
Description=Racing jatekszerver
After=network.target mariadb.service

[Service]
Type=simple
User=racing
WorkingDirectory=/opt/racing
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Nincs `EnvironmentFile` sor, és ez szándékos: az app `import 'dotenv/config'`-ot
használ, tehát a `.env`-et **maga olvassa be** a `WorkingDirectory`-ból. Ha
mindkettő be lenne állítva, a systemd szigorúbb formátumigénye (idézőjelek,
kommentek) fölöslegesen okozna hibát.

```bash
sudo useradd -r -s /usr/sbin/nologin racing

# A kód MARAD a root birtokában, a racing felhasználó csak olvassa.
# Így a szolgáltatás nem tudja átírni a saját kódját, és a későbbi
# `sudo git pull` sem ütközik a git "dubious ownership" védelmébe (az akkor
# szólal meg, ha rootként futtatod egy más birtokolta repóban).
# Ez azért elég, mert élesben az app SEMMIT nem ír lemezre: az egyetlen író
# útvonal a devApi.js, amit az ALLOW_DEV_WRITES=0 kikapcsol.
sudo chown -R root:root /opt/racing
sudo chmod -R a+rX /opt/racing

# A .env viszont adatbázis-jelszót tartalmaz: ne legyen mindenki által olvasható.
sudo chown root:racing /opt/racing/.env
sudo chmod 640 /opt/racing/.env

sudo systemctl daemon-reload
sudo systemctl enable --now racing
journalctl -u racing -f          # így látod a naplót
```

Itt már ellenőrizhető, hogy a Node maga megy-e, még proxy nélkül:

```bash
curl -I http://127.0.0.1:3000/     # 200 kell
```

## 6. Apache reverse proxy

Három modul kell, ebből a harmadik a lényeg:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel ssl
```

A `proxy_wstunnel` engedi át a WebSocketet. **Enélkül az oldal betöltődik, de a
*Többjátékos* gomb csendben nem csinál semmit.**

Új, **külön** fájl — a `levente.net` konfigját nem nyitjuk meg:
`/etc/apache2/sites-available/racing.levente.net.conf`

```apache
<VirtualHost *:80>
    ServerName racing.levente.net
    # A certbot ezt fogja átírni https-átirányításra.
    ProxyPass        /    http://127.0.0.1:3000/
    ProxyPassReverse /    http://127.0.0.1:3000/
</VirtualHost>
```

```bash
sudo a2ensite racing.levente.net
sudo apache2ctl configtest        # "Syntax OK" kell
sudo systemctl reload apache2     # reload, nem restart
```

> A `ServerName` az, ami elválasztja a két oldalt: az Apache a `Host` fejléc
> alapján dönt, melyik VirtualHost szolgálja ki a kérést. A `levente.net`-re jövő
> kérések ugyanoda mennek, ahova eddig.

## 7. Tanúsítvány

```bash
sudo certbot --apache -d racing.levente.net
```

Ez **csak ezt az egy hostot** érinti: legyártja a tanúsítványt, létrehoz egy
`*:443`-as VirtualHostot, és beállítja az automatikus megújítást. Amikor
megkérdezi, kérd a http → https átirányítást.

Utána a 443-as blokkba még be kell írni a WebSocket-szabályt, mert a certbot
csak a sima `/` proxyt másolja át. A `racing.levente.net-le-ssl.conf`-ban:

```apache
    # FIGYELEM: a /ws-nek a "/" ELŐTT kell állnia
    ProxyPass        /ws  ws://127.0.0.1:3000/ws
    ProxyPassReverse /ws  ws://127.0.0.1:3000/ws

    ProxyPass        /    http://127.0.0.1:3000/
    ProxyPassReverse /    http://127.0.0.1:3000/
    ProxyPreserveHost On

    # Az alapértelmezett 300 s elvághatja a lobbyban tétlenül ülő játékost
    ProxyTimeout 3600
```

A `/ws` a kliens tényleges útvonala (`web/mp.js`).

Az Apache **felülről lefelé** nézi a `ProxyPass` szabályokat, és az elsőt
használja, ami illeszkedik. Ha a `/` kerül előre, minden WebSocket kérés is oda
megy sima HTTP-ként — **ez a leggyakoribb hiba ennél a felállásnál.**

Az egészet **a Node-nak adjuk tovább**, az Apache nem szolgál ki statikus fájlt
közvetlenül. Így megmarad a Node-ba épített cache-kezelés — nem kell két helyen
karbantartani ugyanazt.

## Ellenőrzés

1. `curl -I https://racing.levente.net/` → 200, HTTPS-en
2. **`curl -I https://levente.net/` → a régi oldal is megy** (ezt ne hagyd ki)
3. A menü betölt, a pálya/kocsi legördülő tele van
4. **Többjátékos → Csatlakozás a szerverhez** → ha ez működik, a `wss://` átmegy
   a proxyn (ez az a lépés, ami `proxy_wstunnel` nélkül elhal)
5. Szoba létrehozása, verseny indítása két böngészőből
6. `sudo systemctl restart racing` → a játék pár másodperc múlva újra elérhető

## Ha valami nem megy

- **A menü se jön be:** a Node megy-e? `systemctl status racing`,
  `journalctl -u racing -n 50`. Aztán `curl -I http://127.0.0.1:3000/`.
- **Az oldal megy, a Többjátékos nem:** ez a `proxy_wstunnel`, vagy a `/ws`
  szabály sorrendje. `sudo a2enmod proxy_wstunnel && sudo systemctl reload apache2`.
  A böngésző konzoljában a WebSocket hiba is látszik.
- **Üres kocsi/pálya lista:** az assetek nem mentek fel, vagy a `racing`
  felhasználó nem olvashatja őket. `ls /opt/racing/web/assets/maps/`, majd
  `sudo chmod -R a+rX /opt/racing`.
- **„dubious ownership" a `git pull`-nál:** a repo nem a root birtokában van.
  Vagy `sudo chown -R root:root /opt/racing`, vagy
  `sudo git config --global --add safe.directory /opt/racing`.
- **„A pálya ütközési fájlja nem tölthető le"** a multiplayer indításánál: a
  `collision.bin` fájlok hiányoznak az assetek közül. Ezek nélkül a multiplayer
  szándékosan nem indul (a szerverrel bitre egyeznie kell a geometriának).

## Amivel számolni kell

Az **első** betöltés minden új játékosnál nagy: egy pálya 63–148 MB, plusz a
kocsi. A nagy fájlok egy éves cache-t kapnak, tehát a második indulás azonnali,
de a sávszélesség-számlát az elsők adják. Az assetek zsugorítása (Draco
geometria, KTX2 textúrák) egyelőre szándékosan kimarad.

Frissítés később:

```bash
cd /opt/racing && sudo git pull && sudo npm ci --omit=dev
sudo chmod -R a+rX /opt/racing        # az új fájlok is olvashatók legyenek
sudo systemctl restart racing
```

Ez a deploy key-jel megy, jelszó nélkül (a `sudo` miatt a root kulcsát
használja, amivel a klónozás is történt).

Az assetek nem változnak `git pull`-lal — azokat külön kell rsync-elni, ha új
pálya vagy kocsi kerül be.
