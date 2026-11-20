import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tempfile  # noqa: E402

from engine import INTEL_VENDOR, is_intel_gpu, missing_by_path  # noqa: E402


class ByPathTest(unittest.TestCase):
    def test_nvidia_only_by_path_hides_the_intel_igpu(self):
        # 實機：NVIDIA Container Toolkit 建的 by-path 只有 Nvidia 的卡
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "pci-0000:01:00.0-render"), "w").close()
            self.assertEqual(missing_by_path(["0000:00:02.0"], d), ["0000:00:02.0"])
            open(os.path.join(d, "pci-0000:00:02.0-render"), "w").close()
            self.assertEqual(missing_by_path(["0000:00:02.0"], d), [])

    def test_no_by_path_directory_is_fine(self):
        # 沒有 by-path 時驅動改掃 renderD*
        self.assertEqual(missing_by_path(["0000:00:02.0"], "/nonexistent/by-path"), [])


class IntelGpuTest(unittest.TestCase):
    def test_nvidia_card_seen_through_its_opencl_icd_is_not_intel(self):
        # 使用者在 -nvidia 映像看到的實際名稱；ONNX Runtime 回報的 vendor_id 是 0
        self.assertFalse(is_intel_gpu(0, "", "NVIDIA GeForce RTX 5060 Ti (dGPU)"))

    def test_intel_igpu_by_name_or_vendor_id(self):
        self.assertTrue(is_intel_gpu(0, "", "Intel(R) UHD Graphics 730 (iGPU)"))
        self.assertTrue(is_intel_gpu(0, "Intel Corporation", "GPU.0"))
        self.assertTrue(is_intel_gpu(INTEL_VENDOR, "", "Arc A380 (dGPU)"))

    def test_openvino_architecture_vendor_wins_over_the_name(self):
        self.assertFalse(is_intel_gpu(0, "", "NVIDIA GeForce RTX 5060 Ti (dGPU)", "GPU: vendor=0x10de arch=v12.0.0"))
        self.assertTrue(is_intel_gpu(0, "", "GPU", "GPU: vendor=0x8086 arch=v12.55.8"))

    def test_unknown_vendor_without_intel_in_the_name_is_left_out(self):
        self.assertFalse(is_intel_gpu(0, "", "GPU.1"))
        self.assertFalse(is_intel_gpu(0x1002, "", "AMD Radeon RX 7600 (dGPU)"))


if __name__ == "__main__":
    unittest.main()
