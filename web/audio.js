// Hangok. Jelenleg a rajt-visszaszámlálás; a motorhang ide fog épülni.
//
// Miért nincs hangfájl a visszaszámláláshoz: egy bip az egyetlen oszcillátor
// plusz egy hangerő-burkoló. Fájlból ugyanez letöltést, licencet és
// cache-kezelést hozna magával (a .mp3/.ogg egy évre "immutable" cache-t kap a
// static.js-ben, tehát egy azonos nevű csere némán a régit adná vissza a
// játékosoknak) — mindezt néhány száz millisecundnyi szinuszért. A motorhanghoz
// viszont majd KELL felvétel: azt nem lehet meggyőzően szintetizálni.

// A böngészők tiltják a hanglejátszást felhasználói gesztus előtt, és egy
// gesztus ELŐTT létrehozott AudioContext "suspended" állapotban ragad. Ezért
// nem a modul betöltésekor hozzuk létre, hanem az első tényleges hangnál —
// addigra a játékos már kattintott (legkésőbb az "Egyjátékos" gombra).
let ctx = null;
// Minden hang ezen megy át: egy helyen lehet némítani és hangerőt állítani.
let master = null;

let muted = false;
let volume = 1;

function ensureContext() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;          // nagyon régi böngésző: némán hang nélkül megy
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    // Biztonsági limiter a kimeneten. A motorhang hét harmonikusa és a
    // zajréteg ÖSSZEADÓDIK, és ha közben egy visszaszámláló bip is megszólal,
    // a csúcs kimehet 1.0 fölé — ott a hangkártya vágná, ami reccsen. Magas
    // küszöb és nagy arány: normál szinten nem szól bele, csak a csúcsokat
    // fogja meg.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
  }
  // Akkor is kellhet, ha a lap háttérbe került és a böngésző felfüggesztette.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Egy rövid, lecsengő hang. A burkoló nem elhagyható: egy oszcillátor puszta
// be- és kikapcsolása pattanást ad (a hullámforma ugrik nulláról), ami
// hangosabb és csúnyább, mint maga a bip.
function tone({ freq, durationMs, gain = 0.25, type = 'sine' }) {
  const c = ensureContext();
  if (!c || muted) return;

  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;

  const now = c.currentTime;
  const dur = durationMs / 1000;
  const attack = 0.008;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + attack);
  // Exponenciális lecsengés — a fül így hallja egyenletesnek. Nullára nem lehet
  // exponenciálisan menni, ezért egy nagyon kis értékre megyünk, és ott vágjuk.
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.connect(env);
  env.connect(master);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// A rajtprocedúra hangjai. A visszaszámláló bipek mélyek és rövidek, a rajté
// magasabb és hosszabb — a hangmagasság-ugrás az, amitől félrehallás nélkül
// tudod, hogy MOST indulhatsz, anélkül hogy a képernyő közepére kellene nézni.
export function countdownBeep() {
  tone({ freq: 620, durationMs: 140, gain: 0.22 });
}

export function startBeep() {
  tone({ freq: 1050, durationMs: 550, gain: 0.28 });
}

// ---------------------------------------------------------------------------
// Motorhang
// ---------------------------------------------------------------------------
// Szintetizált, nem hangmintából. Egy V10 hangját ez esetben pontosabban adja
// vissza az összerakás, mint egy loopolt felvétel: a hang jellegét a
// GYÚJTÁSFREKVENCIA és a felharmonikusai adják, nem szélessávú zaj. Egy
// felvételt ráadásul hangmagasság-húzással kellene a fordulathoz igazítani,
// ami a szélek felé óhatatlanul elvékonyodik vagy elmélyül.
//
// Gyújtásfrekvencia egy négyütemű V10-nél: fordulat/60 × (henger/2), tehát a
// 18 750-es maximumon ~1560 Hz. Ez maga az "F1-sikoly".
const HENGER = 10;
const IDLE_RPM = 3500;
const MAX_RPM = 18750;
// A motorhang FELSŐ hangereje (maximális fordulaton, teljes gázon). Alapjáraton
// ennek töredékén szól — a skálázást az updateEngine végzi, lásd ott.
const ENGINE_VOLUME = 0.22;

