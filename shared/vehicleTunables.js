// A menetdinamika HANGOLHATÓ értékei — külön fájlban, csak a számok, semmi
// logika. A dev autó-tesztelő "Mentés fájlba" gombja ugyanebben a
// formátumban generál egy letölthető fájlt: ha egy hangolás jó lett, ezt a
// fájlt kell felülírni a projektben (git commit + push + a szerver
// újraindítása után), és minden — a szerver ÉS minden kliens — rögtön az új
// értékekkel indul.
//
// Ez a fájl NEM importál semmit, és NEM tartalmaz függvényt — szándékosan,
// hogy a dev-panel generált tartalma (és a saját maga) mindig egyszerű,
// egyenes export-lista maradjon, elgépelés vagy körkörös import veszélye
// nélkül.

export const MAX_ENGINE_FORCE = 1100;
export const REVERSE_FACTOR = 0.6;
export const MAX_STEER = 0.38;
// Fékerő (Rapier wheelBrake impulzus) kerekenként, első/hátsó bontásban.
// Az arány az elosztás: 27/23 = 54% elöl, ahogy egy valódi versenyautó
// fékegyensúlya is előre tolt (fékezéskor a súly előre terhelődik).
//
// A számok MÉRT lassulásra vannak hangolva, nem érzésre — 200 km/h-ról állóig:
//   24/20 → 2.48 s, 67 m, 2.28 G
//   27/23 → 2.20 s, 59 m, 2.58 G   ← ez van beállítva (valós F1: 2.2 s, 62 m, 2.6 G)
//   32/27 → 1.88 s, 51 m, 3.01 G
//   45/38 → 1.37 s, 37 m, 4.15 G
//   70/60 → 1.02 s, 28 m, 5.58 G   (a korábbi érték: irreálisan erős)
// Fölfelé NEM éri meg tovább emelni: ~50 fölött a kerék blokkol, a csúszó gumi
// pedig KEVESEBB erőt visz át, mint egy éppen még guruló — 100/86-nál a fékút
// már megint hosszabb (1.48 s). Pont ezért nem változott semmi, amikor a
// fékerőt 70-ről 120-ra emeltük.
export const BRAKE_FRONT = 27;
export const BRAKE_REAR = 23;

// Kézifék: CSAK a hátsó kerékre. Szándékosan GYENGE lassításnak — a mérés
// szerint a két paraméter függetlenül hat, és pont ezt használjuk ki:
//   HANDBRAKE_FORCE  → mennyit lassít (200 km/h-ról: 55 → 2.0 s, 35 → 3.1 s,
//                      22 → 4.7 s, 14 → 6.9 s), a pörgésre nincs hatása
//   HANDBRAKE_REAR_SLIP → mennyire tör ki a hátulja (~310°/s), a lassításra
//                      nincs hatása
// Ezért az erő alacsony (a sima fék 1.9 s-ához képest 4.7 s — vagyis megállni
// vele értelmetlen), a tapadás viszont alacsony marad, hogy a kocsi rendesen
// elforduljon. Így a kézifék nem "második fék", hanem külön eszköz: szűk
// kanyarban az orr behelyezésére és driftre.
export const HANDBRAKE_FORCE = 22;
export const HANDBRAKE_REAR_SLIP = 1.1;
export const FRONT_FRICTION_SLIP = 3;
export const REAR_FRICTION_SLIP = 2.9;
export const SUSPENSION_STIFFNESS = 30;
export const SUSPENSION_COMPRESSION = 4.4;
export const SUSPENSION_RELAXATION = 2.3;
export const SUSPENSION_MAX_TRAVEL = 0.3;
export const LINEAR_DAMPING = 0.05;
export const ANGULAR_DAMPING = 0.5;
