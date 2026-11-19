import io
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import engine as eng  # noqa: E402
import yolo  # noqa: E402
from coco import COCO_NAMES  # noqa: E402
from fetch_model import manifest  # noqa: E402
from selftest import test_image  # noqa: E402

MODEL = os.path.join(ROOT, "models", manifest()["file"])
HAS_MODEL = os.path.isfile(MODEL)


def layout(kind: str, w: int = 640, h: int = 640) -> yolo.Layout:
    return yolo.Layout(kind, w, h, COCO_NAMES)


class LayoutTest(unittest.TestCase):
    def test_yolox_official_shape(self):
        lay = yolo.detect_layout([1, 3, 416, 416], (1, 3549, 85))
        self.assertEqual((lay.kind, lay.width, lay.height, len(lay.names)), ("yolox", 416, 416, 80))

    def test_ultralytics_shape(self):
        lay = yolo.detect_layout([1, 3, 640, 640], (1, 84, 8400))
        self.assertEqual(lay.kind, "ultralytics")

    def test_dynamic_input_defaults_to_640(self):
        lay = yolo.detect_layout(["batch", 3, "h", "w"], (1, 84, 8400))
        self.assertEqual((lay.width, lay.height), (640, 640))

    def test_end2end_shape(self):
        self.assertEqual(yolo.detect_layout([1, 3, 640, 640], (1, 300, 6)).kind, "end2end")

    def test_custom_class_names_from_metadata(self):
        lay = yolo.detect_layout([1, 3, 640, 640], (1, 6, 8400), {"names": "{0: 'cat', 1: 'dog'}"})
        self.assertEqual(lay.names, ("cat", "dog"))

    def test_unknown_class_count_without_names_is_readable_error(self):
        with self.assertRaisesRegex(yolo.ModelFormatError, "3 個類別"):
            yolo.detect_layout([1, 3, 640, 640], (1, 7, 8400))

    def test_class_names_become_keys(self):
        lay = yolo.detect_layout([1, 3, 640, 640], (1, 7, 8400), {"names": "{0: 'Package', 1: 'traffic light', 2: '包裹'}"})
        self.assertEqual(lay.names, ("package", "traffic_light", "class_2"))
        self.assertEqual(lay.titles, ("Package", "traffic light", "包裹"))

    def test_unrecognised_output_is_readable_error(self):
        with self.assertRaisesRegex(yolo.ModelFormatError, "看不懂模型的輸出形狀"):
            yolo.detect_layout([1, 3, 640, 640], (1, 1000))

    def test_non_image_input(self):
        with self.assertRaisesRegex(yolo.ModelFormatError, "輸入"):
            yolo.detect_layout([1, 10], (1, 84, 8400))


class PreprocessTest(unittest.TestCase):
    def setUp(self):
        # 左半紅、右半藍的 200×100 圖
        arr = np.zeros((100, 200, 3), dtype=np.uint8)
        arr[:, :100] = (255, 0, 0)
        arr[:, 100:] = (0, 0, 255)
        self.image = Image.fromarray(arr)

    def test_yolox_is_bgr_unscaled_and_padded_at_bottom(self):
        tensor, box = yolo.preprocess(self.image, layout("yolox", 64, 64))
        self.assertEqual(tensor.shape, (1, 3, 64, 64))
        self.assertEqual((box.ratio, box.pad_x, box.pad_y), (0.32, 0.0, 0.0))
        # 左上是紅色：BGR 的第 3 個通道是 R
        self.assertEqual(tensor[0, :, 5, 5].tolist(), [0.0, 0.0, 255.0])
        self.assertEqual(tensor[0, 0, 60, 5], 114.0)

    def test_ultralytics_is_rgb_scaled_and_centered(self):
        tensor, box = yolo.preprocess(self.image, layout("ultralytics", 64, 64))
        self.assertEqual((box.pad_x, box.pad_y), (0.0, 16.0))
        self.assertAlmostEqual(float(tensor[0, 0, 32, 5]), 1.0)
        self.assertAlmostEqual(float(tensor[0, 0, 2, 5]), 114 / 255, places=5)


