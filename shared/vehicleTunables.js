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

// A 600 kg-os közös F1-profil kerékenkénti, kis sebességű erőplafonja. Nagy
// tempónál az összteljesítmény korlátoz (MAX_ENGINE_POWER), nem ez a szám.
export const MAX_ENGINE_FORCE = 3400;
// A két hajtott kerékre együtt jutó mechanikai teljesítmény wattban. Ez teszi
// lehetővé, hogy a motorerő nagy sebességnél természetesen csökkenjen.
export const MAX_ENGINE_POWER = 660000;
export const REVERSE_FACTOR = 0.6;
export const MAX_STEER = 0.38;
export const BRAKE_FRONT = 65;
export const BRAKE_REAR = 55;
export const HANDBRAKE_FORCE = 53;
export const HANDBRAKE_REAR_SLIP = 1.1;
export const FRONT_FRICTION_SLIP = 3;
export const REAR_FRICTION_SLIP = 3.5;
// A teljesen elkopott gumi legnagyobb tapadásvesztesége. A köztes állapotokat
// a tireWear.js sima görbéje számolja; ezek a dev vezetési tesztben élőben
// hangolhatók és a többi menetdinamikai értékkel együtt menthetők.
export const TIRE_LONGITUDINAL_MAX_LOSS = 0.25;
export const TIRE_LATERAL_MAX_LOSS = 0.35;
export const SUSPENSION_STIFFNESS = 70;
export const SUSPENSION_COMPRESSION = 5;
export const SUSPENSION_RELAXATION = 3.5;
export const SUSPENSION_MAX_TRAVEL = 0.3;
// F = k * v^2. A drag a vízszintes sebességgel ellentétes, a downforce
// világ-koordinátában lefelé mutat. Így stabil, árkádos F1-érzetet ad akkor is,
// ha a kasztni egy rázókövön kissé megdől.
export const AERO_DRAG_COEFFICIENT = 0.512;
export const AERO_DOWNFORCE_COEFFICIENT = 0.6;
// Csak enyhe numerikus/karosszéria-csillapítás marad; a nagysebességű lassulást
// már a fenti, fizikailag helyesebb négyzetes légellenállás végzi.
export const LINEAR_DAMPING = 0.01;
export const ANGULAR_DAMPING = 0.5;
