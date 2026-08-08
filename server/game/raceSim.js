// A verseny hiteles (authoritative) szimulációja.
//
// A szerver futtatja a teljes fizikát: minden játékos kocsija itt létezik
// "igaziból", a kliensek csak bemenetet küldenek, és a kapott állapothoz
// igazodnak. Ez az egyetlen módja annak, hogy két játékos ütközése mindkettő
// képernyőjén ugyanúgy nézzen ki.
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  S2C, ROOM_STATE, TAINT, TICK_RATE, TICK_MS, SNAPSHOT_RATE, requiredCheckpoints,
} from '../../shared/protocol.js';
import {
  GRAVITY, buildVehicle, applyControls, CHASSIS_SIZE, applySpeedCap,
  shouldBrakeFinishedVelocity, settleFinishedBody,
  FLOOR_COLLIDER_GROUPS, WALL_COLLIDER_GROUPS, WHEEL_RAY_FILTER_GROUPS, TRACK_FRICTION,
} from '../../shared/vehicleConfig.js';
import {
  decodeZoneCodes,
  wallProbes, wheelProbes, allWheelsOffTrack, wheelsOffTrack, applyWallConstraint,
} from '../../shared/zone.js';
import { WHEEL_POSITIONS } from '../../shared/vehicleConfig.js';
import { decodePng } from './pngDecode.js';
import { ASSETS_DIR } from '../paths.js';