// A harmonikus-sorozat a hang karaktere. Az 1× a gyújtás alapfrekvenciája, ez
// alatt a főtengely rendjei (0.5×, 0.25×) adják a testet, fölötte a felhangok.
//
// A SÚLYOZÁS erősen a mély rendek felé húz, és ez szándékos. Egy V10 gyújtása
// 18 750-en tényleg ~1560 Hz — de egy valódi F1-felvételben ez a sikoly egy
// vastag, mély alapon ÜL. Ha az 1× a leghangosabb (ez volt az első verzió),
// a hang nagy sebességnél élesen magasba megy, ami nem így szól élőben.
// A felső rendek (4×, 5×) 6-8 kHz-en szólnának a maximumon: azok csak
// csipognak, ezért nagyon halkak.
const HARMONICS = [
  { mul: 0.25, gain: 0.42 },
  { mul: 0.5,  gain: 0.62 },
  { mul: 1.0,  gain: 0.80 },
  { mul: 1.5,  gain: 0.14 },
  { mul: 2.0,  gain: 0.26 },
  { mul: 3.0,  gain: 0.10 },
  { mul: 4.0,  gain: 0.04 },
];

// ---- Szimulált váltó, KIZÁRÓLAG a hangnak ----
// A fizikában nincs se fordulatszám, se fokozat: a Rapier jármű-vezérlő
// motorerőt ismer. Ha a hangmagasságot közvetlenül a sebességhez kötnénk, egy
// végtelenül emelkedő sivítást kapnánk 0-tól 378 km/h-ig — pont ettől hangzik
// amatőrnek a legtöbb házi autós hang. Egy valódi motor fordulata felfut, majd
// váltáskor visszaesik, és ez a ciklikusság adja a karaktert.
//
// Ez a réteg TISZTÁN kozmetikai: a fizikához nem nyúl, tehát a kliens-szerver
// determinizmust (és vele a multiplayert) nem érinti.
//
// Az áttételek a teljes áttételt jelentik (váltó × véghajtás). Úgy vannak
// méretezve, hogy a legfelső fokozat a 378 km/h-s sebességplafonon érje el a
// maximális fordulatot, az első pedig ~108 km/h-nál — ez F1-hez reális.
const GEAR_RATIOS = [22.9, 17.9, 14.0, 11.0, 8.35, 6.54];
const SHIFT_UP_RPM = 18000;
const SHIFT_DOWN_RPM = 12000;
// A kerék kerülete (a fizikai keréksugárból): ebből lesz a sebességből
// kerékfordulat, abból pedig az áttétellel a motorfordulat.
const WHEEL_CIRCUMFERENCE = 2 * Math.PI * 0.35;

let engine = null;     // { oscs, filter, noiseGain, gain, noiseSrc }
let gear = 0;
let smoothedRpm = IDLE_RPM;

function rpmFor(speedMs, gearIndex) {
  const wheelRpm = (Math.abs(speedMs) / WHEEL_CIRCUMFERENCE) * 60;
  return wheelRpm * GEAR_RATIOS[gearIndex];
}

// A fokozatot hiszterézissel váltjuk: a fel- és a levaltás küszöbe eltér,
// különben a határon állandó sebességgel haladva oda-vissza kapkodna.
function pickGear(speedMs) {
  while (gear < GEAR_RATIOS.length - 1 && rpmFor(speedMs, gear) > SHIFT_UP_RPM) gear++;
  while (gear > 0 && rpmFor(speedMs, gear) < SHIFT_DOWN_RPM) gear--;
  return gear;
}

