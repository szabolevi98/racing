// Összefüggő komponens minden csúcshoz, kizárólag a háromszögháló indexei
// alapján. Az X/Z-ben egymáshoz közeli, de fizikailag különálló pályaelemek
// (kerítés teteje, reklámkapu, felüljáró) így nem számítanak szomszédnak.
export function connectedVertexComponents(vertexCount, indices) {
  const count = Math.max(0, Number(vertexCount) | 0);
  const parent = new Int32Array(count);
  const rank = new Uint8Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;

  const find = (start) => {
    let root = start;
    while (parent[root] !== root) root = parent[root];
    let current = start;
    while (parent[current] !== root) {
      const next = parent[current];
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (a, b) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    if (rank[rootA] < rank[rootB]) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    if (rank[rootA] === rank[rootB]) rank[rootA]++;
  };

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a >= count || b >= count || c >= count) {
      throw new RangeError('A simítandó háló indexe kívül esik a csúcstömbön.');
    }
    union(a, b);
    union(b, c);
  }
  for (let i = 0; i < count; i++) parent[i] = find(i);
  return parent;
}