class DecodeTest(unittest.TestCase):
    def test_yolox_grid_decode(self):
        lay = layout("yolox", 64, 64)
        pred = np.zeros((1, yolo.grid_count(64, 64), 85), dtype=np.float32)
        # stride 8 的格點 (x=3, y=2)：中心 ((3+0.5)*8, (2+0.5)*8)，寬高 exp(log 16)*8 / 8 → 16
        idx = 2 * 8 + 3
        pred[0, idx, :4] = (0.5, 0.5, np.log(2.0), np.log(2.0))
        pred[0, idx, 4] = 0.9
        pred[0, idx, 5 + 15] = 0.8  # cat
        boxes, scores, ids = yolo.decode(pred, lay)
        best = int(scores.argmax())
        np.testing.assert_allclose(boxes[best], [20, 12, 36, 28], atol=1e-4)
        self.assertAlmostEqual(float(scores[best]), 0.72, places=5)
        self.assertEqual(int(ids[best]), 15)

    def test_ultralytics_restores_original_coordinates(self):
        lay = layout("ultralytics", 64, 64)
        out = np.zeros((1, 84, yolo.grid_count(64, 64)), dtype=np.float32)
        # 置中 letterbox：200×100 → 64×32，上方補 16；原圖中心 (100, 50)、80×40 的框
        out[0, :4, 0] = (32, 32, 25.6, 12.8)
        out[0, 4 + 2, 0] = 0.9  # car
        box = yolo.Letterbox(0.32, 0.0, 16.0, 200, 100)
        (det,) = yolo.postprocess(out, lay, box)
        self.assertEqual(det.label, "car")
        np.testing.assert_allclose(det.box, (0.3, 0.3, 0.7, 0.7), atol=1e-4)

    def test_nms_is_per_class(self):
        lay = layout("end2end")
        out = np.array([[[10, 10, 50, 50, 0.9, 0], [12, 12, 50, 50, 0.8, 0], [10, 10, 50, 50, 0.7, 2]]], dtype=np.float32)
        dets = yolo.postprocess(out, lay, yolo.Letterbox(1.0, 0, 0, 640, 640))
        self.assertEqual([(d.label, round(d.score, 2)) for d in dets], [("person", 0.9), ("car", 0.7)])

    def test_low_scores_are_dropped(self):
        lay = layout("end2end")
        out = np.array([[[10, 10, 50, 50, 0.1, 0]]], dtype=np.float32)
        self.assertEqual(yolo.postprocess(out, lay, yolo.Letterbox(1.0, 0, 0, 640, 640)), [])


CPU = eng.Device("cpu", "cpu", "Test CPU")
GPU0 = eng.Device("nvidia:GPU-aaa", "nvidia", "RTX A", index=0)
GPU1 = eng.Device("nvidia:GPU-bbb", "nvidia", "GTX B", index=1)
IGPU = eng.Device("intel:GPU.0", "intel", "UHD 630", ov_device="GPU.0")


def fake_probe(**kw) -> eng.Probe:
    base = dict(ort_version="x", providers=["CPUExecutionProvider"], openvino_plugin=None, openvino_plugin_error=None,
                dri_nodes=[], dri_accessible=False, nvidia_nodes=[], devices=[CPU])
    base.update(kw)
    return eng.Probe(**base)


def gpu_probe() -> eng.Probe:
    return fake_probe(providers=["CUDAExecutionProvider", "CPUExecutionProvider"], nvidia_nodes=["/dev/nvidia0", "/dev/nvidia1"],
                      openvino_plugin="/x.so", dri_nodes=["/dev/dri/renderD128"], dri_accessible=True, devices=[CPU, GPU0, GPU1, IGPU])