// Lassú, szabálytalan ±1 közötti jel a "morgás" modulációhoz.
//
// Miért nem szűrt fehérzaj: egy aluláteresztő a sávszélesség arányában viszi
// le az amplitúdót is, tehát a kimenet szintje nem ismert előre (14 Hz-nél
// néhány százalék marad). Így a modulációs mélységet csak találgatni lehetne.
// Itt a simítást magunk végezzük egy egypólusú szűrővel, majd NORMALIZÁLUNK —
// onnantól a hívó oldali gain közvetlenül a mélységet jelenti.
function makeRumbleBuffer(c, seconds = 4, cutoffHz = 9) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / c.sampleRate);
  let y = 0;
  let max = 0;
  for (let i = 0; i < len; i++) {
    y += a * (Math.random() * 2 - 1 - y);
    d[i] = y;
    if (Math.abs(y) > max) max = Math.abs(y);
  }
  if (max > 0) for (let i = 0; i < len; i++) d[i] /= max;

  // A puffer vége és eleje nem találkozik, és egy ugrás a hangerő- vagy
  // hangmagasság-paraméteren kattanásként hallatszana minden körbefordulásnál.
  //
  // Az utolsó szakaszt átúsztatjuk az ELEJE fölé, a hurkot pedig NEM a puffer
  // nulla pontjáról indítjuk, hanem az átúsztatott szakasz után (loopStart).
  // Így a vég az eleje folytatásává válik, és a körbefordulás folytonos. Csak
  // az átúsztatás önmagában nem lenne elég: a puffer utolsó mintája a fade
  // szakasz VÉGÉHEZ simul, nem a legelső mintához.
  const fade = Math.min(Math.floor(c.sampleRate * 0.25), Math.floor(len / 4));
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    const j = len - fade + i;
    d[j] = d[j] * (1 - w) + d[i] * w;
  }
  return { buffer: buf, loopStart: fade / c.sampleRate, loopEnd: len / c.sampleRate };
}

export function startEngine() {
  const c = ensureContext();
  if (!c || engine) return;

  const gain = c.createGain();
  gain.gain.value = 0;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.6;
  filter.connect(gain);
  gain.connect(master);

  const oscs = HARMONICS.map((h, i) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sawtooth';
    // Elhangolás: tíz henger nem szólal meg tökéletesen fázisban, és a
    // hengerenkénti apró eltérés az, amitől a hang ÉRDES. Rendenként eltérő
    // (nem szimmetrikus) érték kell: egyforma elhangolással a rendek együtt
    // mozdulnának, és pont az egymáshoz képesti lebegés maradna el, ami a
    // gépies orgonahangot motorrá teszi.
    osc.detune.value = [-11, 7, -4, 13, -8, 5, -14][i] || 0;
    g.gain.value = h.gain;
    osc.connect(g);
    g.connect(filter);
    osc.start();
    return { osc, g, def: h, flutterGain: null };
  });

  // Közös fehérzaj-puffer két célra: a szívás/kipufogás sziszegése, és a
  // lentebbi "morgás" moduláció.
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  const noiseSrc = c.createBufferSource();
  noiseSrc.buffer = buf;
  noiseSrc.loop = true;
  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  // Szélesebb sáv (kisebb Q), mint korábban: a szűk sáv maga is HANGMAGASSÁGOT
  // kapott, ami a zajréteget egy újabb zenei hanggá tette a kürtszerű
  // összképben. Szélesen inkább levegő, ami kell.
  noiseFilter.frequency.value = 1800;
  noiseFilter.Q.value = 0.25;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0;
  noiseSrc.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(gain);
  noiseSrc.start();

  // ---- "Morgás": FÜGGETLENÜL lüktető harmonikusok ----
  //
  // Az első kísérlet egy KÖZÖS burkolóval mozgatta az egész hangerőt/hangmagas-
  // ságot. Ez nem oldotta meg a kürt-jelleget: hét TARTÓSAN kitartott, tiszta
  // hangmagasságú oszcillátor együtt szólva már magában is akkord — pont ez a
  // vonatkürtök felépítése (néhány rögzített hangmagasság, tartósan, együtt).
  // Ha ezt az akkordot egy közös burkolóval mozgatjuk, az EGÉSZ lüktet együtt,
  // de az akkord-jelleg megmarad — csak ingadozó hangerővel szóló kürt lesz.
  //
  // Egy valódi motornál a hengerek gyújtása EGYMÁSHOZ KÉPEST rendszertelen:
  // hol az egyik hangosodik, hol a másik, egymástól függetlenül. Ez az, amit
  // csak külön-külön lüktető harmonikusokkal lehet elérni — ezért minden
  // rendnek SAJÁT, egymástól elcsúszott jele van, nem egy közös.
  //
  // Mind a hét saját forrást kap ugyanabból a hosszú, normalizált zajpufferből
  // (nem kell 7 külön puffert generálni), de eltérő lejátszási sebességgel és
  // kezdő-eltolással — ettől a hét jel évek alatt sem esik újra egy fázisba.
  const rumble = makeRumbleBuffer(c);
  const flutterRates = [0.83, 1.31, 0.97, 1.62, 1.14, 0.71, 1.45];
  oscs.forEach((entry, i) => {
    const src = c.createBufferSource();
    src.buffer = rumble.buffer;
    src.loop = true;
    src.loopStart = rumble.loopStart;
    src.loopEnd = rumble.loopEnd;
    src.playbackRate.value = flutterRates[i % flutterRates.length];
    const flutterGain = c.createGain();
    flutterGain.gain.value = 0;
    src.connect(flutterGain);
    flutterGain.connect(entry.g.gain);
    // Az induló pozíciót is szétszórjuk a pufferen — enélkül minden forrás a
    // 0. mintától indulna, és a különböző sebesség csak KÉSŐBB válna szét.
    src.start(c.currentTime, (i / oscs.length) * rumble.loopEnd);
    entry.flutterGain = flutterGain;
    entry.flutterSrc = src;
  });

  // Hangmagasság-billegés: ez maradhat KÖZÖS és lassú — a főtengely
  // fordulat-ingadozása minden hengerre egyszerre hat (mindegyik ugyanazon a
  // tengelyen ül), tehát ez fizikailag indokolt, nem csak egyszerűsítés.
  const wobbleSrc = c.createBufferSource();
  wobbleSrc.buffer = rumble.buffer;
  wobbleSrc.loop = true;
  wobbleSrc.loopStart = rumble.loopStart;
  wobbleSrc.loopEnd = rumble.loopEnd;
  const wobbleGain = c.createGain();
  wobbleGain.gain.value = 0;
  wobbleSrc.connect(wobbleGain);
  oscs.forEach(({ osc }) => wobbleGain.connect(osc.detune));
  wobbleSrc.start();

  engine = { oscs, filter, gain, noiseGain, noiseSrc, wobbleGain, wobbleSrc };
  gear = 0;
  smoothedRpm = IDLE_RPM;
}

