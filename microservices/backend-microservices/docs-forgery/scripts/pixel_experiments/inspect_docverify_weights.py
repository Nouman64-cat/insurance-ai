"""Clues about docverify's undocumented inputs, from the trained weights themselves."""

import numpy as np
import onnx
from onnx import numpy_helper

m = onnx.load(r"data/models/docverify/tampernet.onnx")
init = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}
conv = next(n for n in m.graph.node if n.op_type == "Conv" and n.input[0] == "/m/Concat_output_0")
w = init[conv.input[1]]  # (32, 9, 3, 3): channels 0-2 RGB, 3-5 unknown, 6-8 SRM*10
print("f1.0 weight", w.shape)
mag = np.abs(w).mean(axis=(0, 2, 3))
print("mean |w| per input channel:", np.round(mag, 4))
print("  RGB 0-2    :", np.round(mag[0:3], 4))
print("  unknown 3-5:", np.round(mag[3:6], 4))
print("  SRM 6-8    :", np.round(mag[6:9], 4))
# spatial structure of the filters on each channel: high-pass-like filters have ~zero-sum kernels
for name, sl in (("RGB", slice(0, 3)), ("unknown", slice(3, 6)), ("SRM", slice(6, 9))):
    k = w[:, sl, :, :]
    print(f"{name:8s} mean kernel sum {k.sum(axis=(2, 3)).mean():+.4f} | mean |kernel| {np.abs(k).mean():.4f}")

# the DCT branch
dct_conv = next(n for n in m.graph.node if "dct" in n.input)
dw = init[dct_conv.input[1]]
print("\ndct conv weight", dw.shape, "| mean |w| per DCT coefficient index (first 16):", np.round(np.abs(dw).mean(axis=(0, 2, 3))[:16], 4))
print("mean |w| for DC (index 0) vs AC mean:", round(float(np.abs(dw)[:, 0].mean()), 4), round(float(np.abs(dw)[:, 1:].mean()), 4))