let rapierReady = null;
function initRapier() {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

// A pálya ütközési hálója (v2, két háló — talaj és fal): [uint32 magic]
// [uint32 floorVertexCount][uint32 floorIndexCount][float32*3*verts][uint32*indices]
// [uint32 wallVertexCount][uint32 wallIndexCount][float32*3*verts][uint32*indices]
// — ugyanaz a fájl, amit a kliens tölt le, így a két oldal BITRE azonos
// geometrián számol. Lásd server/devApi.js: COLLISION_MAGIC.
const COLLISION_MAGIC = 0xc0111505;

function readMesh(buf, offset) {
  const vertCount = buf.readUInt32LE(offset);
  const indexCount = buf.readUInt32LE(offset + 4);
  const vertices = new Float32Array(vertCount * 3);
  const indices = new Uint32Array(indexCount);
  let o = offset + 8;
  for (let i = 0; i < vertices.length; i++, o += 4) vertices[i] = buf.readFloatLE(o);
  for (let i = 0; i < indices.length; i++, o += 4) indices[i] = buf.readUInt32LE(o);
  return { vertices, indices, nextOffset: o };
}

async function loadCollision(mapId) {
  const file = path.join(ASSETS_DIR, 'maps', mapId, 'collision.bin');
  const buf = await fs.readFile(file);
  if (buf.length < 4 || buf.readUInt32LE(0) !== COLLISION_MAGIC) {
    throw new Error('érvénytelen vagy régi formátumú collision.bin — süsd be újra a Fejlesztői eszközökből');
  }
  const floor = readMesh(buf, 4);
  const wall = readMesh(buf, floor.nextOffset);
  return { floor, wall };
}

// A dev módban festett zóna-maszk beolvasása. Ugyanaz a zonemap.png, amit a
// kliens is letölt — ezért ad a két oldal ugyanolyan választ arra, hogy egy
// pont aszfalt-e vagy kifutó.
async function loadZoneMap(map) {
  if (!map?.zonemap?.bounds) throw new Error('nincs zonemap a manifestben');
  const file = path.join(ASSETS_DIR, 'maps', map.id, 'zonemap.png');
  const { width, height, rgba } = decodePng(await fs.readFile(file));
  return {
    codes: decodeZoneCodes(rgba, width, height),
    w: width,
    h: height,
    bounds: map.zonemap.bounds,
  };
}

// Merre nézett a kocsi, amikor áthaladt egy kapun? A mozgás irányából, mert
// az megbízhatóbb, mint a kasztni pillanatnyi állása (pl. csúszás közben).
function headingFrom(fromX, fromZ, toX, toZ, fallback) {
  const dx = toX - fromX, dz = toZ - fromZ;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return fallback;
  return Math.atan2(dx, dz);
}

// Két szakasz metszése — a kör- és checkpoint-számoláshoz. Ugyanaz a
// geometria, mint a kliensben.
// Az R-re ide tesszük vissza a kocsit: a kapu FELEZŐPONTJÁRA, nem oda, ahol a
// játékos áthaladt rajta. A kapuk szélesek (átérnek az aszfalton túlra is),
// tehát az átlépés pontja simán lehet a kifutón vagy a fal mellett — onnan
// visszaindulni büntetés lenne. A vonalat viszont mindig úgy húzzuk be, hogy a
// közepe az aszfalt közepére essen. (Ugyanez a számítás fut a kliensen is.)
function gateMidpoint(gate) {
  return { x: (gate.x1 + gate.x2) / 2, z: (gate.z1 + gate.z2) / 2 };
}

function crossedGate(gate, fromX, fromZ, toX, toZ) {
  if (!gate) return false;
  const { x1, z1, x2, z2 } = gate;
  const d = (x2 - x1) * (toZ - fromZ) - (z2 - z1) * (toX - fromX);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((fromX - x1) * (toZ - fromZ) - (fromZ - z1) * (toX - fromX)) / d;
  const u = ((fromX - x1) * (z2 - z1) - (fromZ - z1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Épp csak a nyugalmi magasság fölé tesszük a kocsit (kerék + felfüggesztés +
// fél kasztni ~0.9), hogy egy nagy zuhanás ne verje bele a vékony hálóba.
const SPAWN_HEIGHT = 1.0;
const SPAWN_SETTLE_TICKS = 120;
const NEUTRAL_INPUT = Object.freeze({ steer: 0, throttle: 0, brake: false, handbrake: false, seq: 0 });
const FINISHED_BRAKE_INPUT = Object.freeze({ steer: 0, throttle: 0, brake: true, handbrake: false, seq: 0 });
// Innen lövünk lefelé a talajért. Bőven a legmagasabb pályamodell fölött.
const RAY_FROM_Y = 5000;
// Mennyi bemenet állhat sorban egy játékosnál. A sor a jitter elnyelésére való:
// minden benne álló elem egy tick (~17 ms) plusz késleltetés, ezért normálisan
// csak az adaptív klienscél (1–6 elem) körül mozog. A 12-es plafon vészpuffer.
//
// Ha tartósan tele van, az nem jitter, hanem óra-sodródás (a kliens gyorsabban
// küld, mint ahogy mi tickelünk). Olyankor a legrégebbit dobjuk el — az
// AKTUÁLIS szándék a fontos —, de ez eltérést okoz a kliens jóslatában, mert
// ő helyben már lefuttatta azt a bemenetet, amit mi sosem használunk fel. A
// megoldás a lent snapshotba tett sorhossz és az ahhoz igazodó kliensütem;
// ez a magasabb korlát csak a rövid, nagy jittertüskéket fogja meg.
const MAX_INPUT_QUEUE = 12;
// A kocsi alaprajzának mintavételi pontjai — ugyanazok, amiket a kliens is
// használ (shared/zone.js), különben másképp döntenénk a falról.
const WALL_PROBES = wallProbes(CHASSIS_SIZE);
const WHEEL_PROBES = wheelProbes(WHEEL_POSITIONS);

export class RaceSim {
  constructor(room, { map, broadcast }) {
    this.room = room;
    this.map = map;
    this.broadcast = broadcast;
    this.world = null;
    this.cars = new Map();     // playerId -> { body, vehicle, input, race }
    this.tick = 0;
    this.timer = null;
    this.snapshotEvery = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));
    this.stopped = false;
    this.simTimeMs = 0;
  }

  async start() {
    await initRapier();
    this.world = new RAPIER.World(GRAVITY);
    this.world.timestep = 1 / TICK_RATE;

    // Pálya-ütköző. Ez NEM opcionális: korábban hiba esetén egy sík talajra
    // esett vissza, ami multiplayerben rosszabb, mint el sem indulni. A
    // kliensek a valódi hálón számolnak, a szerver egy y≈0 síkon — így egy
    // magasan fekvő pályánál a kocsik a pálya alatt születtek (beékelődés),
    // egy lejjebb fekvőnél a levegőben lebegtek. Inkább ne induljon a verseny,
    // és derüljön ki a hiba.
    const { floor, wall } = await loadCollision(this.map.id).catch((err) => {
      throw new Error(`A pálya ütközési hálója nem olvasható (${this.map.id}): ${err.message}`);
    });
    const trackBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(floor.vertices, floor.indices)
        .setFriction(TRACK_FRICTION)
        .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
      trackBody
    );
    // A fal-háló csak a kasztnival ütközik — a kerék-sugarat a
    // WHEEL_RAY_FILTER_GROUPS zárja ki belőle (lásd updateVehicle hívás lent).
    if (wall.indices.length > 0) {
      this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(wall.vertices, wall.indices)
          .setFriction(TRACK_FRICTION)
          .setCollisionGroups(WALL_COLLIDER_GROUPS),
        trackBody
      );
    }
    // A háló legfelső pontja: ha egy rajtponton a talajkeresés nem talál
    // semmit (lyuk a hálóban), innen ejtjük le a kocsit — a pálya FÖLÜL.
    let topY = -Infinity;
    for (let i = 1; i < floor.vertices.length; i += 3) if (floor.vertices[i] > topY) topY = floor.vertices[i];
    this.trackTopY = Number.isFinite(topY) ? topY : 0;

    // Zóna-térkép: enélkül a pályán kívül ugyanolyan gyors lenne a kocsi,
    // mint az aszfalton. Nem végzetes, ha hiányzik — a verseny elindul,
    // csak nincs kifutó-büntetés (és a kliens jóslata is ehhez igazodik,
    // mert ugyanezt a maszkot tölti be).
    this.zone = await loadZoneMap(this.map).catch((err) => {
      console.warn(`[${this.room.code}] Nincs zóna-térkép (${this.map.id}): ${err.message}`);
      return null;
    });

    // A lekérdező pipeline-t a world.step() frissíti — enélkül a talajkeresés
    // semmit nem találna, mert még nincs feltöltve a térbeli index.
    this.world.step();

    const spawns = this.map?.spawns?.length ? this.map.spawns : [{ x: 0, z: 0, heading: 0 }];
    let i = 0;
    for (const player of this.room.players.values()) {
      const s = spawns[(player.slot ?? i) % spawns.length];
      // Ha több a játékos, mint a rajtpont, hátrébb soroljuk őket, hogy ne
      // egymásba spawnoljanak.
      const row = Math.floor((player.slot ?? i) / spawns.length);
      const back = row * (CHASSIS_SIZE.z * 2.5);
      const x = s.x - Math.sin(s.heading) * back;
      const z = s.z - Math.cos(s.heading) * back;
      // A rajtpont csak x/z-t ad meg — a magasságot a pálya geometriájából
      // kell megkeresni. A pályamodellek világ-magassága nagyon eltérő (az
      // egyik alatta, a másik 100 méterrel a nulla fölött van), így egy fix
      // érték az egyik pályán a föld alatt születne, és a kocsi zuhanna.
      const pos = { x, y: this.spawnYAt(x, z), z };
      const car = buildVehicle(RAPIER, this.world, pos);
      const half = (s.heading || 0) / 2;
      car.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);

      this.cars.set(player.id, {
        ...car,
        playerId: player.id,
        // A beérkező bemenetek SORA. A szimuláció tickenként pontosan egyet
        // fogyaszt el belőle — így ugyanaz a sorszám ugyanazt a logikai
        // fizikai lépést jelenti a kliensen és a szerveren.
        queue: [],
        input: { steer: 0, throttle: 0, brake: false, handbrake: false, seq: 0 },
        lastSeq: 0,        // a legutóbb BEÉRKEZETT sorszám
        appliedSeq: 0,     // a legutóbb FELHASZNÁLT sorszám — ezt kapja a kliens
        queueDrops: 0,
        queueUnderflows: 0,
        // A falkezeléshez: hol volt a kocsi utoljára érvényes helyen.
        lastSafe: { x: pos.x, y: pos.y, z: pos.z },
        // Az "R" ide tesz vissza: az utolsó SIKERESEN érintett checkpont.
        // Kihagyott/rossz sorrendű átlépéskor szándékosan nem frissül, így
        // R mindig a legutóbbi jó pontra visz.
        respawn: { x: pos.x, z: pos.z, heading: s.heading || 0 },
        race: {
          lap: 0,
          nextCheckpoint: 0,
          // Hányadik kapukat érintette ebben a körben — a SORRENDTŐL függetlenül.
          // A nextCheckpoint erre nem alkalmas: az egy sorrend-mutató, ami a
          // kihagyott kapun megáll, tehát a mögötte begyűjtött kapukról semmit
          // nem mond. A kör lezárásához viszont épp a darabszám kell.
          passed: new Set(),
          // MIÉRT érvénytelen a folyamatban lévő kör (TAINT kódja), vagy NONE.
          // Egy külön "tainted" igazságérték mellett ez két, kézzel szinkronban
          // tartandó mező lett volna — a kód pont annyit tud a nullától
          // különböző értékből, mint egy bitből.
          taintReason: TAINT.NONE,
          hasCrossedStart: false,
          lapStart: 0,
          lapTimes: [],
          // Abszolút verseny-előrehaladási kulcs és az egyes időmérő
          // vonalak szerverideje. A kliensek ebből kapnak valódi időrést:
          // nem a két autó térbeli távolságát próbáljuk másodperccé
          // hazudni, hanem ugyanazon checkpoint áthaladási idejét hasonlítjuk.
          progressKey: -1,
          splits: new Map(),
          finished: false,
          prevX: pos.x,
          prevZ: pos.z,
        },
      });
      i++;
    }

    // A +1 méteres biztonsági magasság megakadályozza, hogy lejtőn vagy egy
    // domború rajtrácson a kasztni a pályába szülessen. Ezt az esést viszont a
    // játékosnak nem kell végignéznie: még az első snapshot és a timer előtt
    // rugóra ültetjük az összes autót. Így a rajt már nyugodt, talajon álló
    // állapotból indul, nem egy 20–25 cm-es becsapódás közben.
    for (let tick = 0; tick < SPAWN_SETTLE_TICKS; tick++) {
      for (const car of this.cars.values()) {
        const offtrackWheels = wheelsOffTrack(this.zone, car.body, WHEEL_PROBES);
        applyControls(car.vehicle, car.body, NEUTRAL_INPUT, { frozen: true, offtrackWheels });
        car.vehicle.updateVehicle(this.world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
      }
      this.world.step();
    }
    for (const car of this.cars.values()) {
      car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const p = car.body.translation();
      car.lastSafe = { x: p.x, y: p.y, z: p.z };
      car.race.prevX = p.x;
      car.race.prevZ = p.z;
    }

    // A rajt ideje még NEM ismert: előbb megvárjuk, hogy a kliensek betöltsenek
    // (ld. ROOM_STATE.LOADING). Addig a már előre leültetett kocsikat a
    // szimuláció befagyasztva tartja, miközben a kliensek betöltik a pályát:
    // Infinity-nél minden "most" korábbi, tehát a frozen ág érvényes.
    this.startAt = Infinity;
    this.lastPump = Date.now();
    this.simTimeMs = this.lastPump;
    this.accumulator = 0;
    this.timer = setInterval(() => this.pump(), TICK_MS);
  }

  // Mindenki betöltött (vagy lejárt a türelmi idő): innentől számol a 3-2-1,
  // és a megadott pillanatban oldódik a fagyasztás.
  releaseAt(startAt) {
    this.startAt = startAt;
    // A betöltés alatt még nem fut a kliens bemenet-hurka, ezért az ottani
    // üres sor nem hálózati hiba. A diagnosztika csak az éles rajttól számít.
    for (const car of this.cars.values()) {
      car.queueDrops = 0;
      car.queueUnderflows = 0;
    }
  }

  // Megkeresi a pálya felszínét egy x/z pont fölött, felülről lefelé lőtt
  // sugárral. null, ha nem talált semmit — a hívó dönt, mit tesz vele.
  groundAt(x, z) {
    const ray = new RAPIER.Ray({ x, y: RAY_FROM_Y, z }, { x: 0, y: -1, z: 0 });
    // Csak a talaj-collidert nézi, ne a falat — egy fal fölé eső rajtpont
    // ne a fal tetejére, hanem a fal ALATTI útra tegye a kocsit.
    const hit = this.world.castRay(ray, RAY_FROM_Y * 2, true, undefined, WHEEL_RAY_FILTER_GROUPS);
    return hit ? RAY_FROM_Y - hit.timeOfImpact : null;
  }

  // Hova születjen a kocsi egy x/z pont fölött.
  //
  // A talajkeresés korábban 0-t adott, ha nem talált semmit — ez csendes és
  // súlyos hiba volt: egy y=40-en fekvő pályánál a kocsi 39 méterrel a pálya
  // ALATT született, vagyis beékelődött a geometriába. Ha most nincs találat,
  // az a pálya adathibája (lyuk a hálóban vagy elcsúszott rajzpont), ezért
  // naplózzuk, és a háló teteje fölé tesszük — onnan legalább LERÁEsik a
  // pályára, nem beléje.
  spawnYAt(x, z) {
    const ground = this.groundAt(x, z);
    if (ground !== null) return ground + SPAWN_HEIGHT;
    console.warn(
      `[${this.room.code}] A rajtpont (${x.toFixed(1)}, ${z.toFixed(1)}) alatt nincs pálya ` +
      `(${this.map.id}) — a háló teteje fölé ejtjük a kocsit.`
    );
    return this.trackTopY + SPAWN_HEIGHT;
  }

  // Az "R" multiplayerben: a kliens nem teleportálhatja magát (a szerver a
  // hiteles forrás), ezért kér, mi pedig elvégezzük. Enélkül egy felborult
  // kocsi véglegesen ott maradt.
  resetCar(playerId) {
    const car = this.cars.get(playerId);
    if (!car || car.race.finished) return;
    const { x, z, heading } = car.respawn;
    const y = this.spawnYAt(x, z);
    car.body.setTranslation({ x, y, z }, true);
    const half = heading / 2;
    car.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car.lastSafe = { x, y, z };
    // A kör-logika az ELŐZŐ és a mostani pozíció közötti szakaszt metszi a
    // kapukkal. Teleportálás után ez a szakasz a régi helytől az újig érne, és
    // útközben átvágna kapukon — ezért itt "megszakítjuk".
    car.race.prevX = x;
    car.race.prevZ = z;
  }

  // A szobából kilépő játékos nem maradhat a szerver fizikai világában.
  // A kliensmodell eltüntetése önmagában csak láthatatlan akadályt csinálna
  // belőle, és a verseny végét is örökre blokkolná a finished-vizsgálatban.
  removeCar(playerId) {
    const car = this.cars.get(playerId);
    if (!car || !this.world) return false;
    try { this.world.removeVehicleController(car.vehicle); } catch { /* már törölve */ }
    try { this.world.removeRigidBody(car.body); } catch { /* már törölve */ }
    this.cars.delete(playerId);
    if (this.cars.size && [...this.cars.values()].every((c) => c.race.finished)) {
      void this.endRace();
    }
    return true;
  }

  queueInput(playerId, msg) {
    const car = this.cars.get(playerId);
    if (!car) return;
    // Régi (késve érkező) csomagot eldobunk: a sorszám csak nőhet.
    const seq = Number(msg.seq) || 0;
    if (seq <= car.lastSeq) return;
    car.lastSeq = seq;
    car.queue.push({
      seq,
      steer: Math.max(-1, Math.min(1, Number(msg.steer) || 0)),
      throttle: Math.max(-1, Math.min(1, Number(msg.throttle) || 0)),
      brake: Math.max(0, Math.min(1, Number(msg.brake) || 0)),
      handbrake: !!msg.handbrake,
    });
    // A sor nem nőhet korlátlanul: ha a kliens gyorsabban küld, mint ahogy mi
    // fogyasztunk (órák elcsúszása), a bemenet egyre késve érvényesülne — a
    // játékos ezt késleltetésként érezné. A legrégebbieket dobjuk el, mert az
    // AKTUÁLIS szándék a fontos.
    while (car.queue.length > MAX_INPUT_QUEUE) {
      car.queue.shift();
      car.queueDrops++;
    }
  }

  // A setInterval NEM ad pontos ütemet: a Node egész ezredmásodpercre kerekít,
  // és a step() saját ideje (fizika egy nagy háromszöghálón) is hozzáadódik.
  // Mérve 20.18 ms jött ki 16.67 helyett — vagyis 49.6 Hz. Mivel a
  // world.timestep fix 1/60, ez azt jelentette, hogy a szimuláció a valós idő
  // 83%-án járt: a kocsik lassabbak voltak, a köridők torzak, és a 60 Hz-en
  // küldő kliens folyamatosan túltermelt (a bemenet-sor betelt, és eldobásba
  // fordult, ami az újrajátszást is elrontja).
  //
  // Ezért az eltelt VALÓS időt gyűjtjük, és annyi fix lépést futtatunk,
  // amennyi belefér.
  pump() {
    if (this.stopped) return;
    const now = Date.now();
    this.accumulator += now - this.lastPump;
    this.lastPump = now;

    // Egy hosszabb akadás (GC, lemez) után nem játsszuk le gyorsítva a
    // kimaradt időt — az a játékosoknak ugrásként látszana. Inkább elengedjük.
    if (this.accumulator > TICK_MS * 8) this.accumulator = TICK_MS * 8;

    // A szimulációs idő a feldolgozandó tartomány eleje. Így egy catch-upban
    // lefutó több step külön, egyenletes időbélyeget kap, nem ugyanazt a
    // Date.now()-t, amitől a klienshez csomókban érkeztek a snapshotok.
    this.simTimeMs = now - this.accumulator;

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.simTimeMs += TICK_MS;
      this.step(this.simTimeMs);
      if (this.stopped) return;
    }
  }

  step(now = (this.simTimeMs += TICK_MS)) {
    if (this.stopped) return;
    const frozen = now < this.startAt;

    if (!frozen && this.room.state === ROOM_STATE.COUNTDOWN) {
      this.room.state = ROOM_STATE.RACING;
      this.raceStartedAt = now;
      for (const car of this.cars.values()) car.race.lapStart = now;
    }

    for (const car of this.cars.values()) {
      // Tickenként PONTOSAN egy bemenetet fogyasztunk. Ha épp nem érkezett
      // (csomagvesztés vagy jitter), az előzőt ismételjük — a kliens ezt nem
      // tudja előre; a következő nyugtázott állapot korrekciója tartalmazza az
      // ismétlés fizikai hatását.
      const next = car.queue.shift();
      if (next) {
        car.input = next;
        car.appliedSeq = next.seq;
      } else if (!frozen && car.lastSeq > 0) {
        car.queueUnderflows++;
      }
      // A kifutó lassít, KEREKENKÉNT. A kliens ugyanezt a maszkot ugyanezzel a
      // képlettel mintázza a jóslásához (shared/zone.js), különben a pálya
      // szélén folyamatosan elcsúsznának egymástól.
      const offtrackWheels = wheelsOffTrack(this.zone, car.body, WHEEL_PROBES);
      // A célba ért autó elveszíti a gázt és a kormányt, majd a normál
      // fékkel megáll. Előbb még elhagyja a célvonalat, de nem gurul el
      // korlátlanul; a nyugalmi küszöb alatt már a féket is levesszük.
      const speed = car.body.linvel();
      const finishedInput = shouldBrakeFinishedVelocity(speed.x, speed.z)
        ? FINISHED_BRAKE_INPUT
        : NEUTRAL_INPUT;
      const effectiveInput = car.race.finished ? finishedInput : car.input;
      applyControls(car.vehicle, car.body, effectiveInput, { frozen, offtrackWheels });
      car.vehicle.updateVehicle(this.world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
    }
    this.world.step();

    // A sebességplafon és a láthatatlan falak a lépés UTÁN érvényesülnek —
    // ugyanabban a sorrendben, ahogy a kliens animate()-je és a jóslása is
    // csinálja.
    for (const car of this.cars.values()) {
      applySpeedCap(car.body);
      applyWallConstraint(car.body, this.zone, car.lastSafe, WALL_PROBES);
      if (car.race.finished) settleFinishedBody(car.body);
    }
    this.tick++;

    if (!frozen) this.updateRaceProgress(now);

    // Az utolsó célba érő az updateRaceProgressban lezárhatta a versenyt és
    // felszabadíthatta a Rapier világot. Utána már nem készíthetünk snapshotot
    // az érvénytelenné vált body/controller referenciákból.
    if (this.stopped) return;

    if (this.tick % this.snapshotEvery === 0) this.sendSnapshot(now);
  }

  updateRaceProgress(now) {
    const gates = this.map?.gates;
    if (!gates?.start) return;
    const checkpoints = gates.checkpoints || [];

    for (const car of this.cars.values()) {
      const r = car.race;
      if (r.finished) continue;
      const p = car.body.translation();
      const fromX = r.prevX, fromZ = r.prevZ;
      r.prevX = p.x;
      r.prevZ = p.z;

      for (let i = 0; i < checkpoints.length; i++) {
        if (crossedGate(checkpoints[i], fromX, fromZ, p.x, p.z)) {
          // A Set miatt ugyanaz a kapu kétszer sem számít duplán.
          r.passed.add(i);
          if (i === r.nextCheckpoint) {
            r.nextCheckpoint++;
            const splitKey = r.lap * (checkpoints.length + 1) + i + 1;
            r.progressKey = splitKey;
            r.splits.set(splitKey, now);
            // Csak SIKERES átlépéskor jegyezzük meg — így az R sosem tesz
            // vissza egy olyan pontra, ahol már rossz úton járt.
            car.respawn = {
              ...gateMidpoint(checkpoints[i]),
              heading: headingFrom(fromX, fromZ, p.x, p.z, car.respawn.heading),
            };
          } else if (i > r.nextCheckpoint) {
            // Előrébb lévő kapu: tényleg kihagyott egyet közben.
            r.taintReason = TAINT.CHECKPOINT;
          }
          // Egy MÁR MEGSZERZETT kapu újbóli átlépése (i < nextCheckpoint) nem
          // hiba, csak nem is számít. A crossedGate iránytól függetlenül metsz
          // szakaszt, ezért egy megcsúszás, oldalra sodródás vagy pördülés
          // ugyanazon a vonalon másodszor is "átlépés" — korábban ez rontotta
          // el a kört, holmi csalás nélkül. Ugyanezért nem hiba az sem, ha az
          // összes kapu megvan (nextCheckpoint == length), és utána még
          // egyszer átcsúszik valamelyiken.
          break;
        }
      }

      // Teljes letérés az aszfaltról: a kör érvénytelen lesz, de tovább lehet
      // menni. Eddig ez csak egyjátékosban élt — multiplayerben a kifutón át
      // le lehetett vágni a kanyart következmények nélkül.
      if (!r.taintReason && allWheelsOffTrack(this.zone, car.body, WHEEL_PROBES)) {
        r.taintReason = TAINT.OFFTRACK;
      }

      if (crossedGate(gates.start, fromX, fromZ, p.x, p.z)) {
        if (!r.hasCrossedStart) {
          // A rajtpont a rajtvonal ELŐTT van: az első átlépés a kört KEZDI.
          r.hasCrossedStart = true;
          r.lapStart = now;
          r.progressKey = r.lap * (checkpoints.length + 1);
          r.splits.set(r.progressKey, now);
          car.respawn = {
            ...gateMidpoint(gates.start),
            heading: headingFrom(fromX, fromZ, p.x, p.z, car.respawn.heading),
          };
        } else if (r.passed.size < requiredCheckpoints(checkpoints.length)) {
          // TÚL KEVÉS kapu: a kör NEM zárul le. Enélkül a rajtvonalon
          // oda-vissza gurulva végig lehetett "teljesíteni" a versenyt — a
          // crossedGate iránytól független, tehát minden áthaladás számított.
          r.taintReason = TAINT.CHECKPOINT;
        } else {
          car.respawn = {
            ...gateMidpoint(gates.start),
            heading: headingFrom(fromX, fromZ, p.x, p.z, car.respawn.heading),
          };
          // A kör lezárul — de ha bármi hiányzott vagy lement a pályáról, akkor
          // érvénytelenül. A kör SZÁMÍT (nem kell újrázni a többiek elől), csak
          // a legjobb körbe nem megy bele.
          if (r.passed.size < checkpoints.length) r.taintReason = TAINT.CHECKPOINT;
          const invalid = !!r.taintReason;
          const time = now - r.lapStart;
          const splitKey = (r.lap + 1) * (checkpoints.length + 1);
          r.progressKey = splitKey;
          r.splits.set(splitKey, now);
          r.lapTimes.push({ time, invalid });
          r.lap++;
          r.nextCheckpoint = 0;
          r.passed.clear();
          r.taintReason = TAINT.NONE;
          r.lapStart = now;
          this.room.recordLap(this.room.players.get(car.playerId), r.lap, time, invalid).catch(() => {});
          this.broadcast(S2C.RACE_EVENT, {
            kind: 'lap', playerId: car.playerId, lap: r.lap, timeMs: Math.round(time), invalid,
          });
          if (r.lap >= this.room.laps) {
            r.finished = true;
            r.finishedAt = now;
            this.broadcast(S2C.RACE_EVENT, { kind: 'finished', playerId: car.playerId });
          }
        }
      }
    }

    if ([...this.cars.values()].every((c) => c.race.finished)) this.endRace();
  }

  sendSnapshot(now) {
    const ordered = [...this.cars.values()].sort((a, b) => {
      if (a.race.finished && b.race.finished) {
        return (a.race.finishedAt || Infinity) - (b.race.finishedAt || Infinity);
      }
      if (a.race.finished !== b.race.finished) return a.race.finished ? -1 : 1;
      if (a.race.progressKey !== b.race.progressKey) return b.race.progressKey - a.race.progressKey;
      const aAt = a.race.splits.get(a.race.progressKey) ?? Infinity;
      const bAt = b.race.splits.get(b.race.progressKey) ?? Infinity;
      return aAt - bAt;
    });
    const rankById = new Map(ordered.map((car, index) => [car.playerId, index + 1]));
    const leader = ordered[0] || null;

    const cars = [];
    for (const car of this.cars.values()) {
      const t = car.body.translation();
      const q = car.body.rotation();
      const v = car.body.linvel();
      const w = car.body.angvel();
      const validLaps = car.race.lapTimes.filter((lap) => !lap.invalid);
      const bestLap = validLaps.length ? Math.min(...validLaps.map((lap) => lap.time)) : null;
      const lastLap = car.race.lapTimes.at(-1) || null;
      let gapMs = null;
      if (leader === car) {
        gapMs = 0;
      } else if (leader && car.race.progressKey >= 0) {
        // A lemaradó legfrissebb időmérő pontja az a legújabb vonal,
        // amelyet biztosan mindketten teljesítettek. Ha azóta előzés történt,
        // a régi split negatív lenne; olyankor a következő közös pontig
        // inkább nem mutatunk félrevezető számot.
        const commonKey = Math.min(car.race.progressKey, leader.race.progressKey);
        const carAt = car.race.splits.get(commonKey);
        const leaderAt = leader.race.splits.get(commonKey);
        if (Number.isFinite(carAt) && Number.isFinite(leaderAt) && carAt >= leaderAt) {
          gapMs = carAt - leaderAt;
        }
      }
      cars.push({
        id: car.playerId,
        // A tizedesek vágása érdemben csökkenti a csomagméretet, és a
        // milliméter alatti pontosság úgysem látszik.
        p: [+t.x.toFixed(3), +t.y.toFixed(3), +t.z.toFixed(3)],
        q: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)],
        v: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)],
        // A SZÖGSEBESSÉG a jóslás korrekciójához kell: pörgés/billenés közben
        // enélkül nem tudnánk a szerver teljes mozgásállapotát összehasonlítani.
        w: [+w.x.toFixed(3), +w.y.toFixed(3), +w.z.toFixed(3)],
        st: +(car.vehicle.wheelSteering(0) ?? 0).toFixed(3),
        wr: +(car.vehicle.wheelRotation(2) ?? 0).toFixed(2),
        // A távoli kliens motorhangjának terhelése. A pozícióból és sebességből
        // a fordulat kiszámolható, de azt nem lehet kitalálni, hogy a játékos
        // épp gyorsít vagy csak gurul. Célba érés után mindig gázelvételt küldünk.
        th: car.race.finished ? 0 : +car.input.throttle.toFixed(2),
        // A FELHASZNÁLT sorszám, nem a beérkezett: a kliens ebből tudja, melyik
        // korabeli jóslatát hasonlítsa ehhez az állapothoz. (A beérkezett
        // sorszám félrevezetne: egy már megkapott, de még sorban álló
        // bemenet hatása még NINCS benne.)
        seq: car.appliedSeq,
        // Hány bemenete áll még sorban. A kliens ebből szabályozza a küldési
        // ütemét: a két óra sosem jár pontosan egyformán, e visszacsatolás
        // nélkül a sor percek alatt vagy kiürülne, vagy eldobásba fordulna.
        qd: car.queue.length,
        qdrop: car.queueDrops,
        qunder: car.queueUnderflows,
        // Elromlott-e MÁR az aktuális kör, és ha igen, MIÉRT (TAINT kódja) —
        // a kliens ebből írja ki a konkrét okot, hogy ne csak a kör végén
        // derüljön ki, és hogy tudja, mit csinált másképp legközelebb.
        // A kihagyott checkpointok NEM tartoznak ide: azt csak a rajtvonalnál
        // lehet eldönteni, addig a legtöbb kör "hiányos" lenne.
        ti: car.race.taintReason,
        lap: car.race.lap,
        cp: car.race.nextCheckpoint,
        rk: rankById.get(car.playerId) || 0,
        gap: gapMs === null ? null : Math.round(gapMs),
        best: bestLap === null ? null : Math.round(bestLap),
        last: lastLap ? Math.round(lastLap.time) : null,
        li: !!lastLap?.invalid,
        fin: !!car.race.finished,
      });
    }
    this.broadcast(S2C.SNAPSHOT, { tick: this.tick, t: now, cars });
  }

  async endRace() {
    if (this.stopped) return;
    this.stop();
    this.room.state = ROOM_STATE.FINISHED;

    const results = [...this.cars.values()]
      .map((car) => {
        const valid = car.race.lapTimes.filter((l) => !l.invalid).map((l) => l.time);
        return {
          playerId: car.playerId,
          carId: this.room.players.get(car.playerId)?.carId || '',
          lapsCompleted: car.race.lap,
          totalMs: Math.round(car.race.lapTimes.reduce((a, l) => a + l.time, 0)),
          bestLapMs: valid.length ? Math.round(Math.min(...valid)) : null,
          finishedAt: car.race.finishedAt || null,
        };
      })
      .sort((a, b) => (b.lapsCompleted - a.lapsCompleted) || (a.totalMs - b.totalMs));

    results.forEach((r, i) => { r.position = i + 1; });
    await this.room.recordResults(results).catch(() => {});
    this.broadcast(S2C.RACE_END, { results });

    // Vissza LOBBY-ra: enélkül a state örökre FINISHED maradt, és a
    // canStart() minden további próbálkozásnál "A verseny már elindult"
    // hibát adott ugyanabban a szobában — új versenyt csak új szoba
    // létrehozásával lehetett indítani.
    this.room.state = ROOM_STATE.LOBBY;
    this.room.sim = null;
    this.broadcast(S2C.ROOM_STATE, { room: this.room.toJSON() });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A Rapier világ WASM-memóriát tart; enélkül egy hosszan futó szerveren
    // szobánként szivárogna.
    try { this.world?.free(); } catch { /* már felszabadult */ }
    this.world = null;
  }
}
