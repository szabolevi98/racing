import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A letöltött autók gyakran ugyanazt az anyagot több tucat külön mesh-en
// használják. A böngésző ezeket külön draw callként adja a GPU-nak akkor is,
// ha együtt mereven mozognak. Betöltés után, a kerék-pivotok elkészítésekor a
// mozgó részek már külön gyökérben vannak, ezért az azonos anyagú, kompatibilis
// merev darabokat veszteség nélkül egy geometriává lehet sütni.

function geometryLayoutKey(geometry) {
  if (!geometry || Object.keys(geometry.morphAttributes || {}).length) return null;
  if (geometry.groups?.length) return null;
  const drawCount = geometry.drawRange?.count;
  if (geometry.drawRange?.start || (Number.isFinite(drawCount) && drawCount !== Infinity)) return null;

  const attributes = Object.entries(geometry.attributes || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, attribute]) => [
      name,
      attribute.array?.constructor?.name || '',
      attribute.itemSize,
      attribute.normalized ? 1 : 0,
      attribute.gpuType ?? '',
    ].join(':'))
    .join('|');
  if (!attributes.includes('position:')) return null;
  const index = geometry.index;
  const indexKey = index
    ? `${index.array?.constructor?.name || ''}:${index.itemSize}:${index.normalized ? 1 : 0}`
    : 'none';
  return `${indexKey}/${attributes}`;
}

function hasVisibleAncestors(mesh, root) {
  for (let node = mesh; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) return true;
  }
  return false;
}

function batchKey(mesh, root) {
  if (
    !mesh?.isMesh
    || mesh.isSkinnedMesh
    || mesh.isInstancedMesh
    || !mesh.geometry
    || !mesh.material
    || Array.isArray(mesh.material)
    || mesh.material.transparent
    || mesh.material.opacity < 1
    || mesh.material.transmission > 0
    || !hasVisibleAncestors(mesh, root)
    || mesh.morphTargetInfluences?.length
  ) return null;
  const layout = geometryLayoutKey(mesh.geometry);
  if (!layout) return null;

  // A transzformot belesütjük az összevont geometriába. Tükrözött node-nál a
  // renderer külön megfordítaná a front face-t; ezt nem veszítjük el egy
  // kockázatos automatikus háromszög-átforgatással, inkább külön hagyjuk.
  mesh.updateWorldMatrix(true, false);
  if (mesh.matrixWorld.determinant() < 0) return null;

  return [
    mesh.material.uuid,
    layout,
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    mesh.frustumCulled ? 1 : 0,
    mesh.renderOrder || 0,
    mesh.layers.mask,
  ].join('/');
}

function renderableMeshCount(root) {
  let count = 0;
  root?.traverse((object) => {
    if (!object.isMesh || !object.visible) return;
    count += Array.isArray(object.material) ? object.material.length : 1;
  });
  return count;
}

function collectBatches(root) {
  root.updateWorldMatrix(true, true);
  const batches = new Map();
  root.traverse((object) => {
    const key = batchKey(object, root);
    if (!key) return;
    let batch = batches.get(key);
    if (!batch) {
      batch = [];
      batches.set(key, batch);
    }
    batch.push(object);
  });
  return [...batches.values()].filter((batch) => batch.length > 1);
}

function mergeBatch(root, meshes) {
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const transform = new THREE.Matrix4();
  const geometries = meshes.map((mesh) => {
    transform.multiplyMatrices(rootInverse, mesh.matrixWorld);
    return mesh.geometry.clone().applyMatrix4(transform);
  });
  const mergedGeometry = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!mergedGeometry) return null;

  mergedGeometry.computeBoundingBox();
  mergedGeometry.computeBoundingSphere();
  const source = meshes[0];
  const merged = new THREE.Mesh(mergedGeometry, source.material);
  merged.name = `batched-${source.material.name || 'material'}`;
  merged.castShadow = source.castShadow;
  merged.receiveShadow = source.receiveShadow;
  merged.frustumCulled = source.frustumCulled;
  merged.renderOrder = source.renderOrder;
  merged.layers.mask = source.layers.mask;
  root.add(merged);
  meshes.forEach((mesh) => mesh.parent?.remove(mesh));
  return merged;
}

export function batchCarVisual(ownershipRoot, rigidRoots) {
  const roots = [...new Set((rigidRoots || []).filter(Boolean))];
  const beforeDraws = renderableMeshCount(ownershipRoot);
  const removedGeometries = new Set();
  let batches = 0;
  let mergedParts = 0;

  for (const root of roots) {
    for (const meshes of collectBatches(root)) {
      meshes.forEach((mesh) => removedGeometries.add(mesh.geometry));
      if (!mergeBatch(root, meshes)) continue;
      batches++;
      mergedParts += meshes.length;
    }
  }

  // A régi geometriát csak akkor engedjük el, ha az autó egy kihagyott vagy
  // tükrözött mesh-e sem hivatkozik rá. A material és a textúra ugyanaz marad.
  const retainedGeometries = new Set();
  ownershipRoot?.traverse((object) => {
    if (object.isMesh && object.geometry) retainedGeometries.add(object.geometry);
  });
  removedGeometries.forEach((geometry) => {
    if (!retainedGeometries.has(geometry)) geometry.dispose();
  });

  ownershipRoot?.updateMatrixWorld(true);
  return {
    beforeDraws,
    afterDraws: renderableMeshCount(ownershipRoot),
    batches,
    mergedParts,
  };
}
