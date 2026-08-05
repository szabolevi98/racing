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
export const MAX_STEER = 0.66;
export const BRAKE_FRONT = 70;
export const BRAKE_REAR = 60;
export const HANDBRAKE_REAR_SLIP = 1.1;
export const FRONT_FRICTION_SLIP = 3;
export const REAR_FRICTION_SLIP = 2.9;
export const SUSPENSION_STIFFNESS = 30;
export const SUSPENSION_COMPRESSION = 4.4;
export const SUSPENSION_RELAXATION = 2.3;
export const SUSPENSION_MAX_TRAVEL = 0.3;
export const LINEAR_DAMPING = 0.05;
export const ANGULAR_DAMPING = 0.5;
