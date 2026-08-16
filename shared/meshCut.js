// Objektumvágás letöltött pályamodellekből.
//
// A Sketchfab-modellek anyagonként ÖSSZEOLVASZTVA érkeznek: egyetlen hálóban
// ott a fél pálya és mellette a placeholder dobozok. Csomópontot törölni tehát
// nem lehet, mert valódi geometria is menne vele. Ami viszont megkülönbözteti
// őket, az az, hogy a dobozok külön ÖSSZEFÜGGŐ darabok — nem osztoznak csúccsal
// a környezetükkel. Ez a modul ilyen darabokat keres és tüntet el.
//
// Az eltüntetés nem törlés, hanem ELFAJULT háromszög: mindhárom index ugyanarra
// a csúcsra mutat, aminek nincs felülete, a GPU eldobja. Ennek az a lényege,
// hogy a puffer HOSSZA nem változik — így a GLB-ben helyben, bájtra pontosan
// javítható az indextartomány, és a fájl minden más része (textúrák,
// kiterjesztések, eltolások) érintetlen marad. Újrakódolás nélkül.

// Azonos pozíciójú csúcsok összevonása. Enélkül egy varrat mentén (ahol az UV
// vagy a normális miatt duplázott a csúcs) a darab kettészakadna, és a vágás
// csak a felét vinné.
export function mergeByPosition(position, decimals = 3) {
  const skala = 10 ** decimals;
  const rep = new Int32Array(position.count);
  const latott = new Map();
  for (let i = 0; i < position.count; i++) {
    const kulcs = `${Math.round(position.getX(i) * skala)},${Math.round(position.getY(i) * skala)},${Math.round(position.getZ(i) * skala)}`;
    const elso = latott.get(kulcs);
    if (elso === undefined) { latott.set(kulcs, i); rep[i] = i; } else { rep[i] = elso; }
  }
  return rep;
}

// Unió-holvan: melyik háromszögek tartoznak egy darabba? A `faceIndex` a
// raycast által eltalált háromszög sorszáma.
export function componentAtFace(indexArray, rep, faceIndex) {
  const szulo = Int32Array.from(rep);
  const find = (a) => { while (szulo[a] !== a) { szulo[a] = szulo[szulo[a]]; a = szulo[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) szulo[b] = a; };
  const haromszogek = indexArray.length / 3;
  for (let t = 0; t < haromszogek; t++) {
    const a = rep[indexArray[t * 3]], b = rep[indexArray[t * 3 + 1]], c = rep[indexArray[t * 3 + 2]];
    uni(a, b); uni(a, c);
  }
  const gyoker = find(rep[indexArray[faceIndex * 3]]);
  const faces = [];
  const vertices = new Set();
  for (let t = 0; t < haromszogek; t++) {
    if (find(rep[indexArray[t * 3]]) !== gyoker) continue;
    faces.push(t);
    vertices.add(indexArray[t * 3]);
    vertices.add(indexArray[t * 3 + 1]);
    vertices.add(indexArray[t * 3 + 2]);
  }
  return { faces, vertices };
}

// A darab befoglaló doboza — ebből látszik a képernyőn, mekkorát jelöltél ki.
export function boundsOfVertices(position, vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    const p = [position.getX(v), position.getY(v), position.getZ(v)];
    for (let t = 0; t < 3; t++) { min[t] = Math.min(min[t], p[t]); max[t] = Math.max(max[t], p[t]); }
  }
  return {
    min, max,
    size: [0, 1, 2].map((t) => max[t] - min[t]),
    center: [0, 1, 2].map((t) => (min[t] + max[t]) / 2),
  };
}

// Elfajulttá tétel a betöltött geometrián (élő előnézet), illetve visszavonás.
export function degenerateFaces(indexArray, faces) {
  const eredeti = [];
  for (const t of faces) {
    eredeti.push([t, indexArray[t * 3 + 1], indexArray[t * 3 + 2]]);
    indexArray[t * 3 + 1] = indexArray[t * 3];
    indexArray[t * 3 + 2] = indexArray[t * 3];
  }
  return eredeti;
}
export function restoreFaces(indexArray, eredeti) {
  for (const [t, b, c] of eredeti) {
    indexArray[t * 3 + 1] = b;
    indexArray[t * 3 + 2] = c;
  }
}

// ---- GLB-oldal ----

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function parseGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Nem GLB fájl.');
  let o = 12, json = null, binStart = 0, binLength = 0;
  while (o < bytes.byteLength) {
    const len = dv.getUint32(o, true);
    const tipus = dv.getUint32(o + 4, true);
    if (tipus === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(o + 8, o + 8 + len)));
    } else if (tipus === CHUNK_BIN) {
      binStart = o + 8; binLength = len;
    }
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('A GLB-ben nincs JSON darab.');
  return { json, binStart, binLength };
}

// Miért nem tudunk mindent vágni: a tömörített geometria indexei nem
// olvashatók közvetlenül a pufferből, azokat előbb ki kellene bontani.
export function cutBlocker(primitive) {
  if (primitive.extensions?.KHR_draco_mesh_compression) return 'Draco-tömörített geometria';
  if (primitive.extensions?.EXT_meshopt_compression) return 'meshopt-tömörített geometria';
  if (primitive.indices === undefined) return 'index nélküli geometria';
  return null;
}

// Az elfajulttá tétel a GLB nyers bájtjaiban. A visszaadott szám a ténylegesen
// átírt háromszögek darabszáma.
export function patchGlbFaces(bytes, glb, accessorIndex, faces) {
  const acc = glb.json.accessors[accessorIndex];
  const view = glb.json.bufferViews[acc.bufferView];
  const meret = { 5121: 1, 5123: 2, 5125: 4 }[acc.componentType];
  if (!meret) throw new Error(`Ismeretlen indextípus: ${acc.componentType}`);
  const start = glb.binStart + (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const olvas = (k) => (meret === 4 ? dv.getUint32(start + k * 4, true)
    : meret === 2 ? dv.getUint16(start + k * 2, true) : dv.getUint8(start + k));
  const ir = (k, v) => (meret === 4 ? dv.setUint32(start + k * 4, v, true)
    : meret === 2 ? dv.setUint16(start + k * 2, v, true) : dv.setUint8(start + k, v));
  let db = 0;
  for (const t of faces) {
    if (t * 3 + 2 >= acc.count) continue;
    const a = olvas(t * 3);
    ir(t * 3 + 1, a);
    ir(t * 3 + 2, a);
    db++;
  }
  return db;
}
