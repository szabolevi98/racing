import sys, json, struct

path = sys.argv[1]

with open(path, 'rb') as f:
    data = f.read()

magic, version, length = struct.unpack_from('<III', data, 0)
assert magic == 0x46546C67

offset = 12
json_chunk = None
bin_chunk = None
while offset < length:
    chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
    chunk_data = data[offset+8: offset+8+chunk_len]
    if chunk_type == 0x4E4F534A:
        json_chunk = json.loads(chunk_data)
    elif chunk_type == 0x004E4942:
        bin_chunk = chunk_data
    offset += 8 + chunk_len

gltf = json_chunk
nodes = gltf.get('nodes', [])
meshes = gltf.get('meshes', [])
materials = gltf.get('materials', [])
accessors = gltf.get('accessors', [])
bufferViews = gltf.get('bufferViews', [])
buffers = gltf.get('buffers', [])

def get_accessor_data(idx):
    acc = accessors[idx]
    bv = bufferViews[acc['bufferView']]
    comp_type = acc['componentType']
    count = acc['count']
    type_ = acc['type']
    num_comp = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[type_]
    fmt = {5126:'f', 5125:'I', 5123:'H', 5121:'B'}[comp_type]
    size = {'f':4,'I':4,'H':2,'B':1}[fmt]
    start = bv.get('byteOffset',0) + acc.get('byteOffset',0)
    buf = buffers[bv['bufferView']] if False else bin_chunk
    stride = bv.get('byteStride', size*num_comp)
    vals = []
    base = start
    for i in range(count):
        off = base + i*stride
        v = struct.unpack_from('<'+fmt*num_comp, bin_chunk, off)
        vals.append(v)
    return vals

def mat4_mul(a, b):
    result = [0.0]*16
    for col in range(4):
        for row in range(4):
            s = 0.0
            for k in range(4):
                s += a[k*4+row]*b[col*4+k]
            result[col*4+row] = s
    return result

def identity():
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

def node_local_matrix(node):
    if 'matrix' in node:
        return node['matrix']
    m = identity()
    if 'scale' in node:
        sx,sy,sz = node['scale']
        s = [sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1]
        m = mat4_mul(m, s)
    if 'rotation' in node:
        x,y,z,w = node['rotation']
        r = [
            1-2*(y*y+z*z), 2*(x*y+z*w), 2*(x*z-y*w), 0,
            2*(x*y-z*w), 1-2*(x*x+z*z), 2*(y*z+x*w), 0,
            2*(x*z+y*w), 2*(y*z-x*w), 1-2*(x*x+y*y), 0,
            0,0,0,1
        ]
        m = mat4_mul(m, r)
    if 'translation' in node:
        tx,ty,tz = node['translation']
        t = [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]
        m = mat4_mul(m, t)
    return m

# find roots (nodes referenced by scene)
scene_idx = gltf.get('scene', 0)
scene = gltf['scenes'][scene_idx]
roots = scene['nodes']

world_matrices = {}

def walk(idx, parent_matrix):
    node = nodes[idx]
    local = node_local_matrix(node)
    world = mat4_mul(parent_matrix, local)
    world_matrices[idx] = world
    for c in node.get('children', []):
        walk(c, world)

for r in roots:
    walk(r, identity())

def transform_point(m, p):
    x,y,z = p
    ox = m[0]*x + m[4]*y + m[8]*z + m[12]
    oy = m[1]*x + m[5]*y + m[9]*z + m[13]
    oz = m[2]*x + m[6]*y + m[10]*z + m[14]
    return (ox,oy,oz)

print(f"Nodes: {len(nodes)}, Meshes: {len(meshes)}, Materials: {len(materials)}")
print("Materials:", [m.get('name','?') for m in materials])
print()

for idx, node in enumerate(nodes):
    if 'mesh' not in node:
        continue
    mesh = meshes[node['mesh']]
    world = world_matrices.get(idx, identity())
    # compute bbox from primitives using accessor min/max, transformed
    minp = [1e9,1e9,1e9]
    maxp = [-1e9,-1e9,-1e9]
    mat_names = []
    for prim in mesh.get('primitives', []):
        pos_acc_idx = prim['attributes'].get('POSITION')
        if pos_acc_idx is None:
            continue
        acc = accessors[pos_acc_idx]
        amin = acc.get('min')
        amax = acc.get('max')
        if amin and amax:
            corners = []
            for cx in (amin[0], amax[0]):
                for cy in (amin[1], amax[1]):
                    for cz in (amin[2], amax[2]):
                        corners.append((cx,cy,cz))
            for c in corners:
                wc = transform_point(world, c)
                for i in range(3):
                    minp[i] = min(minp[i], wc[i])
                    maxp[i] = max(maxp[i], wc[i])
        if 'material' in prim:
            mat_names.append(materials[prim['material']].get('name','?'))
    center = tuple((minp[i]+maxp[i])/2 for i in range(3))
    size = tuple(maxp[i]-minp[i] for i in range(3))
    name = node.get('name','?')
    print(f"node[{idx}] name={name!r} mesh={node['mesh']} center=({center[0]:.2f},{center[1]:.2f},{center[2]:.2f}) size=({size[0]:.2f},{size[1]:.2f},{size[2]:.2f}) mats={mat_names}")
