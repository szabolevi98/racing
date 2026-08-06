// A jármű- és világ-fizika minden számszerű beállítása, EGY helyen.
//
// Ez a fájl a böngészőben és a szerveren is fut. Ez nem kényelmi kérdés: az
// authoritative multiplayer csak akkor működik, ha a két oldal ugyanazt
// számolja. Ha egy érték csak az egyik oldalon változna, a kliens jóslata
// folyamatosan eltérne a szerver igazságától, és a kocsi ugrálna.
//
// (A Rapier build is bitre azonos a két oldalon: @dimforge/rapier3d-compat 0.14.0.)
//
// A menetdinamikai (hangolható) számok NEM itt vannak, hanem a
// vehicleTunables.js-ben — az a fájl csak sima export-lista, semmi logika,
// hogy a dev autó-tesztelő "Mentés fájlba" gombja pontosan ilyen tartalmat
// tudjon generálni, és felülírható legyen vele. Innen csak TOVÁBBADJUK őket
// (export ... from), hogy a többi fájlnak (main.js, dev.js, raceSim.js) ne
// kelljen tudnia a szétválasztásról — mindenki továbbra is a
// shared/vehicleConfig.js-ből importál, ugyanazokkal a nevekkel.
export {
  MAX_ENGINE_FORCE, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
  LINEAR_DAMPING, ANGULAR_DAMPING,
} from './vehicleTunables.js';
// Ugyanezek importként is kellenek: az `export ... from` csak TOVÁBBADJA a
// bindingot a hívóknak, de nem hoz létre helyi nevet — a lenti SUSPENSION
// objektumnak, a buildVehicle/applyControls-nak és az élő hangoló
// mechanizmusnak ITT, ebben a fájlban is szüksége van rájuk.
import {
  MAX_ENGINE_FORCE, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
  SUSPENSION_STIFFNESS, SUSPENSION_COMPRESSION, SUSPENSION_RELAXATION, SUSPENSION_MAX_TRAVEL,
  LINEAR_DAMPING, ANGULAR_DAMPING,
} from './vehicleTunables.js';

export const GRAVITY = { x: 0, y: -9.81, z: 0 };

// ---------- Pálya-ütköző csoportok: talaj vs. fal ----------
// A kerék-sugár (updateVehicle raycast) csak a talajt "látja" — a felfüggesztés
// magasságát méri, sosem oldalra. Ha a falat is látná, a majdnem-vízszintes
// fal-tetőkbe/párkányokba akadna bele a felfüggesztés-számítás. A kasztni
// dobozának normál ütközője viszont MINDKÉT csoporttal ütközik (nincs rajta
// szűrés), így a fal ellen a kasztni test fizikailag megáll, a kerék-sugár
// pedig zavartalanul a talajt méri alatta.
//
// InteractionGroups egy 32 bites szám: a felső 16 bit a tagság (groups), az
// alsó 16 bit a szűrő (mask). Két fél ütközik, ha A tagsága metszi B szűrőjét
// ÉS B tagsága metszi A szűrőjét — lásd a Rapier interaction_groups.d.ts-ét.
export const COLLISION_GROUP_FLOOR = 0x0001;
export const COLLISION_GROUP_WALL = 0x0002;
const GROUPS_ALL_MASK = 0xffff;
export const FLOOR_COLLIDER_GROUPS = (COLLISION_GROUP_FLOOR << 16) | GROUPS_ALL_MASK;
export const WALL_COLLIDER_GROUPS = (COLLISION_GROUP_WALL << 16) | GROUPS_ALL_MASK;
// A kerék-sugár lekérdezés "önmaga" groups/mask párja: tagság = minden (hogy
// bármelyik collider szűrőjén átjusson), szűrő = csak a talaj csoportja (hogy
// csak a talaj colliderek tagsága illeszkedjen rá).
export const WHEEL_RAY_FILTER_GROUPS = (GROUPS_ALL_MASK << 16) | COLLISION_GROUP_FLOOR;

