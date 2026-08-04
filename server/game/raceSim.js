// A verseny hiteles (authoritative) szimulációja.
//
// A szerver futtatja a teljes fizikát: minden játékos kocsija itt létezik
// "igaziból", a kliensek csak bemenetet küldenek, és a kapott állapothoz
// igazodnak. Ez az egyetlen módja annak, hogy két játékos ütközése mindkettő
// képernyőjén ugyanúgy nézzen ki.
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S2C, ROOM_STATE, TICK_RATE, TICK_MS, SNAPSHOT_RATE } from '../../shared/protocol.js';
import { GRAVITY, buildVehicle, applyControls, CHASSIS_SIZE } from '../../shared/vehicleConfig.js';
import {
  decodeZoneCodes, sampleZone, ZONE_OFFTRACK,
  wallProbes, wheelProbes, allWheelsOffTrack, applyWallConstraint,
} from '../../shared/zone.js';
import { WHEEL_POSITIONS } from '../../shared/vehicleConfig.js';
import { decodePng } from './pngDecode.js';
import { ASSETS_DIR } from '../paths.js';

let rapierReady = null;
function initRapier() {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

// A pálya ütközési hálója: [uint32 vertexCount][uint32 indexCount]
// [float32*3*verts][uint32*indices] — ugyanaz a fájl, amit a kliens tölt le,
// így a két oldal BITRE azonos geometrián számol.
async function loadCollision(mapId) {
  const file = path.join(ASSETS_DIR, 'maps', mapId, 'collision.bin');
  const buf = await fs.readFile(file);
  const vertCount = buf.readUInt32LE(0);
  const indexCount = buf.readUInt32LE(4);
  const vertices = new Float32Array(vertCount * 3);
  const indices = new Uint32Array(indexCount);
  let o = 8;
  for (let i = 0; i < vertices.length; i++, o += 4) vertices[i] = buf.readFloatLE(o);
  for (let i = 0; i < indices.length; i++, o += 4) indices[i] = buf.readUInt32LE(o);
  return { vertices, indices };
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
// Innen lövünk lefelé a talajért. Bőven a legmagasabb pályamodell fölött.
const RAY_FROM_Y = 5000;
// Mennyi bemenet állhat sorban egy játékosnál. A sor CSAK a jitter elnyelésére
// való, tartaléknak nem: minden benne álló elem egy tick (~17 ms) plusz
// késleltetés, mielőtt a játékos bemenete hatna. Ezért rövid.
//
// Ha tartósan tele van, az nem jitter, hanem óra-sodródás (a kliens gyorsabban
// küld, mint ahogy mi tickelünk). Olyankor a legrégebbit dobjuk el — az
// AKTUÁLIS szándék a fontos —, de ez a kliens újrajátszását elrontja, mert
// olyan bemenetet játszana vissza, amit sosem használtunk fel. A végleges
// megoldás egy visszacsatolás lesz (a szerver megmondja a sorhosszt, a kliens
// ehhez igazítja az ütemét); addig ez a korlát csak biztonsági háló.
const MAX_INPUT_QUEUE = 3;
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
  }

  async start() {
    await initRapier();
    this.world = new RAPIER.World(GRAVITY);
    this.world.timestep = 1 / TICK_RATE;

    // Pálya-ütköző. Ha nincs bekészítve, a verseny akkor is elindul (a kocsik
    // egy sík talajon mennek) — jobb, mint egyáltalán nem indulni, és a hiba
    // egyértelműen kiderül.
    try {
      const { vertices, indices } = await loadCollision(this.map.id);
      const trackBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices), trackBody);
    } catch (err) {
      console.warn(`[${this.room.code}] Nincs ütközési háló (${this.map.id}): ${err.message}`);
      const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.05, 0));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.05, 2000), ground);
    }

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
      const pos = { x, y: this.groundAt(x, z) + SPAWN_HEIGHT, z };
      const car = buildVehicle(RAPIER, this.world, pos);
      const half = (s.heading || 0) / 2;
      car.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);

      this.cars.set(player.id, {
        ...car,
        playerId: player.id,
        // A beérkező bemenetek SORA. A szimuláció tickenként pontosan egyet
        // fogyaszt el belőle — enélkül a kliens nem tudná újrajátszani, amit
        // a szerver csinált, és a client-side prediction sosem konvergálna.
        queue: [],
        input: { steer: 0, throttle: 0, brake: false, seq: 0 },
        lastSeq: 0,        // a legutóbb BEÉRKEZETT sorszám
        appliedSeq: 0,     // a legutóbb FELHASZNÁLT sorszám — ezt kapja a kliens
        // A falkezeléshez: hol volt a kocsi utoljára érvényes helyen.
        lastSafe: { x: pos.x, y: pos.y, z: pos.z },
        // Az "R" ide tesz vissza: az utolsó SIKERESEN érintett checkpont.
        // Kihagyott/rossz sorrendű átlépéskor szándékosan nem frissül, így
        // R mindig a legutóbbi jó pontra visz.
        respawn: { x: pos.x, z: pos.z, heading: s.heading || 0 },
        race: {
          lap: 0,
          nextCheckpoint: 0,
          tainted: false,
          hasCrossedStart: false,
          lapStart: 0,
          lapTimes: [],
          finished: false,
          prevX: pos.x,
          prevZ: pos.z,
        },
      });
      i++;
    }

    this.startAt = this.room.countdownEndsAt;
    this.lastPump = Date.now();
    this.accumulator = 0;
    this.timer = setInterval(() => this.pump(), TICK_MS);
  }

  // Megkeresi a pálya felszínét egy x/z pont fölött, felülről lefelé lőtt
  // sugárral. Ha nem talál semmit (a rajtpont a pályán kívülre esik), 0-t ad —
  // az még mindig jobb, mint a végtelenbe zuhanó autó.
  groundAt(x, z) {
    const ray = new RAPIER.Ray({ x, y: RAY_FROM_Y, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, RAY_FROM_Y * 2, true);
    return hit ? RAY_FROM_Y - hit.timeOfImpact : 0;
  }

  // Az "R" multiplayerben: a kliens nem teleportálhatja magát (a szerver a
  // hiteles forrás), ezért kér, mi pedig elvégezzük. Enélkül egy felborult
  // kocsi véglegesen ott maradt.
  resetCar(playerId) {
    const car = this.cars.get(playerId);
    if (!car || car.race.finished) return;
    const { x, z, heading } = car.respawn;
    const y = this.groundAt(x, z) + SPAWN_HEIGHT;
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
      brake: !!msg.brake,
    });
    // A sor nem nőhet korlátlanul: ha a kliens gyorsabban küld, mint ahogy mi
    // fogyasztunk (órák elcsúszása), a bemenet egyre késve érvényesülne — a
    // játékos ezt késleltetésként érezné. A legrégebbieket dobjuk el, mert az
    // AKTUÁLIS szándék a fontos.
    while (car.queue.length > MAX_INPUT_QUEUE) car.queue.shift();
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

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.step();
      if (this.stopped) return;
    }
  }

  step() {
    if (this.stopped) return;
    const now = Date.now();
    const frozen = now < this.startAt;

    if (!frozen && this.room.state === ROOM_STATE.COUNTDOWN) {
      this.room.state = ROOM_STATE.RACING;
      this.raceStartedAt = now;
      for (const car of this.cars.values()) car.race.lapStart = now;
    }

    for (const car of this.cars.values()) {
      // Tickenként PONTOSAN egy bemenetet fogyasztunk. Ha épp nem érkezett
      // (csomagvesztés vagy jitter), az előzőt ismételjük — a kliens ezt nem
      // tudja előre, de nem is kell: az újrajátszást mindig a nyugtázott
      // állapotból kezdi, amiben az ismétlés hatása már benne van.
      const next = car.queue.shift();
      if (next) {
        car.input = next;
        car.appliedSeq = next.seq;
      }
      // A kifutó lassít. A kliens ugyanezt a maszkot ugyanezzel a képlettel
      // mintázza a jóslásához (shared/zone.js), különben a pálya szélén
      // folyamatosan elcsúsznának egymástól.
      const pos = car.body.translation();
      const offtrack = sampleZone(this.zone, pos.x, pos.z) === ZONE_OFFTRACK;
      applyControls(car.vehicle, car.body, car.input, { frozen, offtrack });
      car.vehicle.updateVehicle(this.world.timestep);
    }
    this.world.step();

    // A láthatatlan falak a lépés UTÁN érvényesülnek — ugyanabban a
    // sorrendben, ahogy a kliens animate()-je és a jóslása is csinálja.
    for (const car of this.cars.values()) {
      applyWallConstraint(car.body, this.zone, car.lastSafe, WALL_PROBES);
    }
    this.tick++;

    if (!frozen) this.updateRaceProgress(now);

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
          if (i === r.nextCheckpoint) {
            r.nextCheckpoint++;
            // Csak SIKERES átlépéskor jegyezzük meg — így az R sosem tesz
            // vissza egy olyan pontra, ahol már rossz úton járt.
            car.respawn = { x: p.x, z: p.z, heading: headingFrom(fromX, fromZ, p.x, p.z, car.respawn.heading) };
          } else {
            r.tainted = true;
          }
          break;
        }
      }

      // Teljes letérés az aszfaltról: a kör érvénytelen lesz, de tovább lehet
      // menni. Eddig ez csak egyjátékosban élt — multiplayerben a kifutón át
      // le lehetett vágni a kanyart következmények nélkül.
      if (!r.tainted && allWheelsOffTrack(this.zone, car.body, WHEEL_PROBES)) {
        r.tainted = true;
      }

      if (crossedGate(gates.start, fromX, fromZ, p.x, p.z)) {
        car.respawn = { x: p.x, z: p.z, heading: headingFrom(fromX, fromZ, p.x, p.z, car.respawn.heading) };
        if (!r.hasCrossedStart) {
          // A rajtpont a rajtvonal ELŐTT van: az első átlépés a kört KEZDI.
          r.hasCrossedStart = true;
          r.lapStart = now;
        } else {
          const invalid = r.tainted || r.nextCheckpoint < checkpoints.length;
          const time = now - r.lapStart;
          r.lapTimes.push({ time, invalid });
          r.lap++;
          r.nextCheckpoint = 0;
          r.tainted = false;
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
    const cars = [];
    for (const car of this.cars.values()) {
      const t = car.body.translation();
      const q = car.body.rotation();
      const v = car.body.linvel();
      const w = car.body.angvel();
      cars.push({
        id: car.playerId,
        // A tizedesek vágása érdemben csökkenti a csomagméretet, és a
        // milliméter alatti pontosság úgysem látszik.
        p: [+t.x.toFixed(3), +t.y.toFixed(3), +t.z.toFixed(3)],
        q: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)],
        v: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)],
        // A SZÖGSEBESSÉG a jósláshoz kell: a kliens innen indítja újra a
        // szimulációt, és pörgés/billenés közben enélkül más állapotból
        // számolna tovább, mint a szerver — a korrekció sosem konvergálna.
        w: [+w.x.toFixed(3), +w.y.toFixed(3), +w.z.toFixed(3)],
        st: +(car.vehicle.wheelSteering(0) ?? 0).toFixed(3),
        wr: +(car.vehicle.wheelRotation(2) ?? 0).toFixed(2),
        // A FELHASZNÁLT sorszám, nem a beérkezett: a kliens ebből tudja, melyik
        // bemenetéig van benne a hatás ebben az állapotban — innen kell
        // újrajátszania a többit. (A beérkezett sorszám félrevezetne: egy már
        // megkapott, de még sorban álló bemenet hatása még NINCS benne.)
        seq: car.appliedSeq,
        // Hány bemenete áll még sorban. A kliens ebből szabályozza a küldési
        // ütemét: a két óra sosem jár pontosan egyformán, e visszacsatolás
        // nélkül a sor percek alatt vagy kiürülne, vagy eldobásba fordulna.
        qd: car.queue.length,
        // Elromlott-e MÁR az aktuális kör (rossz sorrendű checkpoint vagy
        // teljes letérés az aszfaltról). A kliens ebből írja ki a
        // figyelmeztetést, hogy ne csak a kör végén derüljön ki.
        // A kihagyott checkpointok NEM tartoznak ide: azt csak a rajtvonalnál
        // lehet eldönteni, addig a legtöbb kör "hiányos" lenne.
        ti: car.race.tainted ? 1 : 0,
        lap: car.race.lap,
        cp: car.race.nextCheckpoint,
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
