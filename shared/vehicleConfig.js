// A jármű- és világ-fizika minden számszerű beállítása, EGY helyen.
//
// Ez a fájl a böngészőben és a szerveren is fut. Ez nem kényelmi kérdés: az
// authoritative multiplayer csak akkor működik, ha a két oldal ugyanazt
// számolja. Ha egy érték csak az egyik oldalon változna, a kliens jóslata
// folyamatosan eltérne a szerver igazságától, és a kocsi ugrálna.
//
// (A Rapier build is bitre azonos a két oldalon: @dimforge/rapier3d-compat 0.14.0.)

export const GRAVITY = { x: 0, y: -9.81, z: 0 };

// Fél-méretek: szélesség/2, magasság/2, hossz/2.
export const CHASSIS_SIZE = { x: 1.0, y: 0.4, z: 2.2 };
export const CHASSIS_MASS = 250;

// A tömegközéppont alapból a doboz közepén ülne, ami a talaj fölött 0.85 —
// egy 4.4 hosszú kocsihoz képest irreálisan magas, és fékezéskor előrebuktatta
// az autót. Egy versenyautó súlypontja nagyjából a keréktengely magasságában van.
export const COM_DROP = 0.15;

// A Rapier nem csillapít alapból; enélkül a kocsi a legkisebb egyenetlenségen
// is pörögni kezdene.
export const LINEAR_DAMPING = 0.05;
export const ANGULAR_DAMPING = 0.5;

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

export const SUSPENSION = {
  stiffness: 30,
  compression: 4.4,
  relaxation: 2.3,
  maxTravel: 0.3,
  maxForce: 100000,
};

export const MAX_ENGINE_FORCE = 1100;
export const REVERSE_FACTOR = 0.6;
// Élesebb, gyorsabb bekanyarodás.
export const MAX_STEER = 0.66;

// A fék NEM lehet akármilyen erős: a Rapier a fékezést közvetlen impulzusként
// viszi fel, megkerülve a gumi tapadási határát. Egyforma 60-as érték 6.2 g-s
// lassulást adott, miközben a gumi ~1.4 g-t vinne át — ettől bukfencezett az
// autó egyenesben. Tengelyenként külön, mérsékeltebben fékezünk.
// A jelenlegi érték az ALÁBBI (megemelt) FRONT/REAR_FRICTION_SLIP-hez van
// méretezve: a nagyobb tapadási tartalék teszi biztonságossá az erősebb
// féket — ha a tapadást lejjebb vesszük, ezt is vissza kell venni, különben
// visszajön a bukfenc.
export const BRAKE_FRONT = 17;
export const BRAKE_REAR = 29;
// A drift nem a fékerőből jön, hanem abból, hogy a hátsó kerék elveszti az
// oldalirányú tapadását — ezért azt külön adjuk meg.
export const HANDBRAKE_REAR_SLIP = 1.1;
// Rajt előtt / verseny után a kocsit helyben kell tartani, akár lejtőn is.
export const HOLD_BRAKE = 60;

// Gyorsításkor a hátsó tengelyre tolódik a teher, az első kerekek alól
// "elfogy" a nyomóerő — emiatt egyenlő tapadásnál nagy sebességen gázzal
// alig fordul a kocsi (a kormányzás hatna, csak nincs alatta elég grip).
// Az első tengelynek ezért külön, magasabb tartalék tapadás jár, hogy a
// fordulóképesség gázadás közben is megmaradjon.
// Mindkét érték ~15%-kal feljebb az általános csúszás csökkentésére (ez adja
// a nagyobb féktávolság-biztonságot is, ld. BRAKE_FRONT/REAR) — az arányuk
// (első/hátsó) változatlan, hogy a gázos-forduló és a lift-off oversteer
// közti egyensúly, amit korábban erre hangoltunk, ne boruljon fel.
export const FRONT_FRICTION_SLIP = 2.0;
export const REAR_FRICTION_SLIP = 1.9;
export const ASPHALT_FRICTION_SLIP = REAR_FRICTION_SLIP;
// Kifutón (fű/kavics) kevesebb erő jut a talajra és csúszósabb is.
export const OFFTRACK_FRICTION_SLIP = 1.0;
export const OFFTRACK_FORCE_FACTOR = 0.75;
export const OFFTRACK_DRAG = 0.995;

// A látható kerék-kormányzás simán közelít a célértékhez (rad/mp). Csak a
// megjelenítést érinti, a fizikai kormányzás azonnali.
export const STEER_VISUAL_SPEED = 3.5;

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
export function applyControls(vehicle, body, input, { offtrack = false, frozen = false } = {}) {
  // Kifutón az első/hátsó arány is ugyanúgy megmarad, csak lejjebb tolva.
  const frontRatio = FRONT_FRICTION_SLIP / REAR_FRICTION_SLIP;
  const rearSlip = offtrack ? OFFTRACK_FRICTION_SLIP : REAR_FRICTION_SLIP;
  const frontSlip = rearSlip * frontRatio;
  const slip = rearSlip;
  vehicle.setWheelFrictionSlip(0, frontSlip);
  vehicle.setWheelFrictionSlip(1, frontSlip);
  vehicle.setWheelFrictionSlip(2, rearSlip);
  vehicle.setWheelFrictionSlip(3, rearSlip);

  if (offtrack) {
    const v = body.linvel();
    body.setLinvel({ x: v.x * OFFTRACK_DRAG, y: v.y, z: v.z * OFFTRACK_DRAG }, true);
  }

  const forceFactor = offtrack ? OFFTRACK_FORCE_FACTOR : 1;
  const throttle = frozen ? 0 : Math.max(-1, Math.min(1, input.throttle || 0));
  const force = (throttle >= 0 ? throttle : throttle * REVERSE_FACTOR) * MAX_ENGINE_FORCE * forceFactor;
  vehicle.setWheelEngineForce(2, force);
  vehicle.setWheelEngineForce(3, force);

  const steer = frozen ? 0 : Math.max(-1, Math.min(1, input.steer || 0)) * MAX_STEER;
  vehicle.setWheelSteering(0, steer);
  vehicle.setWheelSteering(1, steer);

  if (frozen) {
    for (let i = 0; i < 4; i++) vehicle.setWheelBrake(i, HOLD_BRAKE);
  } else if (input.brake) {
    vehicle.setWheelBrake(0, BRAKE_FRONT);
    vehicle.setWheelBrake(1, BRAKE_FRONT);
    vehicle.setWheelBrake(2, BRAKE_REAR);
    vehicle.setWheelBrake(3, BRAKE_REAR);
    const rear = Math.min(slip, HANDBRAKE_REAR_SLIP);
    vehicle.setWheelFrictionSlip(2, rear);
    vehicle.setWheelFrictionSlip(3, rear);
  } else {
    for (let i = 0; i < 4; i++) vehicle.setWheelBrake(i, 0);
  }
}
