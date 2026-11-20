import io
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import statecls as sc  # noqa: E402
from fetch_model import manifest  # noqa: E402

BACKBONE = os.path.join(ROOT, "models", manifest("backbone-model.json")["file"])
HAS_BACKBONE = os.path.isfile(BACKBONE)


class ColorBackbone:
    """測試用的假骨幹：特徵是 RGB 平均加一點雜訊，和真的骨幹一樣回傳 [n, d]"""

    def embed(self, images):
        return np.stack([np.r_[np.asarray(im.convert("RGB"), np.float32).mean(axis=(0, 1)) / 255, 0.1] for im in images])


def solid(color, size=(40, 30)):
    return Image.new("RGB", size, color)


def write_images(d, specs):
    items = []
    for i, (color, label) in enumerate(specs):
        path = os.path.join(d, f"{i}.png")
        solid(color).save(path)
        items.append({"path": path, "label": label})
    return items


class CropTest(unittest.TestCase):
    def test_crop_uses_truncated_pixel_coordinates_like_frigate(self):
        im = Image.new("RGB", (640, 360))
        self.assertEqual(sc.crop_image(im, [0.5, 0.25, 0.999, 1.0]).size, (319, 270))

    def test_degenerate_crop_keeps_one_pixel(self):
        self.assertEqual(sc.crop_image(Image.new("RGB", (10, 10)), [0.5, 0.5, 0.5, 0.5]).size, (1, 1))

    def test_changed_detects_region_differences_only_above_threshold(self):
        a = sc.small_gray(solid((100, 100, 100)))
        self.assertTrue(sc.changed(None, a))
        self.assertFalse(sc.changed(a, sc.small_gray(solid((103, 103, 103)))))
        self.assertTrue(sc.changed(a, sc.small_gray(solid((140, 140, 140)))))


class TrainTest(unittest.TestCase):
    def test_trains_separable_classes_and_reports_cross_validation(self):
        with tempfile.TemporaryDirectory() as d:
            specs = [((20 + i, 20, 20), "關") for i in range(6)] + [((230 - i, 230, 230), "開") for i in range(6)]
            items = write_images(d, specs)
            seen = []
            m = sc.train(ColorBackbone(), sc.EmbeddingCache(), items, ["關", "開"], {"id": "fake"}, seen.append)
        self.assertEqual(m["classes"], ["關", "開"])
        self.assertEqual(m["counts"], [{"label": "關", "count": 6}, {"label": "開", "count": 6}])
        self.assertEqual(m["validation"]["accuracy"], 1.0)
        self.assertEqual(m["validation"]["folds"], 5)
        self.assertEqual(m["validation"]["confusion"], [[6, 0], [0, 6]])
        self.assertGreater(seen[-1], 0.9)
        model = sc.Model(m["classes"], np.array(m["w"], np.float32), np.array(m["b"], np.float32))
        i, score, probs = model.classify(ColorBackbone().embed([solid((240, 240, 240))])[0])
        self.assertEqual(model.classes[i], "開")
        self.assertAlmostEqual(sum(probs), 1, places=3)
        self.assertGreater(score, 0.8)

    def test_validation_skipped_when_a_class_has_one_image(self):
        with tempfile.TemporaryDirectory() as d:
            items = write_images(d, [((0, 0, 0), "a"), ((5, 5, 5), "a"), ((255, 255, 255), "b")])
            m = sc.train(ColorBackbone(), sc.EmbeddingCache(), items, ["a", "b"], {"id": "fake"}, lambda f: None)
        self.assertIsNone(m["validation"])

    def test_missing_class_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as d:
            items = write_images(d, [((0, 0, 0), "a"), ((5, 5, 5), "a")])
            with self.assertRaisesRegex(ValueError, "b") as cm:
                sc.train(ColorBackbone(), sc.EmbeddingCache(), items, ["a", "b"], {"id": "fake"}, lambda f: None)
            self.assertEqual(cm.exception.code, "states.classesWithoutImages")
            self.assertEqual(cm.exception.params, {"classes": ["b"]})

    def test_model_from_another_backbone_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "model.json")
            sc.write_json_atomic(path, {"version": sc.MODEL_VERSION, "backbone": {"id": "other"}, "classes": ["a"], "w": [[0]], "b": [0]})
            with self.assertRaisesRegex(ValueError, "重新訓練") as cm:
                sc.load_model(path, "dinov2-small-int8")
            self.assertEqual(cm.exception.code, "states.modelBackboneChanged")


class DiverseTest(unittest.TestCase):
    def test_picks_farthest_points(self):
        feats = np.array([[1, 0], [0.99, 0.01], [0, 1], [0.7, 0.7]], np.float32)
        self.assertEqual(sc.diverse(feats, 2), [0, 2])
        self.assertEqual(sc.diverse(feats, 10), [0, 1, 2, 3])


