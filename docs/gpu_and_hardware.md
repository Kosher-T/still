# GPU and Hardware Management

This document specifies RhemaCast's hardware requirements, VRAM budget, GPU thermal monitoring, and the programmable power throttling mechanism that prevents catastrophic GPU crashes during a live service.

---

## System Requirements

| Resource | Minimum | Notes |
|----------|---------|-------|
| **GPU** | NVIDIA, 4 GB dedicated VRAM | Must be exclusively available for the STT model; no other GPU-accelerated applications should run simultaneously |
| **RAM** | 16 GB | Hosts FAISS index, BM25 index, ONNX embedding model, all queues, SQLite, and the Python runtime |
| **CPU** | Modern multi-core (Intel i5 / AMD Ryzen 5 or better) | Drives semantic search, BM25, intent classification, database writes, and the Vosk failover model |
| **OS** | Windows (primary target), Linux (development & secondary target) | See [architecture.md](architecture.md) for the VFIO GPU passthrough development workflow |
| **Privileges** | Root (Linux) / Run as Administrator (Windows) | **Required** — NVML power state modification commands are rejected without elevated privileges |
| **Storage** | SSD recommended | For SQLite WAL writes and append-only flat file; HDD introduces latency risk on micro-writes |

---

## VRAM Budget

The 4 GB VRAM is a hard constraint. Only one model is permitted to reside in VRAM at any time.

| Allocation | VRAM Usage | Notes |
|------------|------------|-------|
| **Primary STT model** (Faster-Whisper, fine-tuned) | ~1–2 GB | Varies by model size (tiny/base/small) |
| **CUDA runtime overhead** | ~500 MB | Driver, context, cuDNN/cuBLAS kernels |
| **Inference workspace** | ~500 MB – 1 GB | Intermediate activations, KV cache during beam search |
| **Remaining headroom** | ~500 MB – 2 GB | Safety buffer for memory fragmentation spikes |

> [!IMPORTANT]
> **No other model touches VRAM.** The semantic embedding model (`all-MiniLM-L6-v2`) runs via ONNX Runtime on the CPU execution provider. FAISS runs on CPU. This is a deliberate architectural constraint — not a performance trade-off — to guarantee VRAM isolation for the STT engine.

---

## GPU Thermal Monitoring

A dedicated background thread (Thread 5: Hardware Monitor) continuously polls the GPU die temperature and intervenes to prevent thermal crashes.

### Monitoring Library: pynvml

All GPU interaction uses the **NVIDIA Management Library (NVML)**, accessed in Python through the `pynvml` package. This API interfaces directly with the NVIDIA driver to read telemetry and modify power states without altering the AI models loaded in VRAM.

### Initialization

During Phase 1 (Initialization), alongside model loading:

```python
import pynvml

pynvml.nvmlInit()
handle = pynvml.nvmlDeviceGetHandleByIndex(0)  # Primary GPU
```

The `handle` is stored and shared with the hardware monitoring thread.

### Active Polling Loop

Thread 5 runs a continuous polling loop:

```python
while service_active:
    temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
    
    if temp >= CRITICAL_THRESHOLD:
        throttle_gpu(handle)
    elif temp <= SAFE_BASELINE and is_throttled:
        restore_gpu(handle)
    
    time.sleep(POLL_INTERVAL)
```

### Thermal Thresholds

| Threshold | Value | Action |
|-----------|-------|--------|
| **Critical** | 82°C (configurable) | Trigger GPU power throttling |
| **Safe baseline** | 70°C (configurable) | Restore full power after throttling event |
| **Poll interval** | 2–5 seconds (configurable) | Frequency of temperature checks |

> [!TIP]
> These threshold values should be calibrated per-GPU during testing. Consumer GPUs (GTX 1650, RTX 3060) have different thermal envelopes than professional cards. Start conservative (80°C critical) and adjust based on observed behavior during 2-hour stress tests.

---

## GPU Power Throttling Mechanism

When the critical thermal threshold is exceeded, the system uses **hardware-level power limiting** to downclock the GPU without unloading the STT model from VRAM.

### How It Works