// Fél-méretek: szélesség/2, magasság/2, hossz/2.
export const CHASSIS_SIZE = { x: 1.0, y: 0.4, z: 2.2 };
export const CHASSIS_MASS = 250;

// Ez alatt a sebesség (m/s) alatt számít az S/le nyíl VALÓDI hátramenetnek —
// fölötte fékezésnek. Sok versenyjátékban megszokott: az "S" gomb előre
// haladva fékez, és csak megálláshoz közel kezd tényleg hátramenetbe váltani.
// Anélkül az S/le nyíl a gyenge REVERSE_FACTOR-ral szorzott motorerővel
// próbálna "fékezni" — ami töredéke a valódi féknek (wheelBrake), és pont ez
// okozta az "S alig fékez" élményt.
export const REVERSE_BRAKE_THRESHOLD = 1.5;

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
// irreálisan erős fék (BRAKE_FRONT=70, ~5.6 G) mellett ez már nem volt elég:
// mérve, egyenes vonalban 200 km/h-ról fékezve a kocsi 1,05 másodperc alatt
// teljesen előre bukott (upright -1.0). Minél lejjebb van a súlypont, annál
// nagyobb fékező nyomatékot visel el a kocsi borulás nélkül — méréssel a 0.55
// már tökéletesen stabil (upright 0.999) UGYANAZZAL a fékerővel, és mellékesen
// a kanyarodást is javítja (szögsebesség +53% ugyanannál a kormányszögnél,
// alacsonyabb súlyponttal kevesebb a bólintás/dőlés, ami elviszi az energiát).
// A fék azóta reálisra csökkent (32/27, ~3 G), tehát ez most bőven tartalék.
export const COM_DROP = 0.55;

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
export const HOLD_BRAKE = 60;
// Kifutón (fű/kavics) kevesebb erő jut a talajra és csúszósabb is.
export const OFFTRACK_FRICTION_SLIP = 1.0;
export const OFFTRACK_FORCE_FACTOR = 0.75;
export const OFFTRACK_DRAG = 0.995;

// ---------- Csúcssebesség-plafon ----------
// Ez VALÓDI, aktív korlát, nem csak vészfék a szélsőségekre: mérve, sík
// talajon, teljes gázzal a kocsi magától ~633 km/h-ig gyorsul (a plafont
// ~19 mp folyamatos gáz után éri el). Az ok, hogy a LINEAR_DAMPING
// sebességARÁNYOS, a valódi légellenállás viszont a sebesség NÉGYZETÉvel nő —
// a csillapítás ezért nagy sebességen messze alulfékez, és a végsebesség
// irreálisan magasra szalad. A plafon ezt vágja vissza, és mellékesen a
// hosszú lejtőn/ütközés lökésétől elszaladó kocsit is megfogja.
//
// Ez NEM hangolható a dev panelről (nincs hozzá csúszka), ezért nem is a
// vehicleTunables.js-ben van: azt a fájlt a panel "Mentés fájlba" gombja
// egészében újragenerálja a csúszkákból, és egy ott felejtett, csúszka nélküli
// konstans az első mentésnél nyomtalanul eltűnne.
export const MAX_SPEED_KMH = 378;
export const MAX_SPEED = MAX_SPEED_KMH / 3.6;

// Kizárólag a VÍZSZINTES sebességet korlátozza — pont azt a számot, amit a
// sebességmérő is mutat (Math.hypot(vx, vz) * 3.6). A függőleges komponens
// szándékosan érintetlen: az esést nem szabad lefékezni, különben a kocsi
// lassítva lebegne le a magasabb pályaelemekről.
//
// A világ léptetése UTÁN kell hívni, ugyanúgy, mint a zone.js
// applyWallConstraint-jét — mindkettő a kész sebességre ható kényszer, nem
// vezérlő-bemenet, ezért nincs helyük az applyControls-ban. Mindhárom hívási
// helyen ugyanabban a sorrendben kell futniuk (egyjátékos animate,
// kliens-oldali jóslás stepLocalPhysics, szerver raceSim.step), különben a
// jóslat elcsúszna a szerver igazságától.
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
  MAX_ENGINE_FORCE, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
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