class ZipImportTest(unittest.TestCase):
    def png(self, color=(10, 20, 30)):
        buf = io.BytesIO()
        solid(color).save(buf, "PNG")
        return buf.getvalue()

    def test_member_paths(self):
        self.assertEqual(sc.classify_member("garage/dataset/close/a.png"), ("dataset", "close"))
        self.assertEqual(sc.classify_member("dataset/開/a.webp"), ("dataset", "開"))
        self.assertEqual(sc.classify_member("garage/train/none-none-1.5-open-0.95.webp"), ("train", None))
        for bad in ["../dataset/a/b.png", "garage/dataset/../x.png", "/abs/dataset/a/b.png", "garage/dataset/.x/a.png",
                    "__MACOSX/garage/dataset/close/._a.png", "garage/dataset/close/a.txt", "x/y/garage/dataset/close/a.png", "garage/other/a.png"]:
            self.assertIsNone(sc.classify_member(bad), bad)

    def test_frigate_guess_from_file_name(self):
        self.assertEqual(sc.frigate_guess("none-none-1794840073.646496-open-0.95.webp"), {"label": "open", "score": 0.95})
        self.assertEqual(sc.frigate_guess("none-none-1794869155.355261-close-1.0.webp"), {"label": "close", "score": 1.0})
        self.assertIsNone(sc.frigate_guess("photo.png"))

    def test_imports_dataset_and_train_never_writing_outside(self):
        with tempfile.TemporaryDirectory() as d:
            zpath, out = os.path.join(d, "g.zip"), os.path.join(d, "out")
            os.makedirs(out)
            with zipfile.ZipFile(zpath, "w") as zf:
                zf.writestr("garage/dataset/close/a.png", self.png())
                zf.writestr("garage/dataset/open/b.png", self.png((200, 200, 200)))
                zf.writestr("garage/train/none-none-1.0-open-0.9.webp", self.png())
                zf.writestr("garage/dataset/close/broken.png", b"not an image")
                zf.writestr("../evil/dataset/close/c.png", self.png())
                zf.writestr("garage/.training_metadata.json", "{}")
            names = iter(f"img{i}" for i in range(100))
            r = sc.import_zip(zpath, out, lambda ext: next(names) + ext, lambda f: None)
            self.assertEqual(sorted(x["label"] for x in r["labeled"]), ["close", "open"])
            self.assertEqual(r["pending"], [{"file": "img2.png", "guess": {"label": "open", "score": 0.9}}])
            self.assertEqual(r["skipped"], 1)
            self.assertEqual(sorted(os.listdir(out)), ["img0.png", "img1.png", "img2.png"])
            self.assertFalse(os.path.exists(os.path.join(d, "evil")))


@unittest.skipUnless(HAS_BACKBONE, "backbone model not downloaded (python3 detector/fetch_model.py)")
class WorkerTest(unittest.TestCase):
    """真的啟動 classify.py：train → classify（force 與 changed）走一次 socket 協定"""

    def test_train_then_classify_over_socket(self):
        with tempfile.TemporaryDirectory() as d:
            sock_path = os.path.join(d, "s.sock")
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(sock_path)
            srv.listen(1)
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "classify.py"), "--socket", sock_path, "--backbone", BACKBONE])
            conn = None
            try:
                conn, _ = srv.accept()
                conn.settimeout(120)
                msgs = Reader(conn)
                self.assertEqual(msgs.next_of("status")[0]["state"], "loading")
                self.assertEqual(msgs.next_of("status")[0]["state"], "ready")
                items = write_images(d, [((30, 30 + i * 3, 30), "dark") for i in range(3)] + [((220, 220 - i * 3, 220), "light") for i in range(3)])
                model = os.path.join(d, "model.json")
                send(conn, 1, json.dumps({"type": "train", "job": 7, "items": items, "classes": ["dark", "light"], "out": model}).encode())
                result, _ = msgs.next_of("job-result")
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["result"]["classes"], ["dark", "light"])
                frame = io.BytesIO()
                im = Image.new("RGB", (640, 360), (30, 30, 30))
                im.paste((225, 225, 225), (320, 0, 640, 360))
                im.save(frame, "JPEG")
                head = {"type": "classify", "id": 1, "sensor": "s1", "model": model, "crop": [0.5, 0, 1, 1], "mode": "force"}
                send_blob(conn, head, frame.getvalue())
                reading, crop = msgs.next_of("reading")
                self.assertEqual(reading["label"], "light")
                self.assertEqual(Image.open(io.BytesIO(crop)).size, (320, 360))
                send_blob(conn, {**head, "id": 2, "mode": "changed"}, frame.getvalue())
                self.assertEqual(msgs.next_of("reading")[0], {"type": "reading", "id": 2, "skipped": "unchanged"})
            finally:
                proc.kill()
                proc.wait()
                if conn:
                    conn.close()
                srv.close()


def send(conn, kind, payload):
    conn.sendall(struct.pack(">BI", kind, len(payload)) + payload)


def send_blob(conn, head, data):
    h = json.dumps(head).encode()
    send(conn, 3, struct.pack(">I", len(h)) + h + data)


class Reader:
    def __init__(self, conn):
        self.conn = conn

    def exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.conn.recv(n - len(buf))
            if not chunk:
                raise EOFError
            buf += chunk
        return buf

    def next_of(self, kind):
        while True:
            k, n = struct.unpack(">BI", self.exact(5))
            body = self.exact(n)
            if k == 3:
                (hn,) = struct.unpack(">I", body[:4])
                msg, data = json.loads(body[4:4 + hn]), body[4 + hn:]
            else:
                msg, data = json.loads(body), b""
            if msg.get("type") == kind:
                return msg, data


if __name__ == "__main__":
    unittest.main()
