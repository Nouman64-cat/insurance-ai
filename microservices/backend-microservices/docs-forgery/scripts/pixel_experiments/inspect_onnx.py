"""Print an ONNX model's inputs/outputs and its first operators (to work out preprocessing)."""

import sys

import onnx
import onnxruntime as ort

path = sys.argv[1]
sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
for i in sess.get_inputs():
    print("input :", i.name, i.shape, i.type)
for o in sess.get_outputs():
    print("output:", o.name, o.shape, o.type)
model = onnx.load(path, load_external_data=False)
print("opset:", [(o.domain, o.version) for o in model.opset_import], "| nodes:", len(model.graph.node))
print("first 14 nodes:")
for n in list(model.graph.node)[:14]:
    print("  ", n.op_type, list(n.input)[:3], "->", list(n.output)[:1])
print("metadata:", {p.key: p.value for p in model.metadata_props})
