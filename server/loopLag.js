// Az eseményhurok akadásainak könyvelése.
//
// A szerver néha hosszú, ÖSSZEFÜGGŐ munkát végez: verseny indításakor felépíti
// az ütközési hálót (mérve: 42–462 ms pályától függően), dekódolja a
// zóna-PNG-t, és 120 fizikai lépéssel leülteti a rajtrácsot. Amíg ez fut,
// egyetlen beérkező üzenet sem kerül feldolgozásra — a PING is sorban áll, és
// a válasz csak a munka végén indul el.
//
// A kliens ezt nem tudja megkülönböztetni a hálózattól: ő csak azt látja, hogy
// a válasz fél másodperccel később ért vissza. Innen a "több száz milliszekundumos
// ping" a rajtnál. A kliens saját főszál-figyelője (web/mp.js) erre vak, mert
// az ő szála közben szabad lehet.
//
// Ezért itt MÉRJÜK a saját akadásainkat, és a PING válaszába beletesszük,
// mennyi gyűlt össze az adott kapcsolat előző válasza óta. A kliens az ilyen
// mintát eldobja — nem a hálózatról szól.
//
// Miért egy sűrű időzítő, és miért megbízható itt? A Node eseményhurka fázisos:
// egy hosszú blokk után a TIMERS fázis fut le előbb, és csak utána a POLL, ahol
// a közben beérkezett socket-üzenetek sorra kerülnek. Az ütés tehát biztosan a
// PING feldolgozása ELŐTT észleli a kiesést — böngészőben ez a sorrend nem
// garantált, a szerveren igen.

const TICK_MS = 100;
// A játékszimuláció ~60 Hz-en tickel, tehát a hurok normálisan is dolgozik.
// Csak azt tekintjük akadásnak, ami ezen érdemben túlmutat.
const LAG_THRESHOLD_MS = 50;

// Mennyi ideig számít "épp az imént véget ért" egy akadás. A blokk alatt
// beérkezett üzenetek mind EGYETLEN poll-fázisban kerülnek sorra, tehát
// ezredmásodpercekre egymástól — ennél jóval bőkezűbb ablak is elég.
const RECENT_WINDOW_MS = 150;

let lastBlockMs = 0;
let lastBlockEndedAt = -Infinity;
let lastTickAt = performance.now();

// Az akadást nem naplózzuk. Ez a modul épp arról szól, hogy a kiesés VÁRT és
// KEZELT: amikor észleljük, a rendszer rendeltetésszerűen működik, tehát nincs
// mit bejelenteni. A fejlesztés közbeni kiírás mérve a napló 43%-át adta
// (225 sor 529-ből egy nap alatt, valódi forgalom nélkül), és ezzel épp azt
// nehezítette, amiért naplót olvas az ember. Ha később mégis kell nyom, olyat
// érdemes, ami hordoz is információt: csak a szokatlanul nagy akadást, vagy
// napi összegzést.
const timer = setInterval(() => {
  const now = performance.now();
  const lag = now - lastTickAt - TICK_MS;
  lastTickAt = now;
  if (lag <= LAG_THRESHOLD_MS) return;
  lastBlockMs = lag;
  lastBlockEndedAt = now;
}, TICK_MS);
// Ne tartsa életben a folyamatot: ez csak megfigyelés.
timer.unref();

// Mekkora akadás ért véget közvetlenül az imént? Nulla, ha rég volt.
//
// Szándékosan NEM kapcsolatonkénti "előző válasz óta" különbség: egy hosszú
// blokk alatt több PING is felgyűlik, és azt a különbséget az első elfogyasztaná
// — a mögötte állók nulla akadással, de ugyanúgy felfújt körút-idővel mennének
// tovább (mérve: 793 ms után 684, 576, 465…). Így viszont a blokk után egyszerre
// kiszolgált MINDEGYIK megkapja a jelzést.
export function recentBlockMs() {
  return performance.now() - lastBlockEndedAt <= RECENT_WINDOW_MS ? Math.round(lastBlockMs) : 0;
}
