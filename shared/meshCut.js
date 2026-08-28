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

// Az index-akkumulátor nyers elérése a GLB bájtjaiban. Külön, mert két dolog
// is használja: az elfajulttá tétel és a lapsorszám-fordítás.
function glbIndexAccessor(bytes, glb, accessorIndex) {
  const acc = glb.json.accessors[accessorIndex];
  const view = glb.json.bufferViews[acc.bufferView];
  const meret = { 5121: 1, 5123: 2, 5125: 4 }[acc.componentType];
  if (!meret) throw new Error(`Ismeretlen indextípus: ${acc.componentType}`);
  const start = glb.binStart + (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    count: acc.count,
    olvas: (k) => (meret === 4 ? dv.getUint32(start + k * 4, true)
      : meret === 2 ? dv.getUint16(start + k * 2, true) : dv.getUint8(start + k)),
    ir: (k, v) => (meret === 4 ? dv.setUint32(start + k * 4, v, true)
      : meret === 2 ? dv.setUint16(start + k * 2, v, true) : dv.setUint8(start + k, v)),
  };
}

// Egy háromszög azonosítója a három csúcsából, a sorrendtől függetlenül.
function lapKulcs(a, b, c) {
  let x = a, y = b, z = c, t;
  if (x > y) { t = x; x = y; y = t; }
  if (y > z) { t = y; y = z; z = t; }
  if (x > y) { t = x; x = y; y = t; }
  return `${x},${y},${z}`;
}

// A JELENETBELI lapsorszámok lefordítása a GLB lapsorszámaira.
//
// Miért kell: a three-mesh-bvh a BVH építésekor HELYBEN átrendezi a geometria
// indextömbjét (mérve: 300 háromszögnél a 900 index-pozícióból 870 elmozdult).
// A vágás a jelenetben kiválasztott lapokra vonatkozik, a mentés viszont az
// eredeti fájlba ír — a két sorszámozás tehát nem ugyanaz. Fordítás nélkül a
// fájlban MÁS háromszögek fajulnak el, mint amiket a szerkesztőben kivágtál:
// a kivágott tárgy egy része visszatér, közben máshol csendben eltűnik
// geometria. Pontosan ez volt a "nem mindent ment el" tünet.
//
// A fordítás alapja a csúcshármas: a BVH csak SORRENDET cserél, az indexek
// ÉRTÉKÉT nem — ugyanaz a háromszög ugyanazzal a három csúccsal szerepel
// mindkét oldalon.
//
// Az azonos hármasok (ismétlődő háromszögek) listában állnak, és mindegyik
// csak EGYSZER használódik fel, hogy két vágás ne ugyanarra a lapra mutasson.
//
// A bemenet CSÚCSHÁRMASOK tömbje, nem lapsorszám: a jelenet indextömbje a
// vágás pillanatában már elfajulttá vált (mindhárom index azonos), tehát
// onnan a hármas már nem olvasható ki — a hívónak a visszavonás-adatból kell
// összeraknia.
export function mapTrianglesToGlb(bytes, glb, accessorIndex, triples) {
  const { count, olvas } = glbIndexAccessor(bytes, glb, accessorIndex);
  const tabla = new Map();
  for (let t = 0; t * 3 + 2 < count; t++) {
    const kulcs = lapKulcs(olvas(t * 3), olvas(t * 3 + 1), olvas(t * 3 + 2));
    const lista = tabla.get(kulcs);
    if (lista) lista.push(t); else tabla.set(kulcs, [t]);
  }
  const mapped = [];
  let hianyzo = 0;
  for (const [a, b, c] of triples) {
    const lista = tabla.get(lapKulcs(a, b, c));
    if (lista && lista.length) mapped.push(lista.shift());
    else hianyzo++;
  }
  return { mapped, hianyzo };
}

// Az elfajulttá tétel a GLB nyers bájtjaiban. A visszaadott szám a ténylegesen
// átírt háromszögek darabszáma.
export function patchGlbFaces(bytes, glb, accessorIndex, faces) {
  const { count, olvas, ir } = glbIndexAccessor(bytes, glb, accessorIndex);
  let db = 0;
  for (const t of faces) {
    if (t * 3 + 2 >= count) continue;
    const a = olvas(t * 3);
    ir(t * 3 + 1, a);
    ir(t * 3 + 2, a);
    db++;
  }
  return db;
}