export function stopEngine() {
  if (!engine) return;
  const c = ctx;
  const e = engine;
  engine = null;
  // Lecsengetve állítjuk le: egy azonnali stop kattanást ad.
  e.gain.gain.cancelScheduledValues(c.currentTime);
  e.gain.gain.setTargetAtTime(0, c.currentTime, 0.06);
  setTimeout(() => {
    try {
      e.oscs.forEach(({ osc, flutterSrc }) => { osc.stop(); flutterSrc.stop(); });
      e.noiseSrc.stop();
      e.wobbleSrc.stop();
    } catch { /* már leállt */ }
  }, 400);
}

// Képkockánként hívandó a vezetés- és a multiplayer-ágból is.
//   speedKmh: a kocsi sebessége
//   throttle: 0..1 (a gázpedál állása) — a TERHELÉST adja
export function updateEngine(speedKmh, throttle, dt = 1 / 60) {
  if (!engine || !ctx) return;
  const speedMs = Math.abs(speedKmh) / 3.6;
  const g = pickGear(speedMs);
  const target = Math.max(IDLE_RPM, Math.min(MAX_RPM, rpmFor(speedMs, g)));

  // A fordulat simítása nem szépészeti: a fokozatváltás pillanatában a
  // számított érték UGRIK (ez a lényege), de a hangmagasság-ugrást a fül
  // kattanásként hallaná. Néhány század másodperc alatt átcsúszva viszont
  // pont az igazi váltás érzetét adja.
  const k = 1 - Math.pow(0.001, Math.max(dt, 0) * 12);
  smoothedRpm += (target - smoothedRpm) * k;

  const fire = (smoothedRpm / 60) * (HENGER / 2);
  const t = ctx.currentTime;
  const load = Math.max(0, Math.min(1, throttle));

  const norm = (smoothedRpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM);

  // A lüktetés mélysége a fordulattal csökken, és alapjáraton a legnagyobb —
  // pont ott, ahol a levágás miatt semmi más nem mozdul. Nagy fordulaton egy
  // valódi motor is folyamatos, ott ez csak zavarna.
  const idleness = 1 - Math.min(1, norm * 2.2);

  engine.oscs.forEach(({ osc, g: og, def, flutterGain }) => {
    osc.frequency.setTargetAtTime(fire * def.mul, t, 0.02);

    // Terhelés alatt a felső harmonikusok erősödnek — ettől lesz "dühös" a
    // hang gázon, és tompább, amikor csak gurulsz.
    const weight = def.mul >= 2 ? 0.55 + 0.45 * load : 1;

    // Alapjáraton a mélyebb rendek túl erős, fix búgást okoztak
    // 0–kb. 22 km/h között, amíg az RPM az IDLE_RPM-en marad.
    // Ezért lent visszavesszük őket, fordulaton pedig fokozatosan visszaengedjük.
    let idleWeight = 1;
    if (def.mul === 0.25) {
      idleWeight = 0.15 + 0.85 * norm;
    } else if (def.mul === 0.5) {
      idleWeight = 0.40 + 0.60 * norm;
    } else if (def.mul === 1.0) {
      idleWeight = 0.45 + 0.55 * norm;
    }

    og.gain.setTargetAtTime(
        def.gain * weight * idleWeight,
        t,
        0.05
    );

    // A lüktetést ugyanilyen arányban csillapítjuk, különben a mély morgás
    // a moduláción keresztül részben megmaradna.
    flutterGain.gain.setTargetAtTime(
        def.gain * weight * idleWeight * 0.55 * idleness,
        t,
        0.06
    );
  });

  // A szűrő felső határa jóval lejjebb, mint korábban (10 400 Hz volt): ott a
  // felharmonikusok teljes fényükben szóltak, és a hang nagy sebességnél
  // élesen csengett. Egy valódi F1 nagy fordulaton is TELT, nem sípol.
  engine.filter.frequency.setTargetAtTime(600 + norm * 3000 + load * 1600, t, 0.04);

  // A zaj alapja magasabb, és alacsony fordulaton ARÁNYAIBAN több: állva a
  // levegő/szívás zaja adja a hang java karakterét, nem a tiszta hangok.
  engine.noiseGain.gain.setTargetAtTime(0.05 + (1 - norm) * 0.05 + load * 0.09, t, 0.05);

  // A hangmagasság-billegés KÖZÖS marad (a főtengelyen ül mindegyik rend) —
  // enyhe ±6 centes ingadozás, alapjáraton a legerősebb.
  engine.wobbleGain.gain.setTargetAtTime(6 * idleness, t, 0.08);

  // ---- Hangerő: a FORDULATTÓL és a gáztól is függ ----
  //
  // Korábban kizárólag a gáztól függött, tehát állva és 378-cal ugyanolyan
  // hangos volt, csak a hangmagasság változott. Ez a szintetikus érzet egyik
  // fő oka volt: egy valódi motor hangereje meredeken nő a fordulattal — egy
  // F1 alapjáraton is hangos, de maximumon elsöprő, nem "ugyanaz magasabban".
  //
  // A két tényező szerepe szándékosan eltérő súlyú: a FORDULAT viszi a
  // hangerő javát (négyszeres tartomány), a gáz inkább a hangSZÍNT alakítja
  // (szűrő, felharmonikusok), és csak mérsékelten a szintet. Így gázelvételkor
  // nem némul el a motor — ez volt az előző kör panasza —, de a különbség
  // hallatszik.
  //
  // A fordulat-tag enyhén meredekebb a lineárisnál: a fül a felső tartományban
  // érzékenyebb a változásra, és így a felpörgés vége jobban "húz".
  const rpmLevel = 0.30 + 0.70 * Math.pow(norm, 0.85);
  const loadLevel = 0.78 + 0.22 * load;

  // Sebesség-tag: a menetzaj (levegő, gumi) áll mögötte, nem a motor. Azért
  // kell külön, mert a VÁLTÓ miatt a fordulat 150 és 378 km/h között alig
  // változik (3. fokozat ~16 000, 6. fokozat ~18 700) — a motor tehát hasonlóan
  // szól, miközben a játékos joggal vár érezhetően többet a csúcssebességnél.
  // Ez nem "csalás": egy valódi autóban is a menetzaj adja a különbséget.
  const speedLevel = 0.80 + 0.20 * Math.min(1, Math.abs(speedKmh) / 378);

  engine.gain.gain.setTargetAtTime(ENGINE_VOLUME * rpmLevel * loadLevel * speedLevel, t, 0.05);
}

