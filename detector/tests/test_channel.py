import os
import socket
import struct
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from channel import KIND_JSON, Channel, connect  # noqa: E402


class ChannelTest(unittest.TestCase):
    def test_frames_carry_kind_and_length_and_end_with_the_connection(self):
        a, b = socket.socketpair()
        ch = Channel(a)
        ch.send({"type": "status", "name": "中文"})
        ch.send_frame(3, b"\x00\x01\x02")
        body = '{"type": "status", "name": "中文"}'.encode()
        self.assertEqual(b.recv(5), struct.pack(">BI", KIND_JSON, len(body)))
        peer = Channel(b)
        self.assertEqual(peer.recv_exact(len(body)), body)
        self.assertEqual(peer.recv(), (3, b"\x00\x01\x02"))
        a.close()
        self.assertIsNone(peer.recv())

    def test_connect_waits_for_the_main_process_to_listen(self):
        path = os.path.join(tempfile.mkdtemp(prefix="cnvr-", dir="/tmp"), "c.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

        def listen_later():
            server.bind(path)
            server.listen(1)

        timer = threading.Timer(0.3, listen_later)
        timer.start()
        s = connect(path)
        conn, _ = server.accept()
        Channel(s).send({"type": "heartbeat"})
        self.assertEqual(Channel(conn).recv(), (KIND_JSON, b'{"type": "heartbeat"}'))
        for x in (s, conn, server):
            x.close()


if __name__ == "__main__":
    unittest.main()
