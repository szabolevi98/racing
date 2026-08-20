// A jármű- és világ-fizika minden számszerű beállítása, EGY helyen.
//
// A böngésző egyjátékosban és online is ebből építi az autó fizikáját. A Node
// tesztek ugyanezekkel az értékekkel ellenőrzik a jármű viselkedését.
//
// A menetdinamikai (hangolható) számok NEM itt vannak, hanem a
// vehicleTunables.js-ben — az a fájl csak sima export-lista, semmi logika,
// hogy a dev autó-tesztelő "Mentés fájlba" gombja pontosan ilyen tartalmat
// tudjon generálni, és felülírható legyen vele. Innen csak TOVÁBBADJUK őket
// (export ... from), hogy a többi fájlnak (main.js, dev.js) ne
// kelljen tudnia a szétválasztásról — mindenki továbbra is a
// shared/vehicleConfig.js-ből importál, ugyanazokkal a nevekkel.
export {
  MAX_ENGINE_FORCE, MAX_ENGINE_POWER, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
  AERO_DRAG_COEFFICIENT, AERO_DOWNFORCE_COEFFICIENT,
  LINEAR_DAMPING, ANGULAR_DAMPING,
} from './vehicleTunables.js';
// Ugyanezek importként is kellenek: az `export ... from` csak TOVÁBBADJA a
// bindingot a hívóknak, de nem hoz létre helyi nevet — a lenti SUSPENSION
// objektumnak, a buildVehicle/applyControls-nak és az élő hangoló
// mechanizmusnak ITT, ebben a fájlban is szüksége van rájuk.
import {
  MAX_ENGINE_FORCE, MAX_ENGINE_POWER, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
  SUSPENSION_STIFFNESS, SUSPENSION_COMPRESSION, SUSPENSION_RELAXATION, SUSPENSION_MAX_TRAVEL,
  AERO_DRAG_COEFFICIENT, AERO_DOWNFORCE_COEFFICIENT,
  LINEAR_DAMPING, ANGULAR_DAMPING,
} from './vehicleTunables.js';

export const GRAVITY = { x: 0, y: -9.81, z: 0 };

// ---------- Pálya-ütköző csoportok: talaj vs. fal ----------
// A kerék-sugár (updateVehicle raycast) csak a talajt "látja" — a felfüggesztés
// magasságát méri, sosem oldalra. Ha a falat is látná, a majdnem-vízszintes
// fal-tetőkbe/párkányokba akadna bele a felfüggesztés-számítás. A kasztni
// dobozának normál ütközője viszont a talajjal, fallal és másik autóval is
// ütközik, így a fal ellen fizikailag megáll, a kerék-sugár pedig zavartalanul
// a talajt méri alatta.
//
// InteractionGroups egy 32 bites szám: a felső 16 bit a tagság (groups), az
// alsó 16 bit a szűrő (mask). Két fél ütközik, ha A tagsága metszi B szűrőjét
// ÉS B tagsága metszi A szűrőjét — lásd a Rapier interaction_groups.d.ts-ét.
export const COLLISION_GROUP_FLOOR = 0x0001;
export const COLLISION_GROUP_WALL = 0x0002;
export const COLLISION_GROUP_CAR = 0x0004;
export const COLLISION_GROUP_CAR_PROXY = 0x0008;
const GROUPS_ALL_MASK = 0xffff;
export const FLOOR_COLLIDER_GROUPS = (COLLISION_GROUP_FLOOR << 16) | GROUPS_ALL_MASK;
export const WALL_COLLIDER_GROUPS = (COLLISION_GROUP_WALL << 16) | GROUPS_ALL_MASK;
// Az autók külön tagságot kapnak. A korábbi alapértelmezett 0xffff tagság miatt
// a kizárólag TALAJRA szűrt keréksugár egy másik autó kasztniját is talajként
// találhatta el. Ez főleg szoros csatában adott kiszámíthatatlan rugóerőket.
export const CAR_COLLIDER_GROUPS =
  (COLLISION_GROUP_CAR << 16) |
  (COLLISION_GROUP_FLOOR | COLLISION_GROUP_WALL | COLLISION_GROUP_CAR | COLLISION_GROUP_CAR_PROXY);
