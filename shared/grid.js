// Hol áll a rajtrácson egy adott rajthely (slot) autója?
//
// Miért közös: a SZERVER ebből építi fel a fizikai világot, a KLIENS pedig
// ebből teszi a helyére a kocsit, amíg az első snapshot meg nem érkezik.
// Enélkül a kliens a menübeli kirakat-pózban maradna — ott a kocsi
// szándékosan 2 méterrel a talaj fölött lebeg —, és a játékos a rajt
// pillanatában egy pillanatra ott, a levegőben látná a saját autóját.
//
// Ha a két oldal külön számolná, egy elcsúszás azonnal ugráló rajtot okozna:
// a kliens az egyik helyre tenné a kocsit, a szerver első snapshotja a másikra.
import { CHASSIS_SIZE } from './vehicleConfig.js';

// Egymás mögé sorolt sorok távolsága. A kasztni hosszához kötve, hogy egy
// jövőbeli méretváltozásnál ne kelljen külön hangolni.
const ROW_GAP = CHASSIS_SIZE.z * 2.5;

export function gridSlotPose(spawns, slot) {
  const grid = spawns?.length ? spawns : [{ x: 0, z: 0, heading: 0 }];
  const index = Number.isFinite(slot) ? slot : 0;
  const base = grid[index % grid.length];
  const heading = base.heading || 0;
  // Ha több a játékos, mint a rajtpont, a fölös indulók HÁTRÉBB kerülnek —
  // különben egymásba születnének.
  const back = Math.floor(index / grid.length) * ROW_GAP;
  return {
    x: base.x - Math.sin(heading) * back,
    z: base.z - Math.cos(heading) * back,
    heading,
  };
}