class DeviceChoiceTest(unittest.TestCase):
    def test_auto_tries_nvidia_then_intel_then_cpu(self):
        self.assertEqual(eng.auto_candidates(gpu_probe()), [GPU0, GPU1, IGPU, CPU])
        self.assertEqual(eng.auto_candidates(fake_probe()), [CPU])

    def test_a_specific_card_is_chosen_by_its_stable_id(self):
        self.assertEqual(eng.resolve("nvidia:GPU-bbb", gpu_probe()), ([GPU1, CPU], None))

    def test_a_missing_card_falls_back_to_auto_with_a_reason(self):
        candidates, reason = eng.resolve("nvidia:GPU-gone", gpu_probe())
        self.assertEqual(candidates, [GPU0, GPU1, IGPU, CPU])
        self.assertIn("找不到", reason.reason)
        candidates, reason = eng.resolve("nvidia:GPU-gone", fake_probe())
        self.assertEqual(candidates, [CPU])
        self.assertIn("latest-nvidia", reason.reason)

    def test_kind_shorthand_picks_the_first_of_that_kind(self):
        self.assertEqual(eng.resolve("intel", gpu_probe())[0], [IGPU, CPU])

    def test_intel_reasons_name_the_missing_piece(self):
        self.assertIn("沒有 Intel", eng.unavailable_reason("intel", fake_probe()).reason)
        self.assertIn("/dev/dri", eng.unavailable_reason("intel", fake_probe(openvino_plugin="/x.so")).reason)
        no_perm = fake_probe(openvino_plugin="/x.so", dri_nodes=["/dev/dri/renderD128"])
        self.assertIn("render", eng.unavailable_reason("intel", no_perm).reason)

    def test_nvidia_reasons(self):
        self.assertIn("latest-nvidia", eng.unavailable_reason("nvidia", fake_probe()).reason)
        p = fake_probe(providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        self.assertIn("Container Toolkit", eng.unavailable_reason("nvidia", p).reason)


@unittest.skipUnless(HAS_MODEL, "run detector/fetch_model.py first")
class ModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import onnxruntime as ort

        cls.ort = ort

    def test_builtin_model_finds_person_and_car_where_they_are(self):
        loaded = eng.load(self.ort, MODEL, "cpu")
        self.assertEqual(loaded.engine.layout.kind, "yolox")
        dets = {d.label: d for d in loaded.engine.infer_image(test_image()) if d.score >= 0.5}
        self.assertEqual(set(dets), {"person", "car"})
        # 行人貼在 (300, 330)、150×203；汽車在 (572, 310)–(690, 355)
        px1, py1, px2, py2 = dets["person"].box
        self.assertTrue(0.23 < (px1 + px2) / 2 < 0.36 and 0.5 < (py1 + py2) / 2 < 0.68, dets["person"].box)
        cx1, cy1, cx2, cy2 = dets["car"].box
        self.assertTrue(0.44 < (cx1 + cx2) / 2 < 0.54 and 0.42 < (cy1 + cy2) / 2 < 0.5, dets["car"].box)

    def test_jpeg_path_matches_image_path(self):
        loaded = eng.load(self.ort, MODEL, "cpu")
        buf = io.BytesIO()
        test_image().resize((640, 360)).save(buf, "JPEG", quality=80)
        labels = {d.label for d in loaded.engine.infer_jpeg(buf.getvalue()) if d.score >= 0.5}
        self.assertEqual(labels, {"person", "car"})

    def test_missing_gpu_falls_back_to_cpu_with_reason(self):
        loaded = eng.load(self.ort, MODEL, "nvidia", fake_probe())
        self.assertEqual(loaded.engine.device.kind, "cpu")
        self.assertIn("latest-nvidia", loaded.fallback.reason)

    def test_garbage_file_raises(self):
        with tempfile.NamedTemporaryFile(suffix=".onnx") as f:
            f.write(b"not a model")
            f.flush()
            with self.assertRaises(Exception):
                eng.load(self.ort, f.name, "cpu")


@unittest.skipUnless(HAS_MODEL, "run detector/fetch_model.py first")
class WorkerProtocolTest(unittest.TestCase):
    def test_status_then_result_over_unix_socket(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as d:
            path = os.path.join(d, "s")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "main.py"), "--socket", path, "--device", "cpu", "--model", MODEL])
            try:
                server.settimeout(20)
                conn, _ = server.accept()
                conn.settimeout(30)
                reader = conn.makefile("rb")

                def read_json():
                    kind, n = struct.unpack(">BI", reader.read(5))
                    self.assertEqual(kind, 1)
                    return json.loads(reader.read(n))

                def next_of(kind):
                    while True:
                        msg = read_json()
                        if msg["type"] == kind:
                            return msg

                self.assertEqual(next_of("status")["state"], "loading")
                ready = next_of("status")
                self.assertEqual((ready["state"], ready["device"], ready["fallback"]), ("ready", "cpu", None))
                self.assertEqual(ready["model"]["format"], "yolox")
                buf = io.BytesIO()
                test_image().resize((640, 360)).save(buf, "JPEG")
                body = struct.pack(">I", 7) + buf.getvalue()
                conn.sendall(struct.pack(">BI", 2, len(body)) + body)
                result = next_of("result")
                self.assertEqual(result["id"], 7)
                self.assertIn("person", {d["label"] for d in result["detections"]})
                cmd = json.dumps({"type": "bench", "devices": ["cpu"], "seconds": 3}).encode()
                conn.sendall(struct.pack(">BI", 1, len(cmd)) + cmd)
                progress = next_of("bench-progress")
                self.assertEqual(progress["device"], "cpu")
                bench = next_of("bench-result")
                self.assertEqual(bench["cancelled"], False)
                self.assertEqual(bench["results"][0]["device"], "cpu")
                self.assertGreater(bench["results"][0]["fps"], 1)
                bad = struct.pack(">I", 8) + b"nope"
                conn.sendall(struct.pack(">BI", 2, len(bad)) + bad)
                self.assertIn("error", next_of("result"))
            finally:
                proc.kill()
                proc.wait()
                server.close()

    def test_invalid_model_reports_error_and_stays_up(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as d:
            path = os.path.join(d, "s")
            model = os.path.join(d, "broken.onnx")
            with open(model, "wb") as f:
                f.write(b"garbage")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "main.py"), "--socket", path, "--model", model])
            try:
                server.settimeout(20)
                conn, _ = server.accept()
                conn.settimeout(30)
                reader = conn.makefile("rb")
                msgs = []
                while not any(m.get("state") == "error" for m in msgs):
                    kind, n = struct.unpack(">BI", reader.read(5))
                    msgs.append(json.loads(reader.read(n)))
                self.assertIn("ONNX", next(m for m in msgs if m.get("state") == "error")["error"])
                kind, n = struct.unpack(">BI", reader.read(5))
                self.assertEqual(json.loads(reader.read(n))["type"], "heartbeat")
                self.assertIsNone(proc.poll())
            finally:
                proc.kill()
                proc.wait()
                server.close()


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAS_MODEL, "run detector/fetch_model.py first")
class BenchTest(unittest.TestCase):
    def test_benchmark_counts_frames_and_can_be_cancelled(self):
        import onnxruntime as ort
        from testimage import test_jpeg

        engine = eng.load(ort, MODEL, "cpu").engine
        r = eng.benchmark(engine, test_jpeg(), seconds=1.0, warmup_s=0.2)
        self.assertGreater(r["frames"], 3)
        self.assertAlmostEqual(r["fps"], 1000 / r["msMean"], delta=r["fps"] * 0.3)
        self.assertIsNone(eng.benchmark(engine, test_jpeg(), seconds=5, warmup_s=0.2, stop=lambda: True))
