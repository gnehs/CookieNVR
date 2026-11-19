# 量測模組的測試樣本

- `linux-*`：在 colima（arm64 Linux 6.x，cgroup v2）裡的 `oven/bun:1.4.4-slim` 容器實際讀到的 `/sys/fs/cgroup/memory.stat`、`/proc/meminfo`、`/proc/1/stat`。
- `macos-*`：開發機（Apple M5 Pro，macOS）實際執行 `vm_stat`、`ps -A -o pid=,ppid=,rss=,time=`、`ioreg -r -d 1 -w 0 -c IOAccelerator` 的輸出。
- `nvidia-smi.csv`：依 NVIDIA nvidia-smi 文件（https://docs.nvidia.com/deploy/nvidia-smi/index.html）的 `--query-gpu=… --format=csv,noheader,nounits` 格式手寫，欄位順序是 `src/metrics/parse.ts` 的 `NVIDIA_QUERY`；讀不到的值依文件寫成 `[N/A]`。不是實機輸出。
- `i915-fdinfo-*.txt`：依 Linux kernel 文件 i915 DRM client usage stats（https://docs.kernel.org/gpu/i915.html#i915-usage-stats）的範例手寫，`-b` 是 5 秒後同一個 client 的第二次讀取。不是實機輸出。
- `xe-fdinfo-*.txt`：依 Linux kernel 文件 Xe DRM client usage stats（https://docs.kernel.org/gpu/xe/xe-drm-usage-stats.html）的範例手寫。不是實機輸出。

使用者在實機上執行 `bun scripts/metrics-probe.ts` 後，可以把真的 nvidia-smi 與 fdinfo 輸出補進來取代手寫的樣本。
