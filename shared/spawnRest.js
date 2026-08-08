// Milyen magasan áll a kasztni középpontja a talaj fölött, amikor a kocsi
// NYUGALOMBAN ül a saját felfüggesztésén?
//
// Miért kell ez egyáltalán: a rajtnál a kocsit a pálya fölé kell tenni, mert a
// rajtkocka magasságát csak a talaj sugárral kereséséből tudjuk. Ha túl magasra
// tesszük, a kocsi ESIK egyet — ezt korábban 120 fizikai lépéssel ültettük le
// előre, ami egyetlen blokkban ~0,7 másodpercig megállította a teljes szervert
// (a Node egyszálú, tehát a többi szoba versenyét is). Ha viszont eleve a
// nyugalmi magasságba tesszük, nincs mit leültetni.
//
// Miért nem beégetett szám: ez az érték kizárólag a felfüggesztés hangolásától
// függ (shared/vehicleTunables.js), ami a dev autó-tesztelőből átírható és
// fájlba menthető. Egy konstans a következő hangolás után némán elavulna, és a
// kocsik újra pottyannának — pont azt hozná vissza, amit megszüntetünk.
// A pályától és az autótól viszont NEM függ: a buildVehicle minden kocsihoz
// ugyanazt a fizikát építi, autó-specifikus paramétert nem is kap.
//
// Ezért egyszer, futásidőben MEGMÉRJÜK: egy pehelysúlyú külön világban (egy sík
// talaj + egy kocsi) leültetünk egy autót, és megnézzük, hol állt meg. Ez az a
// leültetés, ami eddig minden rajtnál lefutott — most a folyamat életében
// egyszer fut le, üres világban.
import {
  GRAVITY, buildVehicle, applyControls, FLOOR_COLLIDER_GROUPS, WHEEL_RAY_FILTER_GROUPS,
  TRACK_FRICTION,
} from './vehicleConfig.js';
import { TICK_RATE } from './protocol.js';

// A mérés felső korlátja. Bőven a konvergencia fölött (mérve: ~40 lépés alatt
// beáll), de véges — egy elrontott hangolás se pörgesse itt a szervert.
const MAX_TICKS = 300;
// Ennyi egymás utáni lépésen át kell ekkora tartományon belül maradnia a
// magasságnak, hogy nyugalomnak tekintsük. Nem nulla: a felfüggesztés a
// végállapotban is remeg mikronokat.
const STILL_TICKS = 20;
const STILL_RANGE = 0.0002;

const NEUTRAL = Object.freeze({ steer: 0, throttle: 0, brake: false, handbrake: false, seq: 0 });
const ALL_ON_TRACK = [false, false, false, false];
// A talaj felső lapja legyen y=0-n: a doboz feleakkora magassággal lejjebb kerül.
const GROUND_HALF = 5;
const GROUND_EXTENT = 40;

let cached = null;

// A tényleges mérés. Külön világ, ami a végén fel is szabadul — semmit nem
// hagyunk a hívó világában.
function measure(RAPIER) {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = 1 / TICK_RATE;
  try {
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(GROUND_EXTENT, GROUND_HALF, GROUND_EXTENT)
        .setTranslation(0, -GROUND_HALF, 0)
        .setFriction(TRACK_FRICTION)
        .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
      ground
    );

    // Magasabbról indítjuk, mint amennyi a nyugalmi helyzet lehet — ezt épp most
    // akarjuk megtudni, tehát felülről kell közelíteni.
    const { body, vehicle } = buildVehicle(RAPIER, world, { x: 0, y: 2, z: 0 });
    const recent = [];
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      applyControls(vehicle, body, NEUTRAL, { frozen: true, offtrackWheels: ALL_ON_TRACK });
      vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
      world.step();
      recent.push(body.translation().y);
      if (recent.length > STILL_TICKS) recent.shift();
      if (recent.length === STILL_TICKS
        && Math.max(...recent) - Math.min(...recent) < STILL_RANGE) break;
    }
    // A talaj felső lapja y=0, tehát a kasztni magassága maga a végső y.
    return body.translation().y;
  } finally {
    world.free();
  }
}

// A nyugalmi kasztni-magasság a talaj felett, méterben. Az első hívás megméri,
// utána gyorsítótárból jön.
export function restHeightAboveGround(RAPIER) {
  if (cached === null) cached = measure(RAPIER);
  return cached;
}

// Csak tesztekhez: a következő hívás mérjen újra (pl. módosított hangolással).
export function forgetRestHeight() {
  cached = null;
}