// ---------------------------------------------------------------------------
// Távoli multiplayer-autók motorhangja
// ---------------------------------------------------------------------------
// A saját motor részletes szintetizátora sok párhuzamos forrást használ. Ezt
// játékosonként lemásolva egy nyolcfős szoba már feleslegesen terhelné a hang-
// motort, ezért az ellenfelek egy könnyebb, négy harmonikusos változatot kapnak.
// Közelről megmarad az F1-karakter, távolról pedig a térbeli csillapítás úgyis
// elfedi azokat a finom részleteket, amelyek csak a saját autónál hallhatók.
const REMOTE_ENGINE_VOLUME = 0.26;
const REMOTE_SOUND_FADE_START = 90;
const REMOTE_SOUND_MAX_RANGE = 125;
const SPEED_OF_SOUND = 343;
const DOPPLER_MAX_SHIFT = 0.10;
const REMOTE_HARMONICS = [
  { mul: 0.5, gain: 0.42 },
  { mul: 1.0, gain: 0.76 },
  { mul: 2.0, gain: 0.18 },
  { mul: 3.0, gain: 0.07 },
];

let remoteNoiseBuffer = null;
const listenerPosition = { x: 0, y: 0, z: 0, ready: false };
const listenerVelocity = { x: 0, y: 0, z: 0 };