// Ghost módban a kasztni ugyanúgy a CAR csoport tagja marad (a keréksugarak és
// a pálya szűrői így változatlanok), de a saját maszkjából hiányzik a CAR és a
// CAR_PROXY. Emiatt a talaj/fal továbbra is fizikai akadály, másik autó nem.
export const GHOST_CAR_COLLIDER_GROUPS =
  (COLLISION_GROUP_CAR << 16) | (COLLISION_GROUP_FLOOR | COLLISION_GROUP_WALL);
// A távoli autó helyi proxyja csak a saját valódi kasztnival ütközik.
// Így nem akad bele a talajba/falba, és a proxyk sem lökdösik egymást egy
// olyan kliensen, amely csak a saját autó fizikáját számolja.
export const CAR_PROXY_COLLIDER_GROUPS =
  (COLLISION_GROUP_CAR_PROXY << 16) | COLLISION_GROUP_CAR;
// A kerék-sugár lekérdezés tagsága = autó, szűrője = csak talaj. A Rapier
// mindkét collider tagságát és szűrőjét ellenőrzi, ezért a fal és a többi
// autó kasztnija biztosan kimarad a felfüggesztés talajkereséséből.
export const WHEEL_RAY_FILTER_GROUPS = (COLLISION_GROUP_CAR << 16) | COLLISION_GROUP_FLOOR;

// A háromszögháló anyaga mindkét oldalon ugyanaz legyen. Korábban a kliens
// explicit 1.0-t állított, a szerver viszont a Rapier alapértékén maradt.
export const TRACK_FRICTION = 1.0;

// Fél-méretek: szélesség/2, magasság/2, hossz/2.
export const CHASSIS_SIZE = { x: 1.0, y: 0.4, z: 2.2 };
// Egyetlen közös fizikai F1-autó minden vizuális skin alatt. A 600 kg a
// klasszikus F1 minimumtömeg nagyságrendje; az összes motor-, fék-, futómű- és
// aeroérték ehhez a tömeghez van együtt hangolva.
export const CHASSIS_MASS = 600;

// Ez alatt a sebesség (m/s) alatt számít az S/le nyíl VALÓDI hátramenetnek —
// fölötte fékezésnek. Sok versenyjátékban megszokott: az "S" gomb előre
// haladva fékez, és csak megálláshoz közel kezd tényleg hátramenetbe váltani.
// Anélkül az S/le nyíl a gyenge REVERSE_FACTOR-ral szorzott motorerővel
// próbálna "fékezni" — ami töredéke a valódi féknek (wheelBrake), és pont ez
// okozta az "S alig fékez" élményt.
export const REVERSE_BRAKE_THRESHOLD = 1.5;

// Célba érés után eddig teljesen szabadon gurult tovább az autó. A
// normál féket addig tartjuk rajta, amíg nagyjából 1,25 km/h alá lassul;
// ott pontosan lenullázzuk a vízszintes mozgást. Ez a külön nyugalmi küszöb
// akadályozza meg, hogy a fizikai lépés egy pillanatra hátrafelé billentse.
export const FINISH_STOP_SPEED = 0.35;

export function shouldBrakeFinishedVelocity(vx, vz) {
  return Math.hypot(vx, vz) > FINISH_STOP_SPEED;
}

