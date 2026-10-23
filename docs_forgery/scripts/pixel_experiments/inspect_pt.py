"""List what a PyTorch checkpoint contains (safely: weights_only=True never runs pickled code)."""

import sys

import torch

obj = torch.load(sys.argv[1], map_location="cpu", weights_only=True)
print("type:", type(obj).__name__)
if isinstance(obj, dict):
    print("top-level keys:", list(obj.keys())[:20], "... total", len(obj))
    for k, v in obj.items():
        if not hasattr(v, "shape") and not isinstance(v, dict):
            print("  non-tensor entry:", k, "=", repr(v)[:200])
        elif isinstance(v, dict):
            print("  nested dict:", k, "with", len(v), "entries; sample keys", list(v.keys())[:6])
    sd = obj.get("state_dict") or obj.get("model") or obj
    first = [(k, tuple(v.shape)) for k, v in list(sd.items())[:6] if hasattr(v, "shape")]
    print("first weights:", first)
    for k, v in sd.items():
        if hasattr(v, "shape") and ("f1.0.weight" in k or k.endswith("srm")):
            print("  ", k, tuple(v.shape))
            if "f1.0.weight" in k:
                w = v.abs().mean(dim=(0, 2, 3))
                print("   mean |w| per input channel:", [round(float(x), 4) for x in w])