function vector3(value) {
  const x = Number(value?.x ?? value?.[0]);
  const y = Number(value?.y ?? value?.[1]);
  const z = Number(value?.z ?? value?.[2]);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
  };
}

// A teljes fizikai Doppler F1-sebességnél szélsőséges lenne (akár 30–40%-os
// hangmagasság-ugrás), ezért a relatív közeledési sebesség lineáris közelítését
// használjuk és ±10%-ra fogjuk. Ez hallható elsuhanást ad, de nem írja felül a
// motor saját fordulatát és a váltásokat.
export function calculateDopplerFactor(sourcePosition, sourceVelocity, listenerPos, listenerVel) {
  const source = vector3(sourcePosition);
  const velocity = vector3(sourceVelocity);
  const listener = vector3(listenerPos);
  const listenerV = vector3(listenerVel);
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const dz = source.z - listener.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 0.1) return 1;
  const invDistance = 1 / distance;
  // Pozitív, ha a két pont közti távolság csökken; negatív, ha nő.
  const closingSpeed = -(
    (velocity.x - listenerV.x) * dx * invDistance +
    (velocity.y - listenerV.y) * dy * invDistance +
    (velocity.z - listenerV.z) * dz * invDistance
  );
  return Math.max(
    1 - DOPPLER_MAX_SHIFT,
    Math.min(1 + DOPPLER_MAX_SHIFT, 1 + closingSpeed / SPEED_OF_SOUND)
  );
}

function sharedRemoteNoise(c) {
  if (remoteNoiseBuffer) return remoteNoiseBuffer;
  const len = c.sampleRate * 2;
  remoteNoiseBuffer = c.createBuffer(1, len, c.sampleRate);
  const data = remoteNoiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return remoteNoiseBuffer;
}

function setSpatialPosition(node, position, t, smoothing = 0.025) {
  const x = Number(position?.x ?? position?.[0]) || 0;
  const y = Number(position?.y ?? position?.[1]) || 0;
  const z = Number(position?.z ?? position?.[2]) || 0;
  if (node.positionX) {
    node.positionX.setTargetAtTime(x, t, smoothing);
    node.positionY.setTargetAtTime(y, t, smoothing);
    node.positionZ.setTargetAtTime(z, t, smoothing);
  } else {
    node.setPosition(x, y, z);
  }
  return { x, y, z };
}