export function settleFinishedBody(body) {
  const v = body.linvel();
  if (shouldBrakeFinishedVelocity(v.x, v.z)) return false;
  body.setLinvel({ x: 0, y: v.y, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  return true;
}

// A kocsi haladási sebessége a SAJÁT előre-tengelye (+Z) mentén (pozitív =
// előre) — kézzel forgatva a kvaternióval, mert ez a szerveren (Node) is fut,
// ahol nincs three.js. A (0,0,1) vektor kvaternióval forgatott alakja a
// forgatásmátrix harmadik oszlopa.
export function forwardSpeed(qx, qy, qz, qw, vx, vy, vz) {
  const fx = 2 * (qx * qz + qw * qy);
  const fy = 2 * (qy * qz - qw * qx);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  return vx * fx + vy * fy + vz * fz;
}

// A tömegközéppont alapból a doboz közepén ülne, ami a talaj fölött 0.85 —
// egy 4.4 hosszú kocsihoz képest irreálisan magas, és fékezéskor előrebuktatta
// az autót. Egy versenyautó súlypontja nagyjából a keréktengely magasságában van.
//
// A 0.15 még a korábbi, gyengébb fékerőhöz volt méretezve. Az akkori,
// irreálisan erős, 250 kg-ra jutó fék (BRAKE_FRONT=70, ~5.6 G) mellett ez már nem volt elég:
// mérve, egyenes vonalban 200 km/h-ról fékezve a kocsi 1,05 másodperc alatt
// teljesen előre bukott (upright -1.0). Minél lejjebb van a súlypont, annál
// nagyobb fékező nyomatékot visel el a kocsi borulás nélkül — méréssel a 0.55
// már tökéletesen stabil (upright 0.999) UGYANAZZAL a fékerővel, és mellékesen
// a kanyarodást is javítja (szögsebesség +53% ugyanannál a kormányszögnél,
// alacsonyabb súlyponttal kevesebb a bólintás/dőlés, ami elviszi az energiát).
// A 600 kg-os profil 65/55-ös féke mérve ~2.8–3.1 G, tehát ez most bőven tartalék.
export const COM_DROP = 0.55;

// A helyi távoli-autó proxy ugyanilyen tömeg/inercia-adatokat kap. Ha csak a
// tömeg egyezne, egy oldalirányú koccanásra máshogy fordulna el, mint a
// szerver valódi autója, és a következő snapshot ezt láthatóan korrigálná.
export function applyChassisMassProperties(collider, body) {
  const m = CHASSIS_MASS;
  const w = CHASSIS_SIZE.x * 2, h = CHASSIS_SIZE.y * 2, d = CHASSIS_SIZE.z * 2;
  collider.setMassProperties(
    m,
    { x: 0, y: -COM_DROP, z: 0 },
    { x: (m / 12) * (h * h + d * d), y: (m / 12) * (w * w + d * d), z: (m / 12) * (w * w + h * h) },
    { x: 0, y: 0, z: 0, w: 1 }
  );
  body.recomputeMassPropertiesFromColliders();
}

export const WHEEL_RADIUS = 0.35;
export const SUSPENSION_REST_LENGTH = 0.3;

// index: 0 = első bal, 1 = első jobb, 2 = hátsó bal, 3 = hátsó jobb.
// A +Z az autó eleje. A hajtás a hátsó (2,3), a kormányzás az első (0,1).
export const WHEEL_POSITIONS = [
  { x: -0.85, y: -0.2, z: 1.5 },
  { x: 0.85, y: -0.2, z: 1.5 },
  { x: -0.85, y: -0.2, z: -1.5 },
  { x: 0.85, y: -0.2, z: -1.5 },
];

// A maxForce nem hangolható a dev-tesztelőből (a Rapier-nél gyakorlatilag
// sosem ez a korlátozó tényező) — marad itt, a többi négy a
// vehicleTunables.js-ből jön.
export const SUSPENSION = {
  stiffness: SUSPENSION_STIFFNESS,
  compression: SUSPENSION_COMPRESSION,
  relaxation: SUSPENSION_RELAXATION,
  maxTravel: SUSPENSION_MAX_TRAVEL,
  maxForce: 100000,
};

export const ASPHALT_FRICTION_SLIP = REAR_FRICTION_SLIP;
// Rajt előtt / verseny után a kocsit helyben kell tartani, akár lejtőn is.
export const HOLD_BRAKE = 145;
// Kifutón (fű/kavics) kevesebb erő jut a talajra és csúszósabb is.
//
// A közvetlen kifutó-drag a meghatározó: a 600 kg-os F1-profillal mérve teljes
// gáznál 104.5 km/h az egyensúly, 250-ről gázelvétel után 3 másodperccel pedig
// 124.4 km/h marad. A kisebb frictionSlip főleg a KANYARODÁST teszi csúszóssá.
export const OFFTRACK_FRICTION_SLIP = 1.0;
export const OFFTRACK_FORCE_FACTOR = 0.55;
// FIGYELEM: ez képkockánkénti SZORZÓ, és a fizika 60×/mp lép — vagyis a
// másodpercenkénti hatás a 60. hatvány, sokkal erősebb, mint amilyennek
// első ránézésre tűnik: 0.997^60 = 0.835, tehát másodpercenként a sebesség
// 16%-a vész el.
//
// A 0.997 képkockánként enyhének látszik, de fix 60 Hz-en elég erős ahhoz,
// hogy a füvön ne lehessen értelmesen levágni a pályát.
export const OFFTRACK_DRAG = 0.997;

// ---------- Cél-végsebesség és biztonsági plafon ----------
// A normál végsebességet NEM ez a vágás adja: a 660 kW-os teljesítménykorlát
// és a négyzetes légellenállás sík pályán természetesen ~378 km/h-nál kerül
// egyensúlyba. Ez csak ütközés, meredek lejtő vagy hibás pályageometria után
// fogja meg a fizikailag elszaladó vízszintes sebességet.
//
// Ez NEM hangolható a dev panelről (nincs hozzá csúszka), ezért nem is a
// vehicleTunables.js-ben van: azt a fájlt a panel "Mentés fájlba" gombja
// egészében újragenerálja a csúszkákból, és egy ott felejtett, csúszka nélküli
// konstans az első mentésnél nyomtalanul eltűnne.
export const TARGET_TOP_SPEED_KMH = 378;
export const MAX_SPEED_KMH = 420;
export const MAX_SPEED = MAX_SPEED_KMH / 3.6;

// Kizárólag a VÍZSZINTES sebességet korlátozza — pont azt a számot, amit a
// sebességmérő is mutat (Math.hypot(vx, vz) * 3.6). A függőleges komponens
// szándékosan érintetlen: az esést nem szabad lefékezni, különben a kocsi
// lassítva lebegne le a magasabb pályaelemekről.
//
// A világ léptetése UTÁN kell hívni, ugyanúgy, mint a zone.js
// applyWallConstraint-jét — mindkettő a kész sebességre ható kényszer, nem
// vezérlő-bemenet, ezért nincs helyük az applyControls-ban. Mindhárom hívási
// helyen ugyanabban a sorrendben kell futniuk (egyjátékos animate és online
// stepLocalPhysics), hogy a két játékmód azonosan viselkedjen.
export function applySpeedCap(body) {
  const v = body.linvel();
  const speed = Math.hypot(v.x, v.z);
  if (speed <= MAX_SPEED) return;
  const k = MAX_SPEED / speed;
  body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
}

// A látható kerék-kormányzás simán közelít a célértékhez (rad/mp). Csak a
// megjelenítést érinti, a fizikai kormányzás azonnali.
export const STEER_VISUAL_SPEED = 3.5;

// ---------- Élő hangolás (kizárólag a fejlesztői autó-tesztelőhöz) ----------
// A vehicleTunables.js-ből importált értékek maradnak a KANONIKUS
// alapértékek — a szerver és minden normál játékmenet (egyjátékos,
// multiplayer) ezeket olvassa, érintetlenül. Az applyControls azonban nem
// közvetlenül ezekből, hanem egy velük induló, MUTÁLHATÓ másolatból
// dolgozik — ez teszi lehetővé, hogy a dev autó-tesztelő panelje élőben
// hangolhassa a motorerőt/kormányszöget/féket/tapadást, anélkül hogy a
// vehicleTunables.js-t kellene módosítani és újratölteni a szervert.
//
// Ez nem kockázat a szerverre: az egy külön Node-folyamat, saját
// modulpéldánnyal — a böngészőből ide semmi nem ér el. Az egyetlen valódi
// veszély, hogy EGY böngészőlapon belül a hangolás "átszivárogna" a dev
// tesztelésből a rendes vezetésbe/multiplayerbe — ezért a dev.js mindig
// visszaállítja induláskor ÉS kilépéskor is (resetLiveVehicleTunables), és
// biztonsági hálóként a valódi versenyindítás (startRace / multiplayer
// beginRace) is hívja ugyanezt.
const live = {
  MAX_ENGINE_FORCE, MAX_ENGINE_POWER, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
  AERO_DRAG_COEFFICIENT, AERO_DOWNFORCE_COEFFICIENT,
};
const LIVE_DEFAULTS = { ...live };

export function setLiveVehicleTunables(partial) {
  Object.assign(live, partial);
}

export function resetLiveVehicleTunables() {
  Object.assign(live, LIVE_DEFAULTS);
}

export function getLiveVehicleTunables() {
  return { ...live };
}

// Az applyControls képkockánként is futhat, miközben alacsony FPS-nél több
// fix fizikai lépést hozunk be. A kért motorerőt ezért eltesszük, és minden
// egyes fizikai tick előtt frissen alkalmazzuk a teljesítménykorláttal együtt.
const requestedEngineForce = new WeakMap();
const ENGINE_POWER_SPEED_FLOOR = 1;

// A motor teljesítménykorlátja és az aerodinamika közös, fix-tickes útja.
// Singleplayer és multiplayer is pontosan egyszer hívja minden world.step előtt.
// Az aero impulzusként kerül rá a testre (F * dt), így nem halmozódik a Rapier
// folyamatos erő-akkumulátorában és nem függ a renderelési FPS-től.
export function applyVehicleStepForces(vehicle, body, timestep) {
  let force = requestedEngineForce.get(vehicle) || 0;
  if (force > 0) {
    const q = body.rotation();
    const v = body.linvel();
    const speed = Math.abs(forwardSpeed(q.x, q.y, q.z, q.w, v.x, v.y, v.z));
    const perWheelPowerLimit = live.MAX_ENGINE_POWER
      / (2 * Math.max(ENGINE_POWER_SPEED_FLOOR, speed));
    force = Math.min(force, perWheelPowerLimit);
  }
  vehicle.setWheelEngineForce(2, force);
  vehicle.setWheelEngineForce(3, force);

  const dt = Number(timestep);
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const v = body.linvel();
  const speed = Math.hypot(v.x, v.z);
  if (speed < 0.01) return;
  const dragImpulseScale = -live.AERO_DRAG_COEFFICIENT * speed * dt;
  body.applyImpulse({
    x: v.x * dragImpulseScale,
    y: -live.AERO_DOWNFORCE_COEFFICIENT * speed * speed * dt,
    z: v.z * dragImpulseScale,
  }, true);
}

// Egy kocsi felépítése a Rapier világban. Ugyanaz a kód fut a kliensen és a
// szerveren, hogy a két szimuláció egyforma legyen.
export function buildVehicle(
  RAPIER,
  world,
  position = { x: 0, y: 5, z: 0 },
  { collideWithCars = true } = {}
) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      // A pálya ütközője háromszögháló, aminek nincs vastagsága: gyors esésnél
      // a kasztni doboza egyetlen lépés alatt átugorhatná a felületet.
      .setCcdEnabled(true)
  );

  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(CHASSIS_SIZE.x, CHASSIS_SIZE.y, CHASSIS_SIZE.z)
      .setMass(CHASSIS_MASS)
      .setCollisionGroups(collideWithCars ? CAR_COLLIDER_GROUPS : GHOST_CAR_COLLIDER_GROUPS),
    body
  );

  applyChassisMassProperties(collider, body);

  const vehicle = world.createVehicleController(body);
  vehicle.indexUpAxis = 1;
  vehicle.setIndexForwardAxis = 2;

  WHEEL_POSITIONS.forEach((pos, i) => {
    vehicle.addWheel(pos, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST_LENGTH, WHEEL_RADIUS);
    vehicle.setWheelSuspensionStiffness(i, SUSPENSION.stiffness);
    vehicle.setWheelSuspensionCompression(i, SUSPENSION.compression);
    vehicle.setWheelSuspensionRelaxation(i, SUSPENSION.relaxation);
    vehicle.setWheelMaxSuspensionTravel(i, SUSPENSION.maxTravel);
    vehicle.setWheelMaxSuspensionForce(i, SUSPENSION.maxForce);
    vehicle.setWheelFrictionSlip(i, i < 2 ? FRONT_FRICTION_SLIP : REAR_FRICTION_SLIP);
  });

  return { body, collider, vehicle };
}

