// A main.js setCar+buildWheelPivots logikájának offline replikája.
import { primitives, readAccessor, xf } from './glb.mjs';

const CHASSIS_Z = 2.2;

export function normalize(path, yawDegrees = 0) {
  const { prims, g, bin } = primitives(path);
  // teljes bbox
  const b = (ps) => {
    const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
    ps.forEach((p) => { for (let k = 0; k < 3; k++) { if (p.min[k] < mn[k]) mn[k] = p.min[k]; if (p.max[k] > mx[k]) mx[k] = p.max[k]; } });
    return { mn, mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  };
  const b0 = b(prims);
  const yaw = (b0.size[0] >= b0.size[2] ? Math.PI / 2 : 0) + (yawDegrees * Math.PI) / 180;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const rot = (p) => [cs * p[0] + sn * p[2], p[1], -sn * p[0] + cs * p[2]];
  // AABB újraszámolás a forgatás után (a 8 sarokból)
  const rotated = prims.map((p) => {
    const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
    for (let i = 0; i < 8; i++) {
      const c = rot([i & 1 ? p.max[0] : p.min[0], i & 2 ? p.max[1] : p.min[1], i & 4 ? p.max[2] : p.min[2]]);
      for (let k = 0; k < 3; k++) { if (c[k] < mn[k]) mn[k] = c[k]; if (c[k] > mx[k]) mx[k] = c[k]; }
    }
    return { ...p, min: mn, max: mx };
  });
  const b1 = b(rotated);
  const scale = b1.size[2] > 0 ? (CHASSIS_Z * 2) / b1.size[2] : 1;
  const out = rotated.map((p) => {
    const min = p.min.map((v) => v * scale), max = p.max.map((v) => v * scale);
    return { ...p, min, max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
  });
  return { prims: out, g, bin, scale, yaw, carSize: b(out).size };
}

export const median = (v) => {
  const s = v.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Egy primitív háromszögeit negyedekre bontja (splitMergedWheelMesh replikája).
export function splitPrim(p, g, bin, midX, midZ, scale, yaw) {
  const prim = g.meshes[p.mesh].primitives[p.prim];
  const pos = readAccessor(g, bin, prim.attributes.POSITION);
  const idx = prim.indices !== undefined ? readAccessor(g, bin, prim.indices) : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  const m = p.matrix;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const groups = [[], [], [], []];
  const cents = [];
  for (let t = 0; t < triCount; t++) {
    let sx = 0, sz = 0, sy = 0;
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      const w = xf(m, [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]);
      const rx = (cs * w[0] + sn * w[2]) * scale, rz = (-sn * w[0] + cs * w[2]) * scale;
      sx += rx; sz += rz; sy += w[1] * scale;
    }
    const cx = sx / 3, cz = sz / 3;
    cents.push([cx, sy / 3, cz]);
    groups[(cz > midZ ? 0 : 1) * 2 + (cx > midX ? 1 : 0)].push(t);
  }
  const nonEmpty = groups.filter((gr) => gr.length > 0);
  if (nonEmpty.length < 2) return null;
  return nonEmpty.map((tris) => {
    const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
    tris.forEach((t) => { const c = cents[t]; for (let k = 0; k < 3; k++) { if (c[k] < mn[k]) mn[k] = c[k]; if (c[k] > mx[k]) mx[k] = c[k]; } });
    return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
      c: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], tris: tris.length };
  });
}

// A buildWheelPivots teljes replikája -> {ok, reason, groups}
export function evaluate(path, pattern, yawDegrees = 0) {
  const { prims, g, bin, scale, yaw, carSize } = normalize(path, yawDegrees);
  let re;
  try { re = new RegExp(pattern, 'i'); } catch (e) { return { ok: false, reason: 'bad regex' }; }
  const matches = prims.filter((p) => re.test(p.fullName + ' ' + p.mat));
  if (!matches.length) return { ok: false, reason: 'nincs találat', carSize };

  const gmX = median(matches.map((p) => p.c[0]));
  const gmZ = median(matches.map((p) => p.c[2]));

  const parts = [];
  matches.forEach((p) => {
    if (p.size[0] > 1.0 || p.size[2] > 1.0) {
      const sp = splitPrim(p, g, bin, gmX, gmZ, scale, yaw);
      if (sp) { sp.forEach((s) => parts.push({ ...s, src: p, volume: s.size[0] * s.size[1] * s.size[2] })); return; }
    }
    parts.push({ ...p, src: p, volume: p.size[0] * p.size[1] * p.size[2] });
  });
  if (parts.length < 2) return { ok: false, reason: 'kevesebb mint 2 darab', carSize };

  const xs = parts.map((p) => p.c[0]), zs = parts.map((p) => p.c[2]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanZ = Math.max(...zs) - Math.min(...zs);
  const midX = median(xs), midZ = median(zs);
  const axleMode = spanX < spanZ * 0.25;
  const sideRef = (v, mid) => {
    const hi = v.filter((x) => x > mid), lo = v.filter((x) => x < mid);
    return { hi: hi.length ? median(hi) : mid, lo: lo.length ? median(lo) : mid };
  };
  const zR = sideRef(zs, midZ), xR = sideRef(xs, midX);
  const nh = (v, r) => Math.abs(v - r.hi) <= Math.abs(v - r.lo);
  const groups = axleMode ? [[], []] : [[], [], [], []];
  parts.forEach((p) => {
    const rear = nh(p.c[2], zR) ? 0 : 1;
    if (axleMode) groups[rear].push(p);
    else groups[rear * 2 + (nh(p.c[0], xR) ? 1 : 0)].push(p);
  });
  if (groups.some((gr) => gr.length === 0)) return { ok: false, reason: 'üres csoport', axleMode, groups, carSize };

  // pivot + max kilengés 180 fokos forgatásnál (mint az élő teszt)
  const info = groups.map((gr) => {
    const anchor = gr.reduce((a, b) => (b.volume > a.volume ? b : a));
    const piv = anchor.c;
    // a csoport összes darabjának legtávolabbi sarka a pivottól, X/Z síkban
    let maxOff = 0, mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
    gr.forEach((p) => {
      for (let k = 0; k < 3; k++) { if (p.min[k] < mn[k]) mn[k] = p.min[k]; if (p.max[k] > mx[k]) mx[k] = p.max[k]; }
      // a darab közepének vízszintes távolsága a pivottól -> 180 fok forgatáskor 2x ennyit ugrik
      const d = Math.hypot(p.c[0] - piv[0], p.c[2] - piv[2]);
      if (d > maxOff) maxOff = d;
    });
    const bc = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    return { n: gr.length, pivot: piv.map((v) => +v.toFixed(2)),
      size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]].map((v) => +v.toFixed(2)),
      // mennyire ül a pivot a csoport bboxának közepén az Y-Z (forgás)síkban:
      // ha nem, a kerék forgás közben kileng
      off: +(Math.abs(bc[1] - piv[1]) + Math.abs(bc[2] - piv[2])).toFixed(2),
      // egy kerék Y és Z kiterjedése (átmérő) közel egyenlő; egy lengőkaré nem
      round: +Math.abs((mx[1] - mn[1]) - (mx[2] - mn[2])).toFixed(2),
      swing: +(maxOff * 2).toFixed(2) };
  });
  return { ok: true, axleMode, info, carSize: carSize.map((v) => +v.toFixed(2)),
    parts: parts.length, matched: matches.length };
}

export function dump(path, yawDegrees = 0) {
  const { prims, carSize } = normalize(path, yawDegrees);
  return { carSize: carSize.map((v) => +v.toFixed(2)), prims };
}
