"""Work out the input semantics of docverify's ONNX graph (constants, first convs, DCT consumers)."""

import sys

import numpy as np
import onnx
from onnx import numpy_helper

m = onnx.load(sys.argv[1])
g = m.graph
init = {i.name: numpy_helper.to_array(i) for i in g.initializer}
consts = {}
for n in g.node:
    if n.op_type == "Constant":
        for a in n.attribute:
            if a.name == "value":
                consts[n.output[0]] = numpy_helper.to_array(a.t)

print("Slice nodes on x:")
for n in g.node:
    if n.op_type == "Slice" and n.input[0] == "x":
        print("  slice params:", [consts.get(i, init.get(i)) for i in n.input[1:]])
print("\nconsumers of 'dct':")
for n in g.node:
    if "dct" in n.input:
        print("  ", n.op_type, list(n.input), "->", list(n.output))
print("\nSRM weight shape:", init.get("m.srm").shape if "m.srm" in init else "n/a")
print("\nfirst 6 Conv weights:")
shown = 0
for n in g.node:
    if n.op_type == "Conv":
        w = init.get(n.input[1])
        print("  ", n.name or n.output[0], "weight", None if w is None else w.shape, "| inputs:", list(n.input)[:1])
        shown += 1
        if shown >= 6:
            break
print("\nscalar constants near the start (possible normalisation):")
for n in g.node[:60]:
    if n.op_type in ("Sub", "Div", "Mul", "Add"):
        print("  ", n.op_type, list(n.input), [consts.get(i) if i in consts else (init[i].reshape(-1)[:6] if i in init else None) for i in n.input])