// Egy kocsi felépítése a Rapier világban. Ugyanaz a kód fut a kliensen és a
// szerveren, hogy a két szimuláció egyforma legyen.
export function buildVehicle(RAPIER, world, position = { x: 0, y: 5, z: 0 }) {
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
    RAPIER.ColliderDesc.cuboid(CHASSIS_SIZE.x, CHASSIS_SIZE.y, CHASSIS_SIZE.z).setMass(CHASSIS_MASS),
    body
  );

  const m = CHASSIS_MASS;
  const w = CHASSIS_SIZE.x * 2, h = CHASSIS_SIZE.y * 2, d = CHASSIS_SIZE.z * 2;
  collider.setMassProperties(
    m,
    { x: 0, y: -COM_DROP, z: 0 },
    { x: (m / 12) * (h * h + d * d), y: (m / 12) * (w * w + d * d), z: (m / 12) * (w * w + h * h) },
    { x: 0, y: 0, z: 0, w: 1 }
  );
  // A collider tömegadatainak átírása magától nem frissíti a merev testét.
  body.recomputeMassPropertiesFromColliders();

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
//   throttle: -1..1 (negatív = hátramenet), steer: -1..1, brake/hold: bool
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

  // Kifutón az első/hátsó arány is ugyanúgy megmarad, csak lejjebb tolva.
  const frontRatio = live.FRONT_FRICTION_SLIP / live.REAR_FRICTION_SLIP;
  const slipOf = (i) =>
    (wheelsOff[i] ? OFFTRACK_FRICTION_SLIP : live.REAR_FRICTION_SLIP) * (i < 2 ? frontRatio : 1);
  for (let i = 0; i < 4; i++) vehicle.setWheelFrictionSlip(i, slipOf(i));
  // A kézifékhez a HÁTSÓ tengely tapadása a viszonyítás (lásd lentebb).
  const slip = Math.min(slipOf(2), slipOf(3));

  if (offFrac > 0) {
    // Arányosan: négy kerékkel a füvön a régi 0.995, kettővel a fele annyi
    // lassítás — a rázókövet súrolva nem esik ki a kocsi alól a sebesség.
    const drag = 1 - (1 - OFFTRACK_DRAG) * offFrac;
    const v = body.linvel();
    body.setLinvel({ x: v.x * drag, y: v.y, z: v.z * drag }, true);
  }

  const forceFactor = 1 - (1 - OFFTRACK_FORCE_FACTOR) * offFrac;
  const throttle = frozen ? 0 : Math.max(-1, Math.min(1, input.throttle || 0));
  const force = (throttle >= 0 ? throttle : throttle * live.REVERSE_FACTOR) * live.MAX_ENGINE_FORCE * forceFactor;
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
  // érzésre. BRAKE_FRONT/REAR: 200 km/h → 0-ig 27/23 = 2.20 s / 59 m / 2.58 G
  // (valós F1: 2.2 s / 62 m / 2.6 G); a korábbi 70/60 = 1.02 s / 5.58 G volt —
  // irreálisan erős, és ~50 fölött a kerék blokkol (csúszó gumi kevesebb erőt
  // visz át), ezért nem is lehetett feljebb hangolni vele. HANDBRAKE_FORCE és
  // HANDBRAKE_REAR_SLIP egymástól FÜGGETLENÜL hat: az erő csak a lassítást
  // szabja (22 → 4.68 s), a tapadás csak a pörgést (~280°/s) — ezért lehet a
  // kéziféket lassításra szándékosan gyengén, forgatásra viszont erősen hagyni.
  if (frozen) {
    for (let i = 0; i < 4; i++) vehicle.setWheelBrake(i, HOLD_BRAKE);
    return;
  }

  const braking = !!input.brake;
  vehicle.setWheelBrake(0, braking ? live.BRAKE_FRONT : 0);
  vehicle.setWheelBrake(1, braking ? live.BRAKE_FRONT : 0);

  let rearBrake = braking ? live.BRAKE_REAR : 0;
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