function pickRemoteGear(remote, speedMs) {
  while (remote.gear < GEAR_RATIOS.length - 1 && rpmFor(speedMs, remote.gear) > SHIFT_UP_RPM) remote.gear++;
  while (remote.gear > 0 && rpmFor(speedMs, remote.gear) < SHIFT_DOWN_RPM) remote.gear--;
  return remote.gear;
}

export function createRemoteEngine() {
  const c = ensureContext();
  if (!c) return null;

  const panner = c.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  // A rajtrácson és közvetlen csatában biztosan hallatszódjon a saját motor
  // mellett: 15 méterig teljes szinten szól, utána indul a csillapítás.
  panner.refDistance = 15;
  panner.maxDistance = REMOTE_SOUND_MAX_RANGE;
  panner.rolloffFactor = 0.75;

  const gain = c.createGain();
  gain.gain.value = 0;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.2;
  filter.connect(gain);
  gain.connect(panner);
  panner.connect(master);

  const oscs = REMOTE_HARMONICS.map((def, i) => {
    const osc = c.createOscillator();
    const harmonicGain = c.createGain();
    osc.type = 'sawtooth';
    osc.detune.value = [-7, 5, -4, 8][i] || 0;
    harmonicGain.gain.value = def.gain;
    osc.connect(harmonicGain);
    harmonicGain.connect(filter);
    osc.start();
    return { osc, gain: harmonicGain, def };
  });

  // Egyetlen széles zajréteg ad levegőt a könnyített harmonikusoknak. A puffer
  // közös az összes ellenfél közt; csak az olvasó forrás külön autónként.
  const noiseSrc = c.createBufferSource();
  noiseSrc.buffer = sharedRemoteNoise(c);
  noiseSrc.loop = true;
  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 1700;
  noiseFilter.Q.value = 0.3;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.04;
  noiseSrc.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(filter);
  noiseSrc.start();

  return {
    oscs, filter, gain, panner, noiseSrc, noiseGain,
    gear: 0, smoothedRpm: IDLE_RPM, doppler: 1, stopped: false,
  };
}

export function updateRemoteEngine(remote, {
  position, velocity, speedKmh = 0, throttle = 0,
}, dt = 1 / 60) {
  if (!remote || remote.stopped || !ctx) return;
  const t = ctx.currentTime;
  const source = setSpatialPosition(remote.panner, position, t);
  const speedMs = Math.abs(speedKmh) / 3.6;
  const gearIndex = pickRemoteGear(remote, speedMs);
  const targetRpm = Math.max(IDLE_RPM, Math.min(MAX_RPM, rpmFor(speedMs, gearIndex)));
  const smoothing = 1 - Math.exp(-Math.max(0, dt) * 18);
  remote.smoothedRpm += (targetRpm - remote.smoothedRpm) * smoothing;

  const dopplerTarget = listenerPosition.ready
    ? calculateDopplerFactor(source, velocity, listenerPosition, listenerVelocity)
    : 1;
  const dopplerSmoothing = 1 - Math.exp(-Math.max(0, dt) * 10);
  remote.doppler += (dopplerTarget - remote.doppler) * dopplerSmoothing;

  const fire = (remote.smoothedRpm / 60) * (HENGER / 2);
  const norm = (remote.smoothedRpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM);
  const load = Math.min(1, Math.abs(Number(throttle) || 0));
  remote.oscs.forEach(({ osc, gain: harmonicGain, def }) => {
    osc.frequency.setTargetAtTime(fire * def.mul * remote.doppler, t, 0.03);
    const loadWeight = def.mul >= 2 ? 0.55 + 0.45 * load : 1;
    const idleWeight = def.mul <= 1 ? 0.42 + 0.58 * norm : 1;
    harmonicGain.gain.setTargetAtTime(def.gain * loadWeight * idleWeight, t, 0.06);
  });
  remote.filter.frequency.setTargetAtTime(700 + norm * 2800 + load * 1200, t, 0.05);
  remote.noiseGain.gain.setTargetAtTime(0.035 + norm * 0.035 + load * 0.04, t, 0.06);

  const rpmLevel = 0.28 + 0.72 * Math.pow(Math.max(0, norm), 0.85);
  const loadLevel = 0.78 + 0.22 * load;
  let rangeFade = 1;
  if (listenerPosition.ready) {
    const distance = Math.hypot(
      source.x - listenerPosition.x,
      source.y - listenerPosition.y,
      source.z - listenerPosition.z
    );
    rangeFade = Math.max(0, Math.min(1,
      (REMOTE_SOUND_MAX_RANGE - distance) / (REMOTE_SOUND_MAX_RANGE - REMOTE_SOUND_FADE_START)
    ));
  }
  remote.gain.gain.setTargetAtTime(
    REMOTE_ENGINE_VOLUME * rpmLevel * loadLevel * rangeFade,
    t,
    rangeFade > 0 ? 0.06 : 0.12
  );
}

