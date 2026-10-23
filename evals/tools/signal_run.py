"""Send SIGTERM to the evaluation processes running in this container (the runner image has no pkill):

    python -m evals.tools.signal_run evals.tools.variants evals.tools.eval_runner

Each argument is a module name; every process whose command line is `python -m <module> ...` gets SIGTERM, in the order given (the
comparison driver first, so it starts no further variant). The runner answers SIGTERM by finishing the case in flight and writing what
it has. Prints how many processes were signalled.
"""
from __future__ import annotations

import os
import signal
import sys
from pathlib import Path


def processes(module: str) -> list[int]:
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            argv = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        words = [a.decode("utf-8", "replace") for a in argv if a]
        if len(words) >= 3 and words[1] == "-m" and words[2] == module:
            found.append(int(entry.name))
    return found


def main(modules: list[str]) -> int:
    sent = 0
    for module in modules:
        for pid in processes(module):
            try:
                os.kill(pid, signal.SIGTERM)
                sent += 1
            except ProcessLookupError:
                pass
    print(sent)
    return 0 if sent else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
