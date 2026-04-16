# GPU and Hardware Management

This document specifies Still's hardware requirements, VRAM budget, GPU thermal monitoring, and the programmable power throttling mechanism that prevents catastrophic GPU crashes during a live service.

---

## System Requirements

| Resource | Minimum | Notes |
|----------|---------|-------|
| **GPU** | NVIDIA, 4 GB dedicated VRAM | Must be exclusively available for the STT model; no other GPU-accelerated applications should run simultaneously |
| **RAM** | 16 GB | Hosts FAISS index, BM25 index, ONNX embedding model, DistilBERT, all queues, SQLite, and the Python runtime |
| **CPU** | Modern multi-core (Intel i5 / AMD Ryzen 5 or better) | Drives semantic search, BM25, intent classification, database writes, and the Vosk failover model |
| **OS** | Linux (Windows and macOS support planned) | |
| **Privileges** | Root / Administrator | **Required** — NVML power state modification commands are rejected without elevated privileges |
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
> **No other model touches VRAM.** The semantic embedding model (`all-MiniLM-L6-v2`) runs via ONNX Runtime on the CPU execution provider. DistilBERT runs on CPU. FAISS runs on CPU. This is a deliberate architectural constraint — not a performance trade-off — to guarantee VRAM isolation for the STT engine.

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

## Cross-References

- **VRAM allocation per model:** [ai_models.md](ai_models.md)
- **Audio hardware requirements:** [audio_ingestion.md](audio_ingestion.md)
- **Vosk failover protocol:** [threading_and_lifecycle.md](threading_and_lifecycle.md)
- **Thread 5 in the threading model:** [architecture.md](architecture.md)
