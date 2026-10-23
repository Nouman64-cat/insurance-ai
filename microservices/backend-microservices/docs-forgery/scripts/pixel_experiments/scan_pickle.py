"""List the Python globals a PyTorch checkpoint's pickle would import, WITHOUT executing it."""

import pickletools
import sys
import zipfile
from collections import Counter

path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    name = next(n for n in z.namelist() if n.endswith("data.pkl"))
    data = z.read(name)
globals_seen = Counter()
last_strings: list[str] = []
for op, arg, _ in pickletools.genops(data):
    if op.name in ("SHORT_BINUNICODE", "BINUNICODE", "UNICODE", "STRING", "SHORT_BINSTRING"):
        last_strings = (last_strings + [arg])[-2:]
    if op.name == "GLOBAL":
        globals_seen[str(arg).replace(" ", ".")] += 1
    elif op.name == "STACK_GLOBAL" and len(last_strings) == 2:
        globals_seen[".".join(last_strings)] += 1
for g, n in sorted(globals_seen.items()):
    print(f"{n:5d}  {g}")
