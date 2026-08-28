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
| Tanúsítvány | Let's Encrypt, automatikus megújítással (`certbot certificates`) |
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
- **A `wss://` a kódban megoldott.** Nincs vele semmi teendő: a kliens a
  `web/mp.js`-ben magától dönt,
  `location.protocol === 'https:' ? 'wss' : 'ws'` alapján.
  Amint HTTPS-en szolgálod ki az oldalt, a WebSocket is titkosítva megy.
- **Nincs kliens-build-lépés.** A kliens nyers ES-modulokat használ, tehát amit
  felviszel, az fut. A további npm scriptek (`test`, `cars:optimize`,
  `cars:compress`, `cars:wheels`) teszteléshez és offline autófeldolgozáshoz
  vannak, nem szükségesek a szerver indulásához.

## Mi az a reverse proxy — röviden

Az Apache már fut a gépen, és ő birtokolja a 80/443-as portot. A játék egy Node
folyamat, ami a 3000-esen figyel. Apache maga adja a statikus fájlokat, és csak
az `/api/` és `/ws` kéréseket továbbítja Node-nak:

```
böngésző ──https──> [Apache :443] ── web/shared fájlok
                           └─────── /api és /ws ──> [Node :3000]
```

Így a Node-nak nem kell tanúsítványt vagy nagy fájltranszfereket kezelnie, és
nem kell rootként futnia ahhoz, hogy a 443-as porton legyen elérhető. A
`levente.net` ettől függetlenül megy tovább a saját VirtualHostjában — külön
fájl, külön `ServerName`, nem érnek egymáshoz.

Ehhez kell még egy **systemd unit**: az a ~15 soros fájl írja le, hogyan induljon
a Node folyamat. Cserébe elindul bootoláskor, újraindul összeomlás után, a
`console.log`-ok naplóba mennek (`journalctl`), és nem rootként fut.

## Előfeltételek

- legalább ~6 GB szabad lemez a publikus assetekhez. A jelenlegi készlet kb.
  **5,6 GB** (autók 4,1 GB, pályák 1,4 GB, égboltok 131 MB). A nem publikus
  `masters/cars/` további kb. 2,1 GB, de az éles játék futásához nem szükséges;
  csak akkor kell a VPS-re, ha ott is akarsz autómodelleket újragenerálni. A
  helyi, kb. 2,6 GB-os `masters/maps/` pályaforrások szintén nem publikusak és
  nem szükségesek az éles játékhoz.
- **Node 20+** — az éles gépen jelenleg Node 22 fut.

## 1. Node telepítése

Az Ubuntu saját csomagja túl régi lehet, ezért a NodeSource tárolóból:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # v22.x kell, minimum v20
```

## 2. A kód és az assetek felvitele

Ez két külön menet, mert a nagy binárisok **nincsenek** a gitben (`.gitignore`:
`*.glb`, `*.gltf`, `*.hdr`, `*.exr`, `*.bin`, pályatextúrák). A gitben a kód és
a kézzel készített, pótolhatatlan metaadat marad.

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

A klónozás a **pálya-metaadatokat magával hozza** (`zonemap.png/json`,
`spawn.json`, `hotlap_spawn.json`, `gates.json`, `pit.json`, `bake.json`, valamint
a kocsi-JSON-ok) — csak a gitignore-os nagy binárisok hiányoznak utána.

Az assetek a **te gépedről** mennek fel (jelenleg kb. 4,7 GB, első telepítéskor
egyszeri művelet). Ha van telepített `rsync`, a 62222-es porton:

```bash
rsync -avP -e "ssh -p 62222 -i ~/.ssh/levente" /d/xampp/htdocs/racing/web/assets/ \
  root@169.58.43.205:/opt/racing/web/assets/
```

A jelenlegi Windows/Git Bash környezetben **nincs `rsync`**, ezért ott `scp`
kell (`-P 62222`, nagy P-vel), és a működő klienskulcsot explicit meg kell adni:

```bash
scp -P 62222 -i ~/.ssh/levente <helyi-fájlok> \
  root@169.58.43.205:/opt/racing/web/assets/<célmappa>/