// ---- Darab előrébb hozása (a matrica-villogás ellen) ----
//
// A letöltött pályamodelleken a hirdetőtáblák nyomata KÜLÖN lap a tábla lapja
// előtt, hajszálnyi réssel. A Hungaroringen mérve, a Pirelli-táblánál: két
// azonos méretű, 25.62 m²-es négyszög 0.101–0.348 mm-re egymástól. A mélységi
// puffer ezt nem tudja megkülönböztetni (200 méteren a felbontása 24 mm), ezért
// képkockánként váltakozik, melyik látszik.
//
// Miért a geometriát mozgatjuk, és nem a megjelenítést hangoljuk:
//
//   - a kamera `near` emelése 0.1-ről 0.5-re ötszörös felbontást ad, de a
//     0.1 mm-hez az sem elég;
//   - a logaritmikus mélységi puffer feloldaná, viszont GPU-időben MÉRVE
//     +67% (1920×1080) és +113% (3840×2160), mert a töredék maga írja a
//     mélységet, ami kikapcsolja a korai mélységi elvetést;
//   - a `polygonOffset` ingyen van, de csak ANYAGRA adható, a modell egy-egy
//     anyaga pedig a pálya sok felületén osztozik: a Hungaroringen a szóban
//     forgó anyag lapjai 25 különböző irányba néznek, és mind a 25 iránynak van
//     szemben néző párja is. Ugyanaz az anyag elöl lévő felirat az egyik
//     táblán és hátlap a szemköztin — egyetlen eltolás a felét elrontaná.
//
// A darab-szintű mozgatás viszont pont akkora, amekkora a probléma: egy
// összefüggő darab EGY tábla felirata. És ugyanúgy helyben javítható, mint a
// vágás: a POSITION float32, tehát a fájl mérete nem változik.

/** A kijelölt csúcsok elmozdítása. Visszaadja a visszavonáshoz az eredetit. */
export function nudgeVertices(positionArray, vertices, delta) {
  const eredeti = [];
  for (const v of vertices) {
    const i = v * 3;
    eredeti.push([v, positionArray[i], positionArray[i + 1], positionArray[i + 2]]);
    positionArray[i] += delta[0];
    positionArray[i + 1] += delta[1];
    positionArray[i + 2] += delta[2];
  }
  return eredeti;
}

export function restoreVertices(positionArray, eredeti) {
  for (const [v, x, y, z] of eredeti) {
    positionArray[v * 3] = x;
    positionArray[v * 3 + 1] = y;
    positionArray[v * 3 + 2] = z;
  }
}

// A POSITION nyers elérése a GLB bájtjaiban. A `byteStride` azért kell, mert az
// attribútumok lehetnek egymásba fűzve (interleaved) — olyankor a csúcsok nem
// szorosan követik egymást.
function glbPositionAccessor(bytes, glb, accessorIndex) {
  const acc = glb.json.accessors[accessorIndex];
  if (acc.componentType !== 5126) {
    throw new Error('A POSITION nem float32 — így nem javítható helyben.');
  }
  const view = glb.json.bufferViews[acc.bufferView];
  const stride = view.byteStride || 12;
  const start = glb.binStart + (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    count: acc.count,
    acc,
    olvas: (v, k) => dv.getFloat32(start + v * stride + k * 4, true),
    ir: (v, k, x) => dv.setFloat32(start + v * stride + k * 4, x, true),
  };
}

/**
 * A csúcsmozgatás beírása a GLB bájtjaiba.
 *
 * A jelenetbeli csúcssorszám itt — a lapsorszámmal ELLENTÉTBEN — közvetlenül
 * használható: a three-mesh-bvh az INDEXTÖMBÖT rendezi át, a pozíciótömböt nem.
 *
 * A visszaadott `kilog` azt jelzi, hogy a mozgatás kilépett-e az accessor
 * deklarált befoglaló dobozából. A min/max mezőket szándékosan NEM írjuk át:
 * az a JSON-darab hosszát változtatná, és elveszne a bájtpontos, helyben
 * javítás. Egy pályányi méretű összeolvasztott hálón belül néhány centi
 * gyakorlatilag sosem lép ki — de ha mégis, arról a hívó tudjon.
 */
