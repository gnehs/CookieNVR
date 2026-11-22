"""worker 與主程序之間的 Unix socket（detector/main.py、detector/classify.py 共用）。

主程序監聽、worker 連進來；雙向都是「1 位元組種類 + 4 位元組長度（big-endian）+ 內容」，種類 1 是一則 JSON。
其他種類由各 worker 自己定，見各檔開頭的說明。
"""

from __future__ import annotations

import json
import os
import select
import socket
import struct
import threading
import time
from typing import Callable

KIND_JSON = 1
HEARTBEAT_S = 2.0


class Channel:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.lock = threading.Lock()
        self.busy_since: float | None = None

    def send_frame(self, kind: int, payload: bytes) -> None:
        with self.lock:
            self.sock.sendall(struct.pack(">BI", kind, len(payload)) + payload)

    def send(self, msg: dict) -> None:
        self.send_frame(KIND_JSON, json.dumps(msg, ensure_ascii=False).encode())

    def recv_exact(self, n: int) -> bytes | None:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return bytes(buf)

    def recv(self) -> tuple[int, bytes] | None:
        head = self.recv_exact(5)
        if head is None:
            return None
        kind, length = struct.unpack(">BI", head)
        body = self.recv_exact(length)
        return None if body is None else (kind, body)

    def readable(self) -> bool:
        return bool(select.select([self.sock], [], [], 0)[0])


def connect(path: str) -> socket.socket:
    """主程序可能還沒開始監聽：重試 5 秒"""
    last: OSError | None = None
    for _ in range(50):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(path)
            return s
        except OSError as e:
            last = e
            time.sleep(0.1)
    raise SystemExit(f"cannot connect to {path}: {last}")


def heartbeat(ch: Channel, extra: Callable[[], dict]) -> None:
    """每 2 秒送一次心跳，帶著手上這件事做了多久；主程序斷線就結束整個程序"""
    while True:
        time.sleep(HEARTBEAT_S)
        busy = ch.busy_since
        try:
            ch.send({"type": "heartbeat", "busyMs": None if busy is None else round((time.monotonic() - busy) * 1000), **extra()})
        except OSError:
            os._exit(0)