1. **Throttle command:** The monitoring thread calls `pynvml.nvmlDeviceSetPowerManagementLimit()` to reduce the GPU's maximum wattage allowance.
2. **Firmware response:** The NVIDIA firmware instantly forces the GPU to downclock its core and memory frequencies to operate within the new power envelope.
3. **Inference impact:** The STT model continues running — it is NOT unloaded from VRAM — but inference executes at reduced clock speeds, producing a **slight delay in transcription output**.
4. **Restoration:** Once temperatures drop to the safe baseline, a second `nvmlDeviceSetPowerManagementLimit()` call restores the original power limit, instantly returning inference to full real-time speeds.

### Example Power Values

| State | Power Limit | Effect |
|-------|-------------|--------|
| **Normal operation** | 75W (default TDP) | Full-speed inference |
| **Throttled** | 45W (reduced) | ~40% clock reduction, noticeable but acceptable transcription delay |

```python
# Throttle
THROTTLED_POWER = 45_000  # milliwatts
pynvml.nvmlDeviceSetPowerManagementLimit(handle, THROTTLED_POWER)

# Restore
DEFAULT_POWER = pynvml.nvmlDeviceGetPowerManagementDefaultLimit(handle)
pynvml.nvmlDeviceSetPowerManagementLimit(handle, DEFAULT_POWER)
```

> [!CAUTION]
> **Root or administrator privileges are mandatory.** The `nvmlDeviceSetPowerManagementLimit()` command will be **silently rejected** by the driver if the application is not running with elevated privileges. The application must enforce a privilege check at startup and warn the operator if running unprivileged.

**Cross-platform privilege detection:**

```python
import sys
import os

def check_admin_privileges() -> bool:
    if sys.platform == 'win32':
        import ctypes
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    else:
        return os.geteuid() == 0
```

### Relationship to Vosk Failover

GPU power throttling is **not** the same as the Vosk failover. The hierarchy is:

1. **Normal operation** → Full-speed GPU inference.
2. **Thermal event** → GPU throttled via power limiting. STT continues on GPU at reduced speed. Delay is acceptable.
3. **Catastrophic GPU failure** (crash, OOM, unrecoverable thermal shutdown) → GPU model abandoned entirely. Vosk initialized on CPU. Audio chunks replayed via acknowledgment receipt protocol.

Vosk is the **absolute last resort**. GPU throttling exists specifically to prevent reaching this state. See [threading_and_lifecycle.md](threading_and_lifecycle.md) for the Vosk failover protocol.

---

## Hardware Diagnostics Dashboard

Thread 5 should expose the following telemetry to the operator UI:

| Metric | Source | Update Frequency |
|--------|--------|-----------------|
| GPU die temperature (°C) | `nvmlDeviceGetTemperature()` | Every poll cycle |
| Current power draw (W) | `nvmlDeviceGetPowerUsage()` | Every poll cycle |
| Power limit (W) | `nvmlDeviceGetPowerManagementLimit()` | On change |
| VRAM usage (MB) | `nvmlDeviceGetMemoryInfo()` | Every poll cycle |
| GPU utilization (%) | `nvmlDeviceGetUtilizationRates()` | Every poll cycle |
| Throttle state | Internal flag | On change |

> [!TIP]
> Displaying VRAM usage in the operator UI provides an early warning if memory leaks cause VRAM consumption to creep toward 4 GB during a long service. This metric should be logged to the database for post-service diagnostics.

---

## CPU & RAM Monitoring (Extension)

In addition to GPU metrics, Thread 5 is responsible for monitoring system memory (`psutil.virtual_memory()`) to prevent out-of-memory (OOM) crashes during long services.

### Memory Thresholds and Logging

Thread 5 polls `psutil.virtual_memory()` every 30 seconds.

```python
import psutil

while service_active:
    mem = psutil.virtual_memory()
    if mem.available < CRITICAL_RAM_THRESHOLD:  # 500 MB
        alert_operator(f"CRITICAL: Available RAM dropped to {mem.available / 1e6:.0f} MB")
        log_top_10_tracemalloc()
        graceful_shutdown()
    time.sleep(30)
```

*   **Critical RAM Threshold (500 MB):** If available system RAM drops below **500 MB**, Thread 5 pushes a critical alert to the operator and initiates a **graceful service shutdown** — queued transcriptions are flushed to disk, active connections are drained, and the service exits cleanly — to prevent an unmanaged OS-level OOM kill.
*   **Forensic Profiling (`tracemalloc`):** When the critical threshold is crossed, the system immediately captures the top 10 memory-consuming Python object allocations via `tracemalloc`. This snapshot is saved to the diagnostics log for post-mortem leak analysis (unbounded queues, dangling references, accumulating caches).