export function stopRemoteEngine(remote) {
  if (!remote || remote.stopped || !ctx) return;
  remote.stopped = true;
  const t = ctx.currentTime;
  remote.gain.gain.cancelScheduledValues(t);
  remote.gain.gain.setTargetAtTime(0, t, 0.05);
  setTimeout(() => {
    try {
      remote.oscs.forEach(({ osc }) => osc.stop());
      remote.noiseSrc.stop();
      remote.panner.disconnect();
    } catch { /* már leállt */ }
  }, 350);
}

export function updateAudioListener(position, forward, up, velocity) {
  const c = ensureContext();
  if (!c) return;
  const t = c.currentTime;
  const p = setSpatialPosition(c.listener, position, t, 0.015);
  listenerPosition.x = p.x;
  listenerPosition.y = p.y;
  listenerPosition.z = p.z;
  listenerPosition.ready = true;
  const v = vector3(velocity);
  listenerVelocity.x = v.x;
  listenerVelocity.y = v.y;
  listenerVelocity.z = v.z;

  const rawFx = Number(forward?.x ?? forward?.[0]);
  const rawFy = Number(forward?.y ?? forward?.[1]);
  const rawFz = Number(forward?.z ?? forward?.[2]);
  const rawUx = Number(up?.x ?? up?.[0]);
  const rawUy = Number(up?.y ?? up?.[1]);
  const rawUz = Number(up?.z ?? up?.[2]);
  const fx = Number.isFinite(rawFx) ? rawFx : 0;
  const fy = Number.isFinite(rawFy) ? rawFy : 0;
  const fz = Number.isFinite(rawFz) ? rawFz : -1;
  const ux = Number.isFinite(rawUx) ? rawUx : 0;
  const uy = Number.isFinite(rawUy) ? rawUy : 1;
  const uz = Number.isFinite(rawUz) ? rawUz : 0;
  const listener = c.listener;
  if (listener.forwardX) {
    listener.forwardX.setTargetAtTime(fx, t, 0.015);
    listener.forwardY.setTargetAtTime(fy, t, 0.015);
    listener.forwardZ.setTargetAtTime(fz, t, 0.015);
    listener.upX.setTargetAtTime(ux, t, 0.015);
    listener.upY.setTargetAtTime(uy, t, 0.015);
    listener.upZ.setTargetAtTime(uz, t, 0.015);
  } else {
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

export function setMuted(value) {
  muted = !!value;
  if (master) master.gain.value = muted ? 0 : volume;
  return muted;
}

export function isMuted() {
  return muted;
}

export function setVolume(value) {
  const numeric = Number(value);
  volume = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
  if (master && !muted) master.gain.value = volume;
  return volume;
}

export function getVolume() {
  return volume;
}

// Az első felhasználói gesztusnál érdemes már felépíteni a hang-láncot, hogy a
// legelső bip se késsen (a context létrehozása pár tized másodpercig is
// eltarthat). Csak előkészít, nem szól.
export function primeOnFirstGesture() {
  const once = () => {
    ensureContext();
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
  };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}