```

Az `scp` nem folytatható, ha megszakad, ami több GB-nál nem mindegy; teljes első
feltöltéshez a WinSCP kényelmesebb. Egy új pályánál vagy autónál viszont általában
csak néhány konkrét fájlt kell másolni.

> **Érdemes a minimál készlettel kezdeni**, nem a teljes csomaggal: egy pálya + egy
> égbolt + egy kocsi (~125 MB) elég ahhoz, hogy a teljes lánc ellenőrizhető
> legyen, a maradék pedig utána mehet fel, miközben a játék már él.

Két csapda, amibe élesben bele is futottunk:

- Az **égbolt-mappák nincsenek a gitben** (nincs bennük metaadat), ezért az
  `scp` „dest open ... Failure"-rel elhasal. Előbb `mkdir -p
  /opt/racing/web/assets/skybox/<id>`.
- Az asset-manifestet a szerver **cache-eli** (`server/assets.js`). Új vagy
  módosított asset feltöltése után `systemctl restart racing`, különben az új
  fájl, méret és tartalomverzió nem jelenik meg.
- Új pályánál a `<pálya-id>.glb` mellett a `collision.bin` fájlt is fel kell
  tölteni. A pálya GLB-je előtte a helyi `npm run maps:optimize -- <pálya-id>`
  paranccsal készüljön el; a `masters/maps/` eredetijét ne töltsd a webrootba.
  Új autónál a játékosmodell mellett a
  `web/assets/cars/compressed/<autó-id>.glb` remote/ghost változat se maradjon ki.

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
> lemezre, tehát bárki felülírhatná a rajtpontokat, kapukat, boxutcát,
> zónatérképet, ütközési hálót és sütési beállításokat.

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
Environment="NODE_OPTIONS=--max-old-space-size=512 --max-semi-space-size=32"
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Nice=-5
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
# a rootként futtatott `git pull` sem ütközik a git "dubious ownership"
# védelmébe (az akkor
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

Az éles unit követett mintája: `deploy/systemd/racing.service`. A nagyobb V8
fiatal generáció ritkítja a rövid életű hálózati objektumok minor GC-jét, a
`Nice=-5` pedig a VPS más folyamataival szemben ad mérsékelt CPU-prioritást.

## 6. Apache statikus kiszolgálás és reverse proxy

Az Apache közvetlenül adja a nagy asseteket; csak az API és a WebSocket megy
Node-hoz. Ehhez ezek a modulok kellenek:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel ssl rewrite headers deflate
```

A `proxy_wstunnel` engedi át a WebSocketet. **Enélkül az oldal betöltődik, de a
*Többjátékos* gomb csendben nem csinál semmit.**

Új, **külön** fájl — a `levente.net` konfigját nem nyitjuk meg:
`/etc/apache2/sites-available/racing.levente.net.conf`

```apache
<VirtualHost *:80>
    ServerName racing.levente.net
    # A certbot ezt fogja átírni https-átirányításra.
    DocumentRoot /var/www/racing-acme
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

Utána a certbot által létrehozott 443-as fájlt cseréld a repóban követett
`deploy/apache/racing.levente.net-le-ssl.conf` tartalmára. A lényegi rész:

```apache
    DocumentRoot /opt/racing/web
    Alias /shared/ /opt/racing/shared/

    <Directory /opt/racing/web>
        Options -Indexes
        AllowOverride None
        Require all granted
    </Directory>
    <Directory /opt/racing/shared>
        Options -Indexes
        AllowOverride None
        Require all granted
    </Directory>

    ProxyPass        /ws  ws://127.0.0.1:3000/ws
    ProxyPassReverse /ws  ws://127.0.0.1:3000/ws
    ProxyPass        /api/  http://127.0.0.1:3000/api/
    ProxyPassReverse /api/  http://127.0.0.1:3000/api/
    ProxyPreserveHost On

    # Az alapértelmezett 300 s elvághatja a lobbyban tétlenül ülő játékost
    ProxyTimeout 3600
```

A `/ws` a kliens tényleges útvonala (`web/mp.js`).

A gyökérre nincs `ProxyPass`: a `web/` és az Alias alatti `shared/` fájlokat
Apache szolgálja ki. A teljes minta a Node-dal azonos cache-fejléceket, MIME
típusokat és a `/dev -> index.html` átírást is tartalmazza. A Node statikus
kiszolgálója megmarad a `localhost:3000` fejlesztői használathoz.

## Ellenőrzés

Ezeket élesítés után érdemes lefuttatni. A jobb oldali oszlop a helyes eredmény
típusát mutatja; a fájlméreteket ne égesd be, mert minden assetfrissítésnél
változhatnak.

| Mit | Parancs | Eredmény |
|---|---|---|
| Főoldal | `curl -I https://racing.levente.net/` | 200 |
| Átirányítás | `curl -I http://racing.levente.net/` | 301 → https |
| Tanúsítvány | `certbot certificates` | érvényes, automatikus megújítás bekapcsolva |
| **WebSocket** | Upgrade-fejlécekkel a `/ws`-re | **101 Switching Protocols** |
| Manifest | `curl https://racing.levente.net/api/assets` | 200, mindhárom asset-típus |
| Nagy `.glb` | `curl -r 0-99 <asset-url>` | 206, `model/gltf-binary` |
| `collision.bin` | `curl -I <collision-url>` | 200, helyes `Content-Length` |
| Cache | `curl -I .../2004_ferrari_f2004.glb` | `immutable`, 1 év, `Content-Length` megvan |
| **A 6 másik oldal** | mindegyikre `curl -I` | az élesítés előtti válaszkódok változatlanok |

