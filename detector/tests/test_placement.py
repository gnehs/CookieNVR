import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import engine as eng  # noqa: E402

CPU_EP = "CPUExecutionProvider"
OV_EP = "OpenVINOExecutionProvider"
CUDA_EP = "CUDAExecutionProvider"

CPU = eng.Device("cpu", "cpu", "Test CPU")
IGPU = eng.Device("intel:GPU.0", "intel", "Intel UHD Graphics 630", ov_device="GPU.0")
GPU = eng.Device("nvidia:GPU-aaa", "nvidia", "RTX 5060 Ti", index=0)


def node(name: str, provider: str, dur: int, ts: int) -> dict:
    return {"cat": "Node", "name": f"{name}_kernel_time", "ts": ts, "dur": dur, "ph": "X", "args": {"provider": provider, "op_name": name}}


def run(ts: int, nodes: list[tuple[str, str, int]]) -> list[dict]:
    """一次 model_run 與它裡面的節點，形狀照 ONNX Runtime 1.32 實際寫出的 profile。"""
    events, t = [], ts + 10
    for name, provider, dur in nodes:
        events.append({"cat": "Node", "name": f"{name}_fence_before", "ts": t, "dur": 0, "args": {"op_name": name}})
        events.append(node(name, provider, dur, t))
        t += dur + 1
    events.append({"cat": "Session", "name": "SequentialExecutor::Execute", "ts": ts + 5, "dur": t - ts, "args": {}})
    events.append({"cat": "Session", "name": "model_run", "ts": ts, "dur": t - ts + 10, "args": {}})
    return events


def profile(*runs: list[tuple[str, str, int]]) -> list[dict]:
    events = [{"cat": "Session", "name": "model_loading_uri", "ts": 0, "dur": 100, "args": {}},
              {"cat": "Session", "name": "session_initialization", "ts": 100, "dur": 100, "args": {}}]
    ts = 1000
    for r in runs:
        events += run(ts, r)
        ts += 100_000
    return events


CPU_ONLY = [("Conv", CPU_EP, 900), ("QuickGelu", CPU_EP, 300), ("Concat", CPU_EP, 50)]
# OpenVINO 把整張圖編成一個子圖，profile 裡只有一個節點
OPENVINO_ALL = [("OpenVINOExecutionProvider_OpenVINO-EP-subgraph_1_0", OV_EP, 8000)]
# OpenVINO 認領不了：EP 在 get_providers() 裡，但每個節點都落在 CPU EP
OPENVINO_NONE = CPU_ONLY
# CUDA 把 Shape、Gather 這類形狀計算留在 CPU 是正常的
CUDA_WITH_SHAPE_NODES = [("Conv", CUDA_EP, 400), ("Conv", CUDA_EP, 400), ("Shape", CPU_EP, 3), ("Gather", CPU_EP, 2),
                         ("MemcpyToHost", CUDA_EP, 20)]
OPENVINO_PARTIAL = [("OpenVINOExecutionProvider_OpenVINO-EP-subgraph_1_0", OV_EP, 600), ("NonMaxSuppression", CPU_EP, 400)]


class PlacementTest(unittest.TestCase):
    def test_cpu_only(self):
        self.assertEqual(eng.placement_of(profile(CPU_ONLY)), {CPU_EP: 1.0})

    def test_openvino_compiled_subgraph_counts_as_openvino(self):
        p = eng.placement_of(profile(OPENVINO_ALL))
        self.assertEqual(p, {OV_EP: 1.0})
        self.assertEqual(eng.device_share(p), 1.0)

    def test_cuda_with_shape_nodes_on_cpu_is_mostly_cuda(self):
        p = eng.placement_of(profile(CUDA_WITH_SHAPE_NODES))
        self.assertEqual(list(p), [CUDA_EP, CPU_EP])
        self.assertAlmostEqual(p[CPU_EP], 5 / 825, places=3)

    def test_only_the_last_run_counts(self):
        # 第一次跑在 CPU 上花很久（暖機），第二次才是實際分配
        p = eng.placement_of(profile([("Conv", CPU_EP, 50_000)], OPENVINO_ALL))
        self.assertEqual(p, {OV_EP: 1.0})

    def test_no_node_events_is_unknown(self):
        self.assertIsNone(eng.placement_of([{"cat": "Session", "name": "model_run", "ts": 0, "dur": 5}]))
        self.assertIsNone(eng.placement_of([]))

    def test_text_lists_providers_largest_first(self):
        p = eng.placement_of(profile(OPENVINO_PARTIAL))
        self.assertEqual(eng.placement_text(p), "OpenVINOExecutionProvider 60%、CPUExecutionProvider 40%")
        self.assertEqual(eng.placement_text(None), "量不到")


