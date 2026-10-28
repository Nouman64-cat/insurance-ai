"""Run a check in a child process with a deadline.

pdfminer, pikepdf and Pillow run in-process and cannot be interrupted, so a crafted file (deeply nested
objects, a huge content stream) could hold a server worker indefinitely. A child process can be killed.
"""

from __future__ import annotations

import multiprocessing
import sys

_context = None


def _get_context():
    global _context
    if _context is None:
        if sys.platform.startswith("linux"):
            # A forkserver keeps the parsing libraries imported, so each child starts in milliseconds.
            _context = multiprocessing.get_context("forkserver")
            _context.set_forkserver_preload(["docforensics"])
        else:
            _context = multiprocessing.get_context("spawn")
    return _context


def _child(conn, fn, args) -> None:
    try:
        conn.send(("ok", fn(*args)))
    except BaseException as exc:  # noqa: BLE001 - reported to the parent, which decides
        conn.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def call_with_timeout(fn, args: tuple, timeout: float):
    """``fn(*args)`` in a child process. Raises TimeoutError past the deadline, RuntimeError if ``fn`` raised."""
    ctx = _get_context()
    receiver, sender = ctx.Pipe(duplex=False)
    process = ctx.Process(target=_child, args=(sender, fn, args), daemon=True)
    process.start()
    sender.close()
    try:
        if not receiver.poll(timeout):
            raise TimeoutError(f"did not finish within {timeout:.0f}s")
        try:
            status, value = receiver.recv()
        except EOFError:
            raise RuntimeError(f"the worker process died (exit code {process.exitcode})") from None
    finally:
        if process.is_alive():
            process.kill()
        process.join(5)
        receiver.close()
    if status == "error":
        raise RuntimeError(value)
    return value