export function patchGlbPositions(bytes, glb, accessorIndex, moves) {
  const { count, acc, olvas, ir } = glbPositionAccessor(bytes, glb, accessorIndex);
  const min = acc.min, max = acc.max;
  let db = 0, kilog = 0;
  for (const [v, x, y, z] of moves) {
    if (v < 0 || v >= count) continue;
    const uj = [x, y, z];
    for (let k = 0; k < 3; k++) {
      if (min && max && (uj[k] < min[k] || uj[k] > max[k])) { kilog++; break; }
    }
    for (let k = 0; k < 3; k++) ir(v, k, uj[k]);
    db++;
  }
  // `olvas` a hívó ellenőrzéséhez marad elérhető a visszatérésben.
  return { db, kilog, olvas };
}

// ---- Az elmozgatott csúcsok befoglalójának frissítése ----
//
// A `patchGlbPositions` bájtpontosan írja át a koordinátákat, de az accessor
// `min`/`max` mezője a glTF-ben KÜLÖN, a JSON-ban él — az így elavul. A hiba
// csendes: a Three.js ebből a két mezőből veszi a `boundingBox`-ot, tehát a
// látótér-vágás és a sugárvetés egy a valóságosnál szűkebb dobozzal dolgozik.
//
// Mérve a Hungaroringen, öt eltolt reklámtáblán: a tárolt befoglaló 3,1 és
// 10,0 cm közt tért el a tényleges adattól. A kiszolgált modellen ez nem
// látszott, mert a gltfpack újraszámolja — a masterben viszont ott maradt, és
// dev módban éppen azt töltjük be.
//
// A javítás nem lehet bájtpontos folt: a számok szöveges hossza változik,
// tehát a JSON-darabbal együtt a fájlt újra kell építeni. A BIN egyetlen
// bájtja sem mozdul.
export function refreshPositionBounds(bytes, glb, accessorIndexek) {
  const json = JSON.parse(JSON.stringify(glb.json));
  const frissitve = [];
  for (const idx of new Set(accessorIndexek)) {
    const { count, olvas } = glbPositionAccessor(bytes, glb, idx);
    if (!count) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      for (let k = 0; k < 3; k++) {
        const x = olvas(v, k);
        if (x < min[k]) min[k] = x;
        if (x > max[k]) max[k] = x;
      }
    }
    const cel = json.accessors[idx];
    const azonos = Array.isArray(cel.min) && Array.isArray(cel.max)
      && min.every((x, k) => x === cel.min[k])
      && max.every((x, k) => x === cel.max[k]);
    if (azonos) continue;
    let elteres = 0;
    if (Array.isArray(cel.min) && Array.isArray(cel.max)) {
      for (let k = 0; k < 3; k++) {
        elteres = Math.max(elteres, Math.abs(min[k] - cel.min[k]), Math.abs(max[k] - cel.max[k]));
      }
    }
    cel.min = min;
    cel.max = max;
    frissitve.push({ accessor: idx, elteres });
  }
  if (!frissitve.length) return null;
  return { bytes: rebuildWithJson(bytes, glb, json), frissitve };
}

// Új GLB ugyanabból a BIN-ből, cserélt JSON-nal.
function rebuildWithJson(bytes, glb, json) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = padTo4(jsonBytes.byteLength);
  const bin = bytes.subarray(glb.binStart, glb.binStart + glb.binLength);
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  // A JSON-darab kitöltése SZÓKÖZ — ezt a glTF előírja.
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jsonPad);
  const binChunk = 20 + jsonBytes.byteLength + jsonPad;
  dv.setUint32(binChunk, bin.byteLength, true);
  dv.setUint32(binChunk + 4, 0x004e4942, true);
  out.set(bin, binChunk + 8);
  return out;
}

