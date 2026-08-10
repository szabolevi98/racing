# Éles kiszolgálás — racing.levente.net

Hogyan kerül a játék a VPS-re, hogy a te géped nélkül, magától fusson, saját
aldomainen, HTTPS-sel — **anélkül, hogy a már ott futó `levente.net`-hez
hozzányúlnánk**.

> **Ez már végig van játszva élesben** (2026-08-04), a lépések sorrendje és a
> parancsok működnek. Az alábbi „Ellenőrzés" szakasz eredményei mértek.

## Ami már fut

A játék él a `https://racing.levente.net`-en. A gépen:

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS |
| Node | v22.23.2 (`/usr/bin/node`) |
| SSH | **62222-es port**, nem a 22-es |
| Kód | `/opt/racing`, root birtokában, a `racing` user olvassa |
| Service | `racing.service`, `systemctl status racing` |
| DB | `racing` adatbázis + `racing` user; a jelszó a `/root/.racing-db-pass`-ban és a `.env`-ben van, máshol nem |
| Tanúsítvány | Let's Encrypt, 2026-11-02-ig, automatikus megújítással |
| Deploy key | `/root/.ssh/racing_deploy`, a GitHubon read-only deploy key-ként |

A gépen **hat másik oldal is fut** (levente.net, auth, cloudexus, politics,
szabolevente.eu/.net). A racing külön vhost-fájlba került, a meglévőket nem
nyitottuk meg — és a telepítés előtt/után is ellenőrizve lett, hogy mind a hat
ugyanazt a válaszkódot adja.

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

- ~6 GB szabad lemez: a kód elenyésző, az **assetek 5,0 GB** (kocsik 2,2 GB,
  pályák 571 MB, égboltok 131 MB)
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
ssh-keygen -t ed25519 -C "racing-vps-deploy" -f /root/.ssh/racing_deploy -N ""
cat /root/.ssh/racing_deploy.pub          # ezt a sort másold ki

# 2) a github.com kulcsának elfogadása előre, hogy a klónozás ne kérdezzen
ssh-keyscan -t rsa,ed25519 github.com >> /root/.ssh/known_hosts

# 3) a git ehhez a kulcshoz nyúljon a github.com-nál
cat > /root/.ssh/config <<'CFG'
Host github.com
    HostName github.com
    User git
    IdentityFile /root/.ssh/racing_deploy
    IdentitiesOnly yes
CFG
chmod 600 /root/.ssh/config
```

A kimásolt `ssh-ed25519 AAAA...` sort a GitHubon:
**repo → Settings → Deploy keys → Add deploy key** — illeszd be, az *Allow write
access* pipát **hagyd üresen** (a VPS-nek nem kell írnia).

```bash
# 4) klónozás SSH-val
git clone git@github.com:szabolevi98/racing.git /opt/racing
cd /opt/racing && npm ci --omit=dev
```

A klónozás a **pálya-metaadatokat magával hozza** (`zonemap.png`, `spawn.json`,
`gates.json`, kocsi-JSON-ok) — csak a nagy binárisok hiányoznak utána.

Az assetek a **te gépedről** mennek fel (5,0 GB, egyszeri). Git Bashból, a
62222-es porton:

```bash
rsync -avP -e "ssh -p 62222" /d/xampp/htdocs/racing/web/assets/ \
  root@169.58.43.205:/opt/racing/web/assets/
```

A Git Bashban **nincs `rsync`**, ezért ott `scp` kell (`-P 62222`, nagy P-vel).
Az `scp` viszont nem folytatható, ha megszakad, ami 5 GB-nál nem mindegy —
Windowsra a WinSCP a jobb választás.

> **Érdemes a minimál készlettel kezdeni**, nem az 5 GB-tal: egy pálya + egy
> égbolt + egy kocsi (~125 MB) elég ahhoz, hogy a teljes lánc ellenőrizhető
> legyen, a maradék pedig utána mehet fel, miközben a játék már él.

Két csapda, amibe élesben bele is futottunk:

- Az **égbolt-mappák nincsenek a gitben** (nincs bennük metaadat), ezért az
  `scp` „dest open ... Failure"-rel elhasal. Előbb `mkdir -p
  /opt/racing/web/assets/skybox/<id>`.
- Az asset-manifestet a szerver **cache-eli** (`server/assets.js`). Új asset
  feltöltése után `systemctl restart racing`, különben nem jelenik meg.

Feltöltés után a jogosultságokat is rendezni kell, hogy a `racing` user olvassa:

```bash
chmod -R a+rX /opt/racing
```

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

Élesen ezek a sorok a lényeg:

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
certbot --apache -d racing.levente.net --redirect \
  --non-interactive --agree-tos --no-eff-email
```

Ez **csak ezt az egy hostot** érinti: legyártja a tanúsítványt, létrehoz egy
`*:443`-as VirtualHostot (`racing.levente.net-le-ssl.conf`), beállítja a
http → https átirányítást és az automatikus megújítást.

Utána a 443-as blokkba **kézzel kell** beírni a proxy-szabályokat: a certbot a
`:80`-as vhostot másolja át, amiben csak a DocumentRoot volt. A
`racing.levente.net-le-ssl.conf`-ban a `SSLCertificateFile` sorok ELÉ:

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

Ezek élesben lefutottak, a jobb oldali érték a mért eredmény.

| Mit | Parancs | Eredmény |
|---|---|---|
| Főoldal | `curl -I https://racing.levente.net/` | 200, 8320 byte |
| Átirányítás | `curl -I http://racing.levente.net/` | 301 → https |
| Tanúsítvány | `openssl s_client -connect racing.levente.net:443` | Let's Encrypt, 2026-11-02 |
| **WebSocket** | Upgrade-fejlécekkel a `/ws`-re | **101 Switching Protocols** |
| Manifest | `curl https://racing.levente.net/api/assets` | 200, mindhárom asset-típus |
| Nagy `.glb` | `curl -r 0-99 .../bugatti....glb` | 206, `model/gltf-binary` |
| `collision.bin` | `curl .../collision.bin` | 200, 5 150 708 byte |
| Cache | `curl -I .../2004_ferrari_f2004.glb` | `immutable`, 1 év, `Content-Length` megvan |
| **A 6 másik oldal** | mindegyikre `curl -I` | változatlan (200/302/200/200/301/301) |

A **101 Switching Protocols** a legfontosabb sor: ez bizonyítja, hogy a
`proxy_wstunnel` és a `/ws` szabály sorrendje jó, tehát a többjátékos működik.
A `Content-Length` jelenléte szintén nem mellékes: ebből számol a betöltő sáv
százalékot (ha a fájl gzip-elve, chunked módon menne, a % nem működne).

Böngészőből még érdemes: a menü betölt, a legördülők tele vannak, **Többjátékos
→ Csatlakozás a szerverhez**, szoba, verseny két böngészőből.

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