A **101 Switching Protocols** a legfontosabb sor: ez bizonyítja, hogy a
`proxy_wstunnel` és a `/ws` szabály sorrendje jó, tehát a többjátékos működik.
A `Content-Length` jelenléte szintén nem mellékes: ebből számol a betöltő sáv
százalékot (ha a fájl gzip-elve, chunked módon menne, a % nem működne).

Böngészőből még érdemes: a menü betölt, a legördülők tele vannak, **Többjátékos
→ Csatlakozás a szerverhez**, szoba, verseny két böngészőből.

## Ha valami nem megy

- **A menü se jön be:** az Apache vhost és a fájljogosultság a kérdés:
  `apache2ctl configtest`, `tail -n 50 /var/log/apache2/racing-error.log`,
  `namei -l /opt/racing/web/index.html`.
- **A menü megy, de az API nem:** `systemctl status racing`,
  `journalctl -u racing -n 50`, majd `curl http://127.0.0.1:3000/api/status`.
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

Az **első** betöltés minden új játékosnál nagy: egy pálya jelenleg nagyjából
60–150 MB, plusz a saját autó. A saját játékosmodell legfeljebb 15 MB, a
multiplayer-ellenfelek és az időmérő szellem optimalizált modellje legfeljebb
5 MB. A nagy fájlok tartalomverziózott, egyéves cache-t kapnak, ezért a következő
betöltés lényegesen gyorsabb. A pályamodellek további Draco/KTX2 zsugorítása
egyelőre szándékosan kimarad.

## Rendszeres frissítés

### Csak Gitben követett fájlok változtak

A helyi gépről használt működő SSH-kulcsot explicit meg kell adni; az
alapértelmezett kulcs nem működik:

```bash
ssh -p 62222 -i ~/.ssh/levente root@169.58.43.205 \
  'cd /opt/racing && git pull --ff-only && systemctl restart racing && systemctl is-active racing'
```

Ha a `package.json` vagy `package-lock.json` is változott, a restart előtt:

```bash
ssh -p 62222 -i ~/.ssh/levente root@169.58.43.205 \
  'cd /opt/racing && npm ci --omit=dev'
```

A VPS a GitHubhoz a saját `/root/.ssh/racing_deploy` read-only deploy key-jét
használja. Ez nem ugyanaz, mint a helyi gépről a VPS-hez használt
`~/.ssh/levente` kulcs.

### Új vagy módosított nagy asset is van

A `git pull` nem viszi fel a gitignore-os GLB, BIN, HDR, EXR és pályatextúra
fájlokat. Előbb hozd létre a célmappát, majd töltsd fel a konkrét fájlokat:

```bash
ssh -p 62222 -i ~/.ssh/levente root@169.58.43.205 \
  'mkdir -p /opt/racing/web/assets/maps/<pálya-id>'

scp -P 62222 -i ~/.ssh/levente \
  web/assets/maps/<pálya-id>/<pálya-id>.glb \
  web/assets/maps/<pálya-id>/collision.bin \
  root@169.58.43.205:/opt/racing/web/assets/maps/<pálya-id>/
```

Pályánál csak a generált `web/assets/maps/...` GLB és a `collision.bin` megy
élesbe; a `masters/maps/` helyi szerkesztési forrás. Autónál a játékosmodell és a
`compressed/` remote modell is szükséges.
Feltöltés után érdemes SHA-256-tal vagy legalább fájlmérettel összehasonlítani a
helyi és távoli példányt. Ezután jöhet a fenti `git pull --ff-only` és restart.

### Élesítés utáni gyors ellenőrzés

```bash
curl -I https://racing.levente.net/
curl https://racing.levente.net/api/status
curl https://racing.levente.net/api/assets
```

A főoldalnak és az API-státusznak 200-at kell adnia, a manifestben pedig
szerepelnie kell az új pályának vagy autónak a helyes fájlmérettel. A közvetlen
asset URL-t is ellenőrizd, ne csak a sikeres `git pull` kimenetére hagyatkozz.
