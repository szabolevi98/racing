// Minimál GLB/glTF olvasó: node-hierarchia + világ-AABB primitívenként.
import fs from 'fs';

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function loadGlb(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glb');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4) * 0;
    off = off + ((4 - (off % 4)) % 4);
  }
  return { json, bin };
}

export function readAccessor(g, bin, idx) {
  const a = g.accessors[idx];
  const nc = NC[a.type];
  const [Arr, sz] = CT[a.componentType];
  const out = new Float32Array(a.count * nc);
  if (a.bufferView === undefined) return out;
  const bv = g.bufferViews[a.bufferView];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || nc * sz;
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < nc; c++) {
      const p = o + c * sz;
      let v;
      switch (a.componentType) {
        case 5126: v = bin.readFloatLE(p); break;
        case 5125: v = bin.readUInt32LE(p); break;
        case 5123: v = bin.readUInt16LE(p); break;
        case 5122: v = bin.readInt16LE(p); break;
        case 5121: v = bin.readUInt8(p); break;
        case 5120: v = bin.readInt8(p); break;
      }
      out[i * nc + c] = v;
    }
  }
  return out;
}

function mul(a, b) { // column-major 4x4
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function trs(n) {
  if (n.matrix) return Float64Array.from(n.matrix);
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return Float64Array.from([
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}
export function xf(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// Minden primitívre: névlánc, anyagnév, világ-AABB.
export function primitives(path) {
  const { json: g, bin } = loadGlb(path);
  const out = [];
  const scene = g.scenes[g.scene || 0];
  const walk = (ni, parentM, chain) => {
    const n = g.nodes[ni];
    const m = mul(parentM, trs(n));
    const ch = n.name ? chain + ' ' + n.name : chain;
    if (n.mesh !== undefined) {
      const mesh = g.meshes[n.mesh];
      const mch = mesh.name ? ch + ' ' + mesh.name : ch;
      mesh.primitives.forEach((p, pi) => {
        const acc = g.accessors[p.attributes.POSITION];
        const mat = p.material !== undefined ? (g.materials[p.material].name || '') : '';
        const lo = acc.min, hi = acc.max;
        let min = [1e30, 1e30, 1e30], max = [-1e30, -1e30, -1e30];
        for (let i = 0; i < 8; i++) {
          const c = xf(m, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
          for (let k = 0; k < 3; k++) { if (c[k] < min[k]) min[k] = c[k]; if (c[k] > max[k]) max[k] = c[k]; }
        }
        out.push({ node: ni, prim: pi, mesh: n.mesh, name: ch.trim(), fullName: mch.trim(), mat, min, max,
          size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
          c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
          count: acc.count, matrix: Array.from(m) });
      });
    }
    (n.children || []).forEach((c) => walk(c, m, ch));
  };
  (scene.nodes || []).forEach((ni) => walk(ni, Float64Array.from([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), ''));
  return { prims: out, g, bin };
}
