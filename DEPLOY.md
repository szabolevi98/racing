# Éles kiszolgálás

Hogyan kerül a játék egy bérelt Linux gépre (VPS), hogy a te géped nélkül,
magától fusson, saját domainen, HTTPS-sel.

> **Ez terv, nem kipróbált recept.** Egyik lépés sincs élesben végigjátszva —
> amikor sorra kerül, várható, hogy apróságokon igazítani kell.

## Miért kell egyáltalán

Most: `npm start` egy terminálban, a te Windows gépeden. A játék leáll, ha
bezárod a terminált, kijelentkezel, újraindul a gép, vagy a Node elszáll egy
hibán. És minden letöltés a te otthoni feltöltési sávszélességeden megy át.

Ehhez két dolog kell a szerveren, és egyik sem a játék kódja:

- **systemd unit** — a Linux szolgáltatás-felügyelője. Egy ~15 soros fájl leírja,
  hogyan kell indítani az appot. Cserébe elindul bootoláskor, újraindul
  összeomlás után, a `console.log`-ok egy naplóba mennek (`journalctl`), és nem
  rootként fut.
- **Reverse proxy (Apache)** — a Node elé ülő webszerver, ami a HTTPS-t intézi.

```
böngésző ──https://racing.pelda.hu──> [Apache :443] ──http://127.0.0.1:3000──> Node
              TLS, tanúsítvány                          belső, titkosítás nélkül
```

A Node marad sima HTTP-n a localhoston: nem kell tanúsítványt kezelnie, és nem
kell rootként futnia ahhoz, hogy a 443-as portot használhassa.

## Előfeltételek

- VPS Ubuntu/Debian rendszerrel, **Node 20+** (a `package.json` ezt kéri)
- Domain név, és egy A rekord, ami a VPS IP-jére mutat
- ~4 GB szabad lemez (a kód elenyésző, az assetek 2,9 GB)

## 1. A kód és az assetek felvitele

Ez két külön menet, mert a nagy binárisok **nincsenek** a gitben (`.gitignore`:
`*.glb`, `*.hdr`, `*.bin`, textúrák). A gitben csak a kód és a kézzel készített,
pótolhatatlan adat van (`zonemap.png`, `spawn.json`, `gates.json`).

```bash
# a kódot gitből
git clone git@github.com:szabolevi98/racing.git /opt/racing
cd /opt/racing && npm ci --omit=dev

# a modelleket külön, a saját gépedről (~2,9 GB, egyszeri)
rsync -avP web/assets/ racing@szerver:/opt/racing/web/assets/
```

Az `rsync` folytatható, ha megszakad — 2,9 GB-nál ez nem mindegy.

## 2. `.env` élesre

```bash
cp .env.example .env
```

Aztán **feltétlenül**:

```ini
ALLOW_DEV_WRITES=0
```

> ⚠️ Ez alapból **BE van kapcsolva**: a kód `process.env.ALLOW_DEV_WRITES !== '0'`
> (`server/index.js:17`), tehát ha elfelejted beállítani, a dev mentések élnek.
> Ezek jogosultság-ellenőrzés nélkül írnak lemezre — bárki felülírhatná a
> zónatérképeket és az ütközési hálókat.

A `DB_*` mezők akkor kellenek, ha van MariaDB a gépen. Ha nincs, a játék attól
még megy, csak az eredmények nem őrződnek meg.

## 3. systemd unit

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
sudo chown -R racing:racing /opt/racing
sudo systemctl daemon-reload
sudo systemctl enable --now racing
journalctl -u racing -f          # így látod a naplót
```

## 4. Apache reverse proxy

Három modul kell, ebből a harmadik a lényeg:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel ssl
```

A `proxy_wstunnel` engedi át a WebSocketet. **Enélkül az oldal betöltődik, de a
*Többjátékos* gomb csendben nem csinál semmit.**

`/etc/apache2/sites-available/racing.conf`:

```apache
<VirtualHost *:443>
    ServerName racing.pelda.hu

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/racing.pelda.hu/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/racing.pelda.hu/privkey.pem

    # FIGYELEM: a /ws-nek a "/" ELŐTT kell állnia
    ProxyPass        /ws  ws://127.0.0.1:3000/ws
    ProxyPassReverse /ws  ws://127.0.0.1:3000/ws

    ProxyPass        /    http://127.0.0.1:3000/
    ProxyPassReverse /    http://127.0.0.1:3000/
    ProxyPreserveHost On

    # Az alapértelmezett 300 s elvághatja a lobbyban tétlenül ülő játékost
    ProxyTimeout 3600
</VirtualHost>
```

A `/ws` a kliens tényleges útvonala (`web/mp.js:113`).

Az Apache **felülről lefelé** nézi a `ProxyPass` szabályokat, és az elsőt
használja, ami illeszkedik. Ha a `/` kerül előre, minden WebSocket kérés is oda
megy sima HTTP-ként — ez a leggyakoribb hiba ennél a felállásnál.

Az egészet **a Node-nak adjuk tovább**, az Apache nem szolgál ki statikus
fájlt közvetlenül. Így megmarad a Node-ba épített cache-kezelés (a régi
`.htaccess` szabályok, amiket az 5e2f4fb commit írt át Node-ra) — nem kell két
helyen karbantartani ugyanazt.

## 5. Tanúsítvány

```bash
sudo certbot --apache -d racing.pelda.hu
```

Ez magától beírja a fenti `SSL*` sorokat, és beállítja az automatikus
megújítást is.

## Ellenőrzés

1. `curl -I https://racing.pelda.hu/` → 200, és HTTPS-en jön
2. A menü betölt, a pálya és a kocsi legördülő tele van
3. **Többjátékos → Csatlakozás a szerverhez** → ha ez működik, a `wss://` átmegy
   a proxyn (ez az a lépés, ami `proxy_wstunnel` nélkül elhal)
4. Szoba létrehozása, verseny indítása
5. `sudo systemctl restart racing` → a játék pár másodperc múlva újra elérhető

## Nyitott kérdés a kódban

`server/index.js:115` — `server.listen(PORT)` **minden interfészen** figyel.
A VPS-en ez azt jelenti, hogy a 3000-es port kívülről is elérhető lenne,
megkerülve a proxyt és vele a HTTPS-t. Két megoldás:

- tűzfal: `sudo ufw deny 3000` (semmit nem kell átírni), **vagy**
- `server.listen(PORT, '127.0.0.1')`, hogy csak a proxy érje el

A második a tisztább, de kódváltoztatás, és megtörné a mostani „elég a 3000-es
portot kiengedni" otthoni használatot — ezért kell hozzá egy `HOST` env változó,
alapértelmezetten a jelenlegi viselkedéssel.

## Amivel számolni kell

Az **első** betöltés minden új játékosnál nagy: egy pálya 63–148 MB, plusz a
kocsi. A nagy fájlok egy éves cache-t kapnak, tehát a második indulás azonnali,
de a sávszélesség-számlát az elsők adják. Az assetek zsugorítása (Draco
geometria, KTX2 textúrák) egyelőre szándékosan kimarad.