class CheckPlacementTest(unittest.TestCase):
    def test_gpu_that_runs_nothing_is_rejected_in_plain_words(self):
        with self.assertRaises(eng.NotOnDevice) as cm:
            eng.check_placement(IGPU, eng.placement_of(profile(OPENVINO_NONE)))
        self.assertEqual(str(cm.exception), "Intel UHD Graphics 630沒有實際執行這個模型（OpenVINO把運算交回處理器）")
        self.assertEqual(cm.exception.placement, {CPU_EP: 1.0})

    def test_gpu_with_a_sliver_of_work_is_rejected(self):
        with self.assertRaises(eng.NotOnDevice):
            eng.check_placement(IGPU, {CPU_EP: 0.95, OV_EP: 0.05})

    def test_partial_and_normal_placements_are_used(self):
        eng.check_placement(GPU, eng.placement_of(profile(CUDA_WITH_SHAPE_NODES)))
        eng.check_placement(IGPU, eng.placement_of(profile(OPENVINO_PARTIAL)))

    def test_cpu_and_unknown_are_never_rejected(self):
        eng.check_placement(CPU, {CPU_EP: 1.0})
        eng.check_placement(IGPU, None)


class FakeSession:
    """build_engine 用到的 InferenceSession 介面；end_profiling 寫出給定的 profile。"""

    def __init__(self, prefix: str, events: list[dict], providers: list[str]):
        self.prefix, self.events, self.providers = prefix, events, providers
        self.ended = False

    def get_inputs(self):
        return [SimpleNamespace(name="images", shape=[1, 3, 416, 416], type="tensor(float)")]

    def run(self, _outputs, _feed):
        return [np.zeros((1, 3549, 85), dtype=np.float32)]

    def end_profiling(self) -> str:
        if self.ended:
            return ""
        self.ended = True
        path = f"{self.prefix}_1.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.events, f)
        return path

    def get_modelmeta(self):
        return SimpleNamespace(custom_metadata_map={})

    def get_providers(self):
        return self.providers


def fake_sessions(by_kind: dict[str, tuple[list[dict], list[str]]], created: list[FakeSession]):
    def create(_ort, _path, device, _p, profile_prefix=None):
        events, providers = by_kind[device.kind]
        s = FakeSession(profile_prefix, events, providers)
        created.append(s)
        return s

    return create


def probe_with(*devices: eng.Device) -> eng.Probe:
    return eng.Probe(ort_version="x", providers=[CPU_EP], openvino_plugin="/x.so", openvino_plugin_error=None,
                     dri_nodes=["/dev/dri/renderD129"], dri_accessible=True, nvidia_nodes=[], devices=list(devices))


class LoadTest(unittest.TestCase):
    def test_intel_that_hands_everything_back_falls_back_to_cpu_with_reason(self):
        created: list[FakeSession] = []
        sessions = {"intel": (profile(OPENVINO_NONE, OPENVINO_NONE), [OV_EP, CPU_EP]), "cpu": (profile(CPU_ONLY, CPU_ONLY), [CPU_EP])}
        with mock.patch.object(eng, "create_session", fake_sessions(sessions, created)):
            loaded = eng.load(None, "m.onnx", "intel:GPU.0", probe_with(CPU, IGPU))
        self.assertEqual(loaded.engine.device, CPU)
        self.assertEqual(loaded.fallback.reason, "Intel UHD Graphics 630沒有實際執行這個模型（OpenVINO把運算交回處理器），已改用其他裝置")
        self.assertIn("CPUExecutionProvider 100%", loaded.fallback.detail)
        self.assertEqual([a["ok"] for a in loaded.attempts], [False, True])
        self.assertTrue(all(s.ended for s in created))
        self.assertTrue(all(not os.path.exists(os.path.dirname(s.prefix)) for s in created), "profile 暫存目錄已刪除")

    def test_partial_gpu_is_used_and_reports_its_share(self):
        created: list[FakeSession] = []
        sessions = {"intel": (profile(OPENVINO_PARTIAL, OPENVINO_PARTIAL), [OV_EP, CPU_EP])}
        with mock.patch.object(eng, "create_session", fake_sessions(sessions, created)):
            loaded = eng.load(None, "m.onnx", "intel:GPU.0", probe_with(CPU, IGPU))
        self.assertEqual(loaded.engine.device, IGPU)
        self.assertIsNone(loaded.fallback)
        self.assertEqual(loaded.engine.placement, {OV_EP: 0.6, CPU_EP: 0.4})


if __name__ == "__main__":
    unittest.main()