---

## Cross-Platform GPU Considerations

RhemaCast is developed on Linux and targets Windows as its primary deployment platform. The GPU subsystem is largely platform-agnostic, but several areas require attention:

### NVML / pynvml

`pynvml` wraps the NVIDIA Management Library (NVML), which provides an identical API on both Windows and Linux. The same Python code for temperature polling, power throttling, and VRAM monitoring works on both platforms without modification. The underlying NVML shared library is bundled with the NVIDIA display driver on both OSes.

### CUDA Runtime

The CTranslate2 backend (used by Faster-Whisper) requires CUDA runtime libraries:

| Platform | CUDA Libraries | Installation |
|----------|---------------|--------------|
| **Windows** | `cublas64_*.dll`, `cudnn*.dll` | Installed via the NVIDIA CUDA Toolkit. **NOT bundled** in the PyInstaller `.exe` to prevent DLL version conflicts. |
| **Linux** | `libcublas.so`, `libcudnn.so` | Installed via the system package manager or NVIDIA's `.run` installer. |

> [!CAUTION]
> **DLL Hell Prevention (Windows):** Never bundle CUDA DLLs inside the PyInstaller `.exe`. If the bundled version differs from the driver's expected version, inference will silently fail. Assume the CUDA Toolkit is installed on the target system. See [architecture.md](architecture.md) for the full PyInstaller packaging strategy.

### VFIO Development Workflow

During development, the NVIDIA GPU is dynamically passed through to a Windows VM via VFIO for testing. A libvirt hook script handles the GPU binding/unbinding automatically. This enforces the architecture's exclusive GPU isolation mandate at the hypervisor level — it is physically impossible for Linux and the Windows VM to contend for VRAM simultaneously. See [architecture.md](architecture.md) for the full workflow.

### Driver Differences

| Aspect | Windows | Linux |
|--------|---------|-------|
| **Driver installation** | NVIDIA GeForce Experience / standalone `.exe` | Package manager (`nvidia-driver-*`) or `.run` installer |
| **NVML library path** | System PATH (auto-included with driver) | `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so` |
| **Privilege model** | Run as Administrator / UAC elevation | `sudo` / root |

---

## Formal Memory Budgets

### VRAM Budget (GTX 1650, 4 GB)

| Allocation | Budget | Notes |
|------------|--------|-------|
| Faster-Whisper | 3 GB | Max reservation for the STT model |
| CUDA overhead (context, cuDNN/cuBLAS kernels) | 500 MB | Driver, context, kernel caches |
| Safety margin | 500 MB | Fragmentation spikes, transient allocations |
| **Total** | **4 GB** | Budget is a hard ceiling — reject model upgrades that exceed it |

> [!CAUTION]
> Model selection logic **must** enforce this budget: if a requested model variant (e.g., `small` → `medium`) would exceed the 3 GB Faster-Whisper allocation, the upgrade is rejected and the current model continues running. See [ai_models.md](ai_models.md) for the model upgrade protocol.

### RAM Budget (16 GB System)

| Allocation | Budget |
|------------|--------|
| FAISS (186K × 384-dim vectors) | 300 MB |
| BM25 inverted index | 100 MB |
| SQLite cache (WAL) | 256 MB |
| Embedding model (ONNX Runtime) | 200 MB |
| UI (PyQt) | 150 MB |
| Audio buffers & queues | 100 MB |
| Operating system and other processes | ~4 GB |
| **Total accounted** | **~5.1 GB** |
| **Headroom (> 2 GB free)** | **~10.9 GB available** |

> [!TIP]
| The > 2 GB headroom ensures that transcription spikes, temporary model re-loads, and unforeseen memory growth during long services do not trigger an OOM condition. Combined with the psutil monitoring above, this budget provides two layers of protection against RAM exhaustion.

---

## Cross-References

- **VRAM allocation per model:** [ai_models.md](ai_models.md)
- **Audio hardware requirements:** [audio_ingestion.md](audio_ingestion.md)
- **Vosk failover protocol:** [threading_and_lifecycle.md](threading_and_lifecycle.md)
- **Thread 5 in the threading model:** [architecture.md](architecture.md)
- **Cross-platform development strategy:** [architecture.md](architecture.md)
- **PyInstaller packaging:** [architecture.md](architecture.md)
