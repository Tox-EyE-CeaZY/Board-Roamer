"""Makes ui/vendor/style/tinyclip-vision.onnx from the published model.

Source: https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX, file onnx/model_int8.onnx
(sha256 844d1a46ab18...), MIT license.

    python tools/style-model.py model_int8.onnx ui/vendor/style/tinyclip-vision.onnx image_embeds

Two changes, neither of which changes the output:
- the int8 weights of ConvInteger nodes are rewritten as uint8 (value + 128, zero point + 128): (w + 128) - (z + 128) == w - z, and
  ONNX Runtime's web build only has the uint8 kernel;
- with an output name as third argument, only what that output needs is kept (drops CLIP's text half: 24 MB -> 9 MB).

Standard library only: the file is walked as plain protobuf.
"""
import sys


def rd(buf, i):
    shift = val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if b < 0x80:
            return val, i
        shift += 7


def wr(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def parse(buf):
    i, out = 0, []
    while i < len(buf):
        key, i = rd(buf, i)
        f, w = key >> 3, key & 7
        if w == 0:
            v, i = rd(buf, i)
        elif w == 2:
            n, i = rd(buf, i)
            v = buf[i:i + n]
            i += n
        elif w == 5:
            v = buf[i:i + 4]
            i += 4
        elif w == 1:
            v = buf[i:i + 8]
            i += 8
        else:
            raise ValueError('wire type %d' % w)
        out.append((f, w, v))
    return out


def build(fields):
    out = bytearray()
    for f, w, v in fields:
        out += wr(f << 3 | w)
        if w == 0:
            out += wr(v)
        elif w == 2:
            out += wr(len(v)) + v
        else:
            out += v
    return bytes(out)


def tensor(raw):
    t = parse(raw)
    name = next((v for f, w, v in t if f == 8), b'').decode()
    dtype = next((v for f, w, v in t if f == 2), 0)
    return name, dtype, t


def as_uint8(raw, newname=None):
    name, dtype, t = tensor(raw)
    assert dtype == 3, (name, dtype)  # INT8
    out = []
    for f, w, v in t:
        if f == 2:
            v = 2  # UINT8
        elif f == 9:
            v = bytes(b ^ 0x80 for b in v)
        elif f == 5:  # int32_data, packed or not
            if w == 2:
                vals, j = [], 0
                while j < len(v):
                    x, j = rd(v, j)
                    vals.append(x - (1 << 64) if x >= 1 << 63 else x)
                v = b''.join(wr(x + 128) for x in vals)
            else:
                v = (v - (1 << 64) if v >= 1 << 63 else v) + 128
        elif f == 8 and newname:
            v = newname.encode()
        out.append((f, w, v))
    return build(out)


src, dst = sys.argv[1], sys.argv[2]
model = parse(open(src, 'rb').read())
gi = next(i for i, (f, w, v) in enumerate(model) if f == 7)
graph = parse(model[gi][2])
inits = {tensor(v)[0]: i for i, (f, w, v) in enumerate(graph) if f == 5}
weights, extra, rewired = set(), {}, 0
for i, (f, w, v) in enumerate(graph):
    if f != 1:
        continue
    node = parse(v)
    if next((x for g, _, x in node if g == 4), b'') != b'ConvInteger':
        continue
    pos = [j for j, (g, _, x) in enumerate(node) if g == 1]
    names = [node[j][2].decode() for j in pos]
    wname = names[1]
    assert wname in inits, 'weights are not a constant: ' + wname
    if tensor(graph[inits[wname]][2])[1] != 3:
        continue
    weights.add(wname)
    if len(names) > 3 and names[3]:
        z = names[3]
        new = z + '__u8'  # a copy: the same zero point may serve nodes that stay int8
        extra[new] = as_uint8(graph[inits[z]][2], new)
    else:
        new = '__zero128'
        extra[new] = build([(1, 0, 1), (2, 0, 2), (8, 2, new.encode()), (9, 2, bytes([128]))])
        while len(pos) < 4:  # add the missing inputs
            node.insert(pos[-1] + 1, (1, 2, b''))
            pos.append(pos[-1] + 1)
    if len(pos) < 4:
        node.insert(pos[-1] + 1, (1, 2, new.encode()))
    else:
        node[pos[3]] = (1, 2, new.encode())
    graph[i] = (1, 2, build(node))
    rewired += 1
for name in weights:
    others = [parse(v) for f, w, v in graph if f == 1]
    users = {next((x for g, _, x in n if g == 4), b'') for n in others if name.encode() in [x for g, _, x in n if g == 1]}
    assert users == {b'ConvInteger'}, (name, users)
    graph[inits[name]] = (5, 2, as_uint8(graph[inits[name]][2]))
# new constants go with the other initializers
last = max(i for i, (f, w, v) in enumerate(graph) if f == 5)
graph[last + 1:last + 1] = [(5, 2, v) for v in extra.values()]
model[gi] = (7, 2, build(graph))
open(dst, 'wb').write(build(model))
print('rewired', rewired, 'convolutions,', len(weights), 'weight tensors')

if len(sys.argv) > 3:  # keep only what the named output needs (drops CLIP's text half)
    keep = sys.argv[3]
    graph = parse(parse(open(dst, 'rb').read())[gi][2])
    nodes = [(i, parse(v)) for i, (f, w, v) in enumerate(graph) if f == 1]
    maker = {x.decode(): i for i, n in nodes for g, _, x in n if g == 2}
    needed, used, stack = set(), set(), [keep]
    while stack:
        t = stack.pop()
        if t in used:
            continue
        used.add(t)
        i = maker.get(t)
        if i is not None and i not in needed:
            needed.add(i)
            stack.extend(x.decode() for g, _, x in parse(graph[i][2]) if g == 1 and x)
    name_of = lambda v: next((x for g, _, x in parse(v) if g in (1,)), b'').decode()
    out = []
    for i, (f, w, v) in enumerate(graph):
        if f == 1 and i not in needed:
            continue
        if f == 5 and tensor(v)[0] not in used:
            continue
        if f in (11, 12) and name_of(v) not in (used if f == 11 else {keep}):
            continue
        if f == 13 and name_of(v) not in used:
            continue
        out.append((f, w, v))
    model = parse(open(dst, 'rb').read())
    model[gi] = (7, 2, build(out))
    open(dst, 'wb').write(build(model))
    print('kept', len(needed), 'of', len(nodes), 'nodes for', keep)