// ---- Darab áthelyezése másik anyag alá ----
//
// A Suzukán az aszfalt néhol átlátszó, és ez NEM megjelenítési hiba: az
// érintett felületek a `Merged_materials` anyagot viselik, aminek a textúrája
// csempézett LOMBOZAT — 256×256, a látható rész átlaga rgb(55, 66, 40), a
// képpontok 53,6%-a teljesen átlátszó, a lyukak alatt fekete. A betöltő már a
// lehető legjobbat csinálja vele (maszknak ismeri fel, alphaTest + depthWrite).
//
// Kivágni nem lehet: mérve a két darab lapjainak 64%-a és 81%-a alatt NINCS
// másik felület, tehát ők MAGUK a vezetett út — a kivágás lyukat hagyna, és az
// autó átesne rajta.
//
// Anyagot cserélni sem lehet a meglévő szinteken:
//   - az ANYAG szintjén: a `Merged_materials` lapjainak ~85%-a függőleges,
//     azaz valódi lombkártya — a fák mennének tönkre;
//   - a PRIMITÍV szintjén: a 725 háromszöges darab egy 7549 háromszögből és
//     520 összefüggő darabból álló primitívben ül.
//
// Marad a helyes szemcsézettség: a darabot SAJÁT PRIMITÍVBE emeljük, és annak
// adunk rendes aszfalt-anyagot. Az új primitív az EREDETI attribútum-
// accessorokra hivatkozik (pozíció, UV, normális), csak az indexei újak — így
// egyetlen csúcsot sem duplázunk, csak a háromszöglistát.
//
// Ez az egyetlen művelet a fájlban, ami NEM bájtpontos folt: a JSON hossza és a
// fájl mérete változik, ezért a GLB-t újra kell építeni. Cserébe minden más
// bájt (textúrák, kiterjesztések, a teljes eredeti BIN) érintetlen marad.

const GLB_MAGIC = 0x46546c67;

function padTo4(n) { return (4 - (n % 4)) % 4; }

/**
 * Új primitív a megadott háromszögekből, másik anyaggal.
 *
 * @param triples csúcshármasok tömbje (ugyanaz a formátum, amit a
 *   mapTrianglesToGlb vár) — a hívó a visszavonás-adatból rakja össze.
 * @returns {Uint8Array} az ÚJ GLB bájtjai. Az eredeti tömb érintetlen.
 */
export function addPrimitiveWithMaterial(bytes, glb, {
  meshIndex, primitiveIndex, triples, materialIndex,
}) {
  const json = JSON.parse(JSON.stringify(glb.json));
  const forras = json.meshes?.[meshIndex]?.primitives?.[primitiveIndex];
  if (!forras) throw new Error('Nincs ilyen primitív.');
  if (!forras.attributes?.POSITION && forras.attributes?.POSITION !== 0) {
    throw new Error('A forrás primitívnek nincs POSITION attribútuma.');
  }
  if (!triples?.length) throw new Error('Nincs áthelyezendő háromszög.');
  if (!json.materials?.[materialIndex]) throw new Error('Nincs ilyen anyag.');

  // Az indexek mindig uint32-ként mennek: a forrás lehet uint16-os, de az új
  // lista ugyanazokra a csúcsokra mutat, és a 32 bit sosem kevés.
  const idx = new Uint32Array(triples.length * 3);
  triples.forEach(([a, b, c], i) => { idx[i * 3] = a; idx[i * 3 + 1] = b; idx[i * 3 + 2] = c; });
  const ujAdat = new Uint8Array(idx.buffer);

  const regiBin = bytes.subarray(glb.binStart, glb.binStart + glb.binLength);
  // Az accessor eltolása 4-gyel osztható kell legyen (uint32 komponens).
  const eltolas = regiBin.byteLength + padTo4(regiBin.byteLength);

  json.bufferViews.push({
    buffer: 0,
    byteOffset: eltolas,
    byteLength: ujAdat.byteLength,
    target: 34963,   // ELEMENT_ARRAY_BUFFER
  });
  json.accessors.push({
    bufferView: json.bufferViews.length - 1,
    componentType: 5125,
    count: idx.length,
    type: 'SCALAR',
  });
  json.meshes[meshIndex].primitives.push({
    attributes: { ...forras.attributes },
    indices: json.accessors.length - 1,
    material: materialIndex,
    ...(forras.mode !== undefined ? { mode: forras.mode } : {}),
  });
  const ujBinHossz = eltolas + ujAdat.byteLength;
  if (json.buffers?.[0]) json.buffers[0].byteLength = ujBinHossz;

  // ---- Újraépítés ----
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = padTo4(jsonBytes.byteLength);
  const binPad = padTo4(ujBinHossz);
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + ujBinHossz + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  // A JSON-darab kitöltése SZÓKÖZ, a BIN-é nulla — ezt a glTF előírja.
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jsonPad);
  const binChunk = 20 + jsonBytes.byteLength + jsonPad;
  dv.setUint32(binChunk, ujBinHossz + binPad, true);
  dv.setUint32(binChunk + 4, 0x004e4942, true);
  out.set(regiBin, binChunk + 8);
  out.set(ujAdat, binChunk + 8 + eltolas);
  return out;
}
