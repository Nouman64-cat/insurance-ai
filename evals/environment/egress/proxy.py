"""The only way out of the evaluation stack for a model call: an HTTPS CONNECT proxy with an allowlist.

The chat agent and the judge sit on the internal network (no internet, no route to the host or the production stack) and send their provider
calls here. This proxy refuses everything except port 443 on the listed provider hosts, and refuses any host that resolves to a private,
loopback or link-local address (so a name cannot be pointed back at the host or the production stack). It sees only encrypted bytes: it
cannot read the key or the prompts. Every decision is logged.
"""
import asyncio
import ipaddress
import os
import socket
import sys
import time

ALLOW = {h.strip().lower() for h in os.environ.get("EVAL_EGRESS_ALLOW", "api.openai.com,generativelanguage.googleapis.com,api.anthropic.com").split(",") if h.strip()}
PORT = int(os.environ.get("EVAL_EGRESS_PORT", "3128"))


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def public_address(host: str):
    for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return None
        return str(ip)
    return None


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer):
    peer = (writer.get_extra_info("peername") or ("?",))[0]
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        method, target, _ = line.split(" ", 2)
        host, _, port = target.rpartition(":")
        host = host.lower()
        if method != "CONNECT" or port != "443" or host not in ALLOW:
            log(f"DENY {peer} {line}")
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return
        ip = await asyncio.get_running_loop().run_in_executor(None, public_address, host)
        if not ip:
            log(f"DENY {peer} {host} resolves to a non-public address")
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, 443), 10)
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        log(f"ALLOW {peer} {host}")
        await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer))
    except Exception as exc:
        log(f"ERROR {peer} {type(exc).__name__}")
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", PORT)
    log(f"egress proxy on :{PORT}, allowed: {', '.join(sorted(ALLOW))}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