// Egy képkockányi vezérlés alkalmazása. A bemenet normalizált:
//   throttle: -1..1 (negatív = hátramenet), steer: -1..1, brake: 0..1
// A `true` fék továbbra is 1-nek számít, így a billentyűzet és a régebbi
// kliensek változatlanul teljes fékerőt kapnak.
//
// A kifutó-büntetés KEREKENKÉNT megy: az `offtrackWheels` egy 4 elemű tömb
// (WHEEL_POSITIONS sorrend), amit a shared/zone.js wheelsOffTrack() ad. Csak
// az a kerék veszít tapadást, amelyik tényleg lement — a fékhatás és a
// motorerő pedig a lement kerekek ARÁNYÁVAL skálázódik, nem ugrik teljesbe.
//
// A régi `offtrack` logikai kapcsoló továbbra is érvényes bemenet (a dev
// autó-tesztelő és bármely egyszerűbb hívó használhatja): olyankor mind a
// négy kerékre ugyanaz vonatkozik, mint korábban.
export function applyControls(
  vehicle, body, input,
  { offtrack = false, offtrackWheels = null, frozen = false } = {}
) {
  const wheelsOff = offtrackWheels || [offtrack, offtrack, offtrack, offtrack];
  const offCount = (wheelsOff[0] ? 1 : 0) + (wheelsOff[1] ? 1 : 0)
                 + (wheelsOff[2] ? 1 : 0) + (wheelsOff[3] ? 1 : 0);
  const offFrac = offCount / 4;

  // Aszfalton az első és hátsó gumi saját hangolt értéket kap. Kifutón
  // viszont mindegyik kerék ugyanarra a külön OFFTRACK értékre vált: a
  // hátsó aszfalttapadás emelése ne gyengítse mellékesen az első kereket
  // füvön/kavicson az első-hátsó arány továbbvitelével.
  const slipOf = (i) => wheelsOff[i]
    ? OFFTRACK_FRICTION_SLIP
    : (i < 2 ? live.FRONT_FRICTION_SLIP : live.REAR_FRICTION_SLIP);
  for (let i = 0; i < 4; i++) vehicle.setWheelFrictionSlip(i, slipOf(i));
  // A kézifékhez a HÁTSÓ tengely tapadása a viszonyítás (lásd lentebb).
  const slip = Math.min(slipOf(2), slipOf(3));

  if (offFrac > 0) {
    // Arányosan: négy kerékkel a füvön a teljes 0.997, kettővel a fele annyi
    // lassítás — a rázókövet súrolva nem esik ki a kocsi alól a sebesség.
    const drag = 1 - (1 - OFFTRACK_DRAG) * offFrac;
    const v = body.linvel();
    body.setLinvel({ x: v.x * drag, y: v.y, z: v.z * drag }, true);
  }

  const forceFactor = 1 - (1 - OFFTRACK_FORCE_FACTOR) * offFrac;
  const throttle = frozen ? 0 : Math.max(-1, Math.min(1, input.throttle || 0));
  const force = (throttle >= 0 ? throttle : throttle * live.REVERSE_FACTOR) * live.MAX_ENGINE_FORCE * forceFactor;
  requestedEngineForce.set(vehicle, force);
  // Azonnal is beállítjuk, hogy az egyszerű teszt/dev hívók viselkedése ne
  // változzon; a valódi fizikai lépés előtt applyVehicleStepForces finomítja.
  vehicle.setWheelEngineForce(2, force);
  vehicle.setWheelEngineForce(3, force);

  const steer = frozen ? 0 : Math.max(-1, Math.min(1, input.steer || 0)) * live.MAX_STEER;
  vehicle.setWheelSteering(0, steer);
  vehicle.setWheelSteering(1, steer);

  // ---- Fék és kézifék: két KÜLÖNBÖZŐ dolog ----
  // Fék (S / le nyíl): mind a négy kerék, első túlsúllyal, a tapadás
  //   ÉRINTETLEN — hatékonyan és egyenesben stabilan lassít.
  // Kézifék (Space): csak a HÁTSÓ kerék blokkol, és közben a hátsó tengely
  //   oldalirányú tapadása is lecsökken — ettől kitör a hátulja, a kocsi
  //   elfordul. Lassításra szándékosan rossz (két kerék, kevés tapadás):
  //   szűk kanyarban az orr behelyezésére és driftre való.
  //
  // Korábban a kettő EGY gomb volt (a fék a hátsó tapadást is elvette),
  // ezért a fékezés mindig kicsúszással járt, és a valódi fékerőt nem
  // lehetett érdemben hangolni.
  //
  // A vehicleTunables.js-beli számok MÉRT lassulásra vannak hangolva, nem
  // érzésre. A 600 kg-os profil 65/55-ös féke 200 km/h-ról 2.20 s / 59.7 m,
  // 300-ról 3.17 s / 126 m; a leszorítóerő miatt nagy tempónál ~3.1 G-ig nő.
  // HANDBRAKE_FORCE és HANDBRAKE_REAR_SLIP egymástól FÜGGETLENÜL hat: az erő
  // csak a lassítást, a tapadás csak a hátulja kitörését szabja — ezért lehet a
  // kéziféket lassításra gyengébben, forgatásra viszont erősen hagyni.
  if (frozen) {
    for (let i = 0; i < 4; i++) vehicle.setWheelBrake(i, HOLD_BRAKE);
    return;
  }

  const brakeAmount = Math.max(0, Math.min(1, Number(input.brake) || 0));
  vehicle.setWheelBrake(0, live.BRAKE_FRONT * brakeAmount);
  vehicle.setWheelBrake(1, live.BRAKE_FRONT * brakeAmount);

  let rearBrake = live.BRAKE_REAR * brakeAmount;
  if (input.handbrake) {
    // Nem összeadódik a sima fékkel: egy blokkolt kerék nem tud "még jobban"
    // blokkolni — a kettő közül a nagyobb érvényesül.
    rearBrake = Math.max(rearBrake, live.HANDBRAKE_FORCE);
    const rear = Math.min(slip, live.HANDBRAKE_REAR_SLIP);
    vehicle.setWheelFrictionSlip(2, rear);
    vehicle.setWheelFrictionSlip(3, rear);
  }
  vehicle.setWheelBrake(2, rearBrake);
  vehicle.setWheelBrake(3, rearBrake);
}
