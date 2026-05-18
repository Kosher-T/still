# RhemaCast — Phased Development Plan (Revised)

**Target:** Windows .exe (primary) · Linux .deb (secondary)
**Dev machine:** Linux workstation with NVIDIA GTX 1650 · 16 GB RAM
**Constraint:** 4 GB VRAM, dedicated exclusively to Faster-Whisper STT

---

## Phase 0 — Dev Environment Setup

This phase is completed once. It creates the foundation every other phase depends on.

### 0.1 Linux Workstation Baseline

- [ ] Install KVM/QEMU and libvirt

      `sudo apt install qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils virt-manager`

- [ ] Verify IOMMU groups — GTX 1650 must be in its own clean group

      `dmesg | grep -i iommu`
      `find /sys/kernel/iommu_groups/ -type l | sort -V | head -40`

- [ ] Enable IOMMU in GRUB (Intel: `intel_iommu=on` / AMD: `amd_iommu=on`)
      Edit `/etc/default/grub` → `GRUB_CMDLINE_LINUX_DEFAULT`

      `sudo update-grub && reboot`

- [ ] Confirm `vfio-pci` module is available

      `lsmod | grep vfio`


### 0.2 VFIO GPU Passthrough — The libvirt Hook Script

The hook binds/unbinds the GPU between the Linux nvidia driver and vfio-pci automatically on VM start/stop. No manual rebinding or reboots.

- [ ] Note GPU PCI IDs

      `lspci -nn | grep NVIDIA`
      # Example output: `01:00.0 [10de:1f82]` (GPU), `01:00.1 [10de:10fa]` (Audio)

- [ ] Create libvirt hook for dynamic GPU rebinding: `/etc/libvirt/hooks/qemu`
      # On VM start: unbind nvidia → bind vfio-pci
      # On VM stop:  unbind vfio-pci → bind nvidia
      # Do NOT permanently blacklist nvidia via /etc/modprobe.d/vfio.conf —
      # static binding would prevent Linux from using the GPU for development.
      # The hook script handles dynamic binding/unbinding on VM start/stop.

      `chmod +x /etc/libvirt/hooks/qemu`

- [ ] Attach GPU to VM in virt-manager:
      Add Hardware → PCI Host Device → select GPU + Audio device

- [ ] Test: Boot Windows VM → confirm Device Manager shows GTX 1650
      Install NVIDIA driver inside VM
      Run `nvidia-smi.exe` to verify CUDA access

**Validation checkpoint:** From inside the Windows VM, run a quick Faster-Whisper test transcription on a sample WAV file. If it completes on GPU (cuda device), the passthrough is correct.

### 0.3 Windows VM Setup

Now that the GPU passthrough infrastructure is in place, create the Windows VM that will serve as the build and test environment for the Windows .exe target.

- [ ] **Download Windows ISO** from Microsoft:
      - Windows 11: https://www.microsoft.com/software-download/windows11
      - Select "Download Windows 11 Disk Image (ISO)" → Windows 11 (multi-edition ISO) → select language → download (~5.5 GB)
      - Alternatively, pre-built [Windows 11 Developer Edition VM](https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/) (includes WSL/dev tools, saves setup time)

- [ ] **Create the VM in virt-manager:**
      - Open virt-manager → File → New Virtual Machine
      - Select "Local install media (ISO image or CDROM)" → Forward → Browse → select the Windows ISO
      - RAM: 8192 MB (8 GB), CPUs: 4
      - Disk: 64 GB (dynamically allocated, qcow2 format)
      - Name: `Windows 11 Dev`

- [ ] **Configure VM firmware and devices:**
      - Settings → Overview → Firmware: select "UEFI x86_64: /usr/share/OVMF/OVMF_CODE_4M.fd"
      - Settings → CPU → Topology: match host topology
      - Settings → Add Hardware → PCI Host Device → select GTX 1650 GPU
      - Settings → Add Hardware → PCI Host Device → select GTX 1650 Audio device
      - Settings → Boot Options → enable cdrom as first boot device

- [ ] **Install Windows:**
      - Start the VM → press any key when prompted
      - Language/time → Install now → "I don't have a product key"
      - Select **Windows 11 Pro** → accept license terms
      - **Custom: Install Windows only (advanced)** → select unallocated space → Next
      - Wait for automated reboots to complete

- [ ] **Install VirtIO drivers and SPICE guest tools:**
      - Download `virtio-win.iso` from: https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
      - Attach ISO to VM: Storage → SATA CDROM → select the downloaded ISO
      - Inside the VM, open D: drive → run `virtio-win-gt-x64.msi`
      - Reboot the VM

- [ ] **Post-install Windows configuration:**
      - Windows Update → Check for updates → install all pending
      - Install essential tools:
            `winget install Microsoft.VisualStudioCode Git.Git Microsoft.WindowsTerminal`
      - Disable unnecessary animations for VM performance

- [ ] **Take a clean base snapshot:**
      - virt-manager → VM → Manage VM Snapshots → Create snapshot
      - Name: `base-install` — clean state before CUDA and dev tools
      - Allows quick rollback if the dev environment gets polluted

### 0.4 Python Environment — Both Platforms

Set up matching Python environments on Linux (dev) and inside the Windows VM (packaging + Windows testing).

- [ ] Python 3.11 — recommended for CTranslate2/Faster-Whisper compatibility
      Linux:   `sudo apt install python3.11 python3.11-venv python3.11-dev`
      Windows: installer from python.org (add to PATH)

- [ ] Create project virtualenv

      `python3.11 -m venv .venv`
      `source .venv/bin/activate`  (Linux)
      `.venv\Scripts\activate`     (Windows)

- [ ] Install core dependencies (both platforms)

      `pip install faster-whisper`
      `pip install sounddevice numpy`
      `pip install vosk`
      `pip install faiss-cpu`
      `pip install "sentence-transformers[onnx]" onnxruntime`
      `pip install rank_bm25`
      `pip install websockets aiohttp`
      `pip install pynvml`
      `pip install psutil`
      `pip install keyring`
      `pip install PyQt6`
      `pip install pyinstaller`  # Windows VM only, for packaging
      `pip install pytest pytest-qt`
      # Note: sqlite3 and unittest.mock are Python stdlib — no pip install needed

- [ ] Generate requirements file

      `pip freeze > requirements.txt`

- [ ] Verify GPU access in Python (Windows VM)

      `python -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"`
      # CTranslate2 is the backend used by faster-whisper — PyTorch is not required


### 0.5 Repository Structure

```
rhemacast/
├── core/
│   ├── audio_capture.py        # Thread 1
│   ├── stt_inference.py        # Thread 2
│   ├── search_engine.py        # Thread 3
│   ├── db_writer.py            # Thread 4
│   ├── hardware_monitor.py     # Thread 5
│   ├── websocket_server.py
│   ├── constants.py            # NEW: central timing/threshold constants
│   ├── config_schema.py        # NEW: config validation & versioning
│   ├── service_manager.py      # NEW: thread lifecycle & health
│   ├── events.py               # NEW: explicit event dataclasses
│   ├── errors.py               # NEW: error taxonomy
│   └── startup_checks.py       # NEW: pre-flight checklist
├── data/
│   ├── bible/                  # Raw Bible JSON/CSV sources
│   ├── indexes/                # FAISS .index + BM25 .pkl files (built offline)
│   └── intent_triggers.json
├── display/
│   ├── display.html
│   ├── display.js
│   └── themes.css
├── ui/                         # Operator UI (PyQt6)
├── cloud/
│   └── extraction.py
├── packaging/
│   ├── rhemacast.spec          # PyInstaller spec (Windows)
│   ├── rhemacast.iss           # Inno Setup script (Windows installer)
│   └── build_deb.sh            # Debian packaging script
├── tests/                      # NEW: unit & replay tests
│   ├── test_search.py
│   ├── test_intent.py
│   └── replay_session.py
├── config.json
├── .env.example
├── requirements.txt
└── main.py
```

### 0.6 CUDA Toolkit — Windows VM

- [ ] Download NVIDIA CUDA Toolkit (match your driver version)
      https://developer.nvidia.com/cuda-downloads
      Recommended: CUDA 12.x

- [ ] Install cuDNN (required by CTranslate2)
      https://developer.nvidia.com/cudnn
      Copy DLLs to CUDA bin directory

- [ ] Verify: `nvcc --version` (should report CUDA version)


### 0.X Tests & Validation

#### [NEW] `tests/test_phase0_env.py`
- [ ] `test_vfio_gpu_passthrough()` — Verify nvidia-smi works inside Windows VM.
- [ ] `test_python_deps_installed()` — Verify all pip packages (faster-whisper, sounddevice, vosk, faiss-cpu, sentence-transformers, rank_bm25, websockets, aiohttp, pynvml) import cleanly.
- [ ] `test_venv_isolated()` — Verify global site-packages aren't leaking into the virtualenv.
- [ ] **Integration Tests:** Verify faster-whisper and vosk load without errors in the isolated .venv.
- [ ] **Validation:** Confirm `startup_checks.py` correctly detects missing dependencies/hardware.

---

## Phase 1 — Bible Data Layer (Offline Index Building)

This phase builds the searchable Bible database and vector index. It runs once as an offline script, not during a live service.

### 1.1 Source the Bible Data

- [ ] Obtain Bible texts in structured format (JSON or CSV):
      KJV, NKJV, ESV, NIV, NLT, AMP — exactly these 6 versions
      Format: `{ "book": "John", "chapter": 3, "verse": 16, "text": "..." }`

- [ ] For public domain versions (KJV), download from a reliable source like `raw.githubusercontent.com/scrollmapper/bible_databases/`
- [ ] For copyrighted versions (NKJV, NIV, etc.), document that the user must supply their own files; include a converter script for OSIS/USFM/JSON
- [ ] Load into SQLite Bible database
      Table: `verses(id, version, book, chapter, verse_num, text)`
      Total rows: ~31,000 verses × 6 versions = ~186,000 rows

- [ ] **Version fingerprinting** – Store a hash of each source file used to build indexes. At runtime, verify loaded index matches current Bible database; if mismatched, rebuild automatically or warn.

### 1.2 Build the BM25 Inverted Index

- [ ] Normalize all verse texts (symmetric with live search normalization):
      - Strip apostrophes
      - Replace hyphens/dashes/slashes/colons with spaces
      - Lowercase
      - Strip custom stop-words: `{"the","is","a","and","to","of","in","that"}`
      - RETAIN archaic vocabulary: thou, hath, unto, thy, etc.

- [ ] Tokenize and build BM25 index with `rank_bm25`

      ```python
      from rank_bm25 import BM25Okapi
      bm25 = BM25Okapi(tokenized_corpus)
      ```

- [ ] Serialize and save

      ```python
      import pickle
      pickle.dump(bm25, open("data/indexes/bm25.pkl", "wb"))
      # Also save the verse reference lookup: index_position → (version, ref)
      ```

Expected size: ~50–100 MB on disk / in RAM.

### 1.3 Build the FAISS Vector Index

- [ ] Load all-MiniLM-L6-v2 via sentence-transformers

      ```python
      from sentence_transformers import SentenceTransformer
      model = SentenceTransformer("all-MiniLM-L6-v2")
      ```

- [ ] Encode all 186,000 verse texts → 384-dimensional vectors

      ```python
      # This takes ~20–40 minutes on CPU; run it once
      embeddings = model.encode(all_verse_texts, batch_size=256, show_progress_bar=True)
      ```

- [ ] Build FAISS index (FlatL2 or IndexFlatIP for cosine similarity)

      ```python
      import faiss
      index = faiss.IndexFlatIP(384)
      faiss.normalize_L2(embeddings)
      index.add(embeddings)
      ```

- [ ] Save index and reference lookup

      ```python
      faiss.write_index(index, "data/indexes/faiss.index")
      # Save: position → (version, book, chapter, verse_num, text)
      ```

Expected size: ~280 MB in RAM, ~280 MB on disk.

### 1.4 Validate the Indexes

- [ ] Write a quick test script: `search_test.py`
      - Run 10 known verse fragments through BM25 → confirm correct verse in Top 5
      - Run 10 paraphrased verses through FAISS → confirm semantic match in Top 5
      - Run 5 phrases through both → manually verify RRF fusion ranking



### 1.X Tests & Validation

#### [NEW] `tests/test_phase1_indexes.py`
- [ ] `test_regression_phase0()` — Verify Phase 0 dependencies still importable after Phase 1 changes.
- [ ] `test_bm25_stripping()` — Ensure punctuation/stop-words are stripped symmetrically (offline index build matches live search normalization).
- [ ] `test_index_fingerprint()` — Verify SHA256 hash matches between index build and index load.
- [ ] `test_version_fingerprint_mismatch()` — Force fingerprint mismatch by modifying source file; verify warning/rebuild is triggered.
- [ ] **Integration Tests:** Build small mock index and verify FAISS retrieves closest match.
- [ ] **Validation:** Run 10 known verses against indexes to ensure exact matches rank #1.

---

## Phase 2 — Core Infrastructure

Queues, database, WebSocket skeleton, and threading harness. No AI models yet. This is the connective tissue.

### 2.1 Central Configuration & Constants

**NEW:** `core/constants.py` – single source of truth for all magic numbers.

- [ ] Define:

      ```python
      SAMPLE_RATE = 16000
      BLOCK_SIZE = 1600
      WORD_WINDOW = 15
      WORD_OVERLAP = 6
      TOP_OF_QUEUE_THRESHOLD = 85      # confidence %
      DISCARD_THRESHOLD = 40
      GPU_CRITICAL_TEMP = 82
      GPU_SAFE_TEMP = 70
      QUEUE_A_MAXSIZE = 500
      QUEUE_B_MAXSIZE = 200
      DB_QUEUE_MAXSIZE = 1000
      OPERATOR_QUEUE_MAXSIZE = 100
      ```

- [ ] Add comments explaining the rationale for each constant.

**NEW:** `core/config_schema.py` – validate `config.json` on startup.

- [ ] Define required fields and defaults.
- [ ] Add `config_version` field; auto‑migrate old configs to latest schema.
- [ ] Fail boot if required fields missing.


### 2.2 Explicit Event Bus & Error Taxonomy

**NEW:** `core/events.py` – dataclasses for all inter‑thread payloads.

- [ ] Define `TranscriptChunk`, `SearchQuery`, `SearchResult`, `DisplayCommand`, `TelemetrySample`, etc.
- [ ] Version each event type to prevent schema drift.

**NEW:** `core/errors.py` – formal error hierarchy.

- [ ] `ComputeFailure`, `AudioDeviceLost`, `GPUOverheat`, `DatabaseWriteFailure`, `IndexMismatch`, `DisplayDisconnected`, `CloudExtractionFailure`
- [ ] Each error has attributes: `retryable`, `fatal`, `operator_visible`, `auto_recoverable`.

### 2.3 SQLite Database Setup

- [ ] Create database initialization module: `core/database.py`
      - Connect in WAL mode
      - `PRAGMA journal_mode=WAL`
      - `PRAGMA synchronous=NORMAL`
      - Create all tables: `transcripts`, `search_results`, `display_events`, `sessions`, `settings`, `metadata` (for schema version)
      - `sessions.audio_source` only accepts `"wireless"` — DFN3/room audio is deprecated; no other source values are valid

- [ ] Implement the Database Write Queue pattern

      ```python
      db_write_queue = queue.Queue()
      # Single-writer Thread 4 pulls and executes all inserts
      ```

- [ ] **Database migration strategy** – On startup, compare `user_version` with current version; apply migrations (add columns, new tables) using a simple Python script. Never drop columns – only add.
- [ ] Implement session management:
      - Generate session ID with start time: `YYYY-MM-DD_HH-MM` (e.g., `2026-04-16_09-30`)
      - Phase 1 interruption gate: query for open sessions on boot
      - Blocking UI prompt: Resume / Start New
      - Sequence counter resume: `MAX(sequence_id) + 1`

- [ ] Write flat file handler with:
      - Isolated path: `/var/lib/rhemacast/logs/` (Linux) or `C:\ProgramData\RhemaCast\Logs\` (Windows)
      - `PermissionError` fallback: PART2, PART3 suffix rotation
      - Simultaneous write with SQL insert (in Thread 4)


### 2.4 Queue Topology

- [ ] Define all queues with thread-safe `queue.Queue()`:

      ```python
      queue_a = queue.Queue(maxsize=500)          # PCM audio chunks (with ack)
      queue_b = queue.Queue(maxsize=200)          # 15-word text blocks
      db_write_queue = queue.Queue(maxsize=1000)  # All database event payloads
      operator_queue = queue.Queue(maxsize=100)   # NEW: for UI review
      ```

- [ ] Implement Queue A acknowledgment protocol:

      ```python
      pending_chunks = {}              # chunk_id → PCM data
      # Chunks stay in pending until Thread 2 calls ack(chunk_id)
      # On Compute Failure: all pending chunks replayed to Vosk
      ```

- [ ] Define POISON_PILL sentinel:

      ```python
      POISON_PILL = object()
      ```

- [ ] **NEW: Backpressure & overflow policies**
      - Queue A: never drop audio chunks; trigger failover if depth > 400
      - Operator queue: drop oldest low‑confidence items if full
      - DB queue: emergency disk spool fallback if overloaded (write to flat file)
      - WebSocket broadcast queue: coalesce repeated “display same verse” events


### 2.5 WebSocket Server Skeleton

- [ ] Implement `core/websocket_server.py`:
      - Server on `localhost:8765`
      - `connected_clients` set
      - `current_display_state = {"action": "clear"}`
      - On new client connect: instantly push `current_display_state`
      - `broadcast_display(payload)` function
      - OBS connection telemetry: expose `len(connected_clients)` to UI thread

- [ ] **Optional health endpoint** – HTTP GET on port 8766 returning `{"status": "ok", "queue_depths": {...}}` for remote monitoring.
- [ ] **Security** – Bind only to localhost; reject remote connections. Sanitize all HTML payloads; escape scripture text before rendering.

### 2.6 Threading Harness → Replaced by Service Manager

**NEW:** Create `core/service_manager.py` as central authority.

- [ ] Define explicit service states: `BOOTING`, `READY`, `RUNNING`, `DEGRADED`, `FAILOVER`, `SHUTTING_DOWN`, `CRASHED`
- [ ] Boot sequencing: T4 → T5 → T1 → T2 → T3 (strict order)
- [ ] Thread registration and health monitoring (heartbeats)
- [ ] Graceful shutdown: sequential poison pills with timeouts
- [ ] Crash escalation: if a critical thread dies, transition to appropriate state
- [ ] Restart policies: e.g., restart Thread 2 up to 3 times before permanent failover
- [ ] Global events (e.g., `service_active`, `compute_failure`) managed here
- [ ] Teardown: ensure all queues drained before exit

### 2.7 Thread Inventory & Lifecycle

- [ ] Document thread start/stop timing:

      | Thread | Purpose | Started At | Stopped At |
      |--------|---------|-----------|-----------|
      | **Main Thread** | UI rendering, operator controls, lifecycle | Application launch | Application exit |
      | **Thread 1 — Audio Capture** | Captures PCM audio, pushes to Queue A | "Start Transcription" | Poison pill from Queue A |
      | **Thread 2 — STT Inference** | Faster-Whisper on GPU, sliding window | "Start Transcription" | Poison pill from Queue A |
      | **Thread 3 — Search & Scoring** | BM25 + FAISS parallel, RRF fusion | "Start Transcription" | Poison pill from Queue B |
      | **Thread 4 — DB Writer** | SQL inserts + flat file append | Phase 1 init | Poison pill from DB Queue |
      | **Thread 5 — Hardware Monitor** | GPU temp polling via pynvml | Phase 1 init | Service flag set to False |
      | **WebSocket Server** | Push display payloads to HTML renderer | Phase 1 init | Application exit |

### 2.8 Error Propagation Patterns

- [ ] Implement four error response patterns in `core/errors.py` and document in `core/service_manager.py`:
      - **Continue** (transient error): log warning, push error event to DB queue, resume loop
      - **Degrade** (non-critical subsystem failure): e.g., embedding model fails → fall back to intent-only scoring. Notify operator of degraded state
      - **Failover** (critical component failure): e.g., GPU crash → activate Vosk, replay pending chunks. Transition to FAILOVER state
      - **Shutdown** (unrecoverable): e.g., database corruption, terminal audio loss. Cascade poison pills, log critical error, exit

### 2.9 Startup Validation Pipeline

**NEW:** `core/startup_checks.py` – pre‑flight checklist run before enabling “Start Service”.

- [ ] Verify CUDA availability (Faster‑Whisper)
- [ ] Verify FAISS index exists and fingerprint matches Bible DB
- [ ] Verify BM25 index exists and fingerprint matches
- [ ] Verify SQLite writable and `integrity_check` passes
- [ ] Verify microphone accessible (test open stream)
- [ ] Verify WebSocket port free
- [ ] Verify sufficient RAM (at least 2 GB free)
- [ ] Verify Vosk model exists (for failover)
- [ ] Verify `display.html` reachable via file://
- [ ] Verify OBS browser source connectivity (optional ping)
- [ ] Verify write permissions for logs and offline queue directory
- [ ] Verify GPU temperature below 85°C
- [ ] Verify required environment variables present (API keys not needed for startup, but keys for cloud extraction must be present if enabled)
- [ ] Produce PASS / WARNING / FAIL report; block “Start Service” if critical checks fail.


### 2.X Tests & Validation

#### [NEW] `tests/test_phase2_core.py`
- [ ] `test_regression_phase1()` — Verify BM25/FAISS indexes still load after Phase 2 changes.
- [ ] `test_config_schema_validation()` — Feed invalid JSON; verify rejection with clear error message.
- [ ] `test_service_manager_state_machine()` — Verify all valid state transitions (BOOTING→READY→RUNNING→SHUTTING_DOWN→CRASHED).
- [ ] `test_backpressure_queue_a_overflow()` — Fill Queue A past 400 items; verify failover trigger fires.
- [ ] `test_backpressure_operator_queue_drop()` — Fill operator queue past 100; verify oldest low-confidence items dropped.
- [ ] `test_backpressure_db_spool()` — Fill DB queue past 1000; verify emergency flat-file spool fallback engages.
- [ ] `test_events_versioning()` — Verify event dataclass versions (TranscriptChunk, SearchQuery, SearchResult, DisplayCommand, TelemetrySample) are forward/backward compatible.
- [ ] `test_error_taxonomy_attributes()` — Verify all error types (ComputeFailure, AudioDeviceLost, GPUOverheat, DatabaseWriteFailure, IndexMismatch, DisplayDisconnected, CloudExtractionFailure) have correct retryable/fatal/operator_visible/auto_recoverable attributes.
- [ ] `test_service_state_transitions()` — Verify BOOTING→READY→RUNNING→SHUTTING_DOWN and all valid DEGRADED/FAILOVER transitions.
- [ ] `test_startup_checks_critical_fail()` — Force a critical check failure (e.g., missing CUDA), verify "Start Service" is blocked.
- [ ] `test_websocket_reject_remote()` — Attempt WebSocket connection from non-localhost; verify connection rejected.
- [ ] `test_html_sanitization()` — Inject XSS payload into scripture text; verify it's escaped before broadcast.
- [ ] **Integration Tests:** Push 1000 items to `db_write_queue` and ensure all are flushed to SQLite WAL before exit.
- [ ] **Validation:** Introduce bad DB lock; verify fallback to flat-file append-only logging.

---

## Phase 3 — Audio Pipeline

Capture audio from the wireless receiver, push to Queue A with the acknowledgment protocol.

### 3.1 Audio Capture (Thread 1)

- [ ] Implement `core/audio_capture.py`:
      - `sounddevice` InputStream (callback pattern)
      - 16kHz / Mono / float32 / 100ms blocks (`BLOCK_SIZE = 1600`)
      - Callback: `indata.copy() → queue_a.put()`
      - Device enumeration: `sd.query_devices()` → populate UI dropdown

- [ ] **Pre‑flight device check** – Before enabling “Start Transcription”, test the selected input device with `sd.check_input_settings()`. If unavailable, show error and disable start button.
- [ ] Implement FATAL_AUDIO_LOSS handler:
      - Catch `PortAudioError`
      - Push FATAL_AUDIO_LOSS payload to DB Write Queue
      - Push UI lockout alert to Main Thread
      - Halt transcription — no automated fallback

- [ ] **Silence detection for TTL override** – In callback, compute RMS energy over each block. If energy < threshold (e.g., -50 dB) for 3 seconds, set `silence_detected` event. Thread 2 monitors this to flush buffer.
- [ ] Test: capture 5 seconds of audio → verify PCM shape `(N, 1)` float32 range `[-1, 1]`

### 3.2 Queue A Ack Protocol

- [ ] Attach unique IDs to each PCM chunk as it enters Queue A
- [ ] Thread 2 moves chunk to pending on pull, acks on successful Queue B push
- [ ] Compute Failure path: pending chunks → Vosk replay queue
- [ ] **Refined Compute Failure detection** – Add a heartbeat: Thread 2 increments a counter each time it processes a chunk. A watchdog thread checks the counter; if stalled for > 2 seconds while audio is incoming, declare Compute Failure (instead of only queue depth).
- [ ] **When Compute Failure occurs** – Pause audio capture (set flag in Thread 1 to stop pushing new chunks), replay pending unacknowledged chunks to Vosk, then resume capture. This prevents unbounded backlog.

### 3.3 Cross-Platform Audio Notes

- [ ] Document audio backend differences in the operator guide:
      - Windows: WASAPI (default), DirectSound, MME — human-readable device names
      - Linux: ALSA (default), PulseAudio, JACK — backend-prefixed device names (e.g., "hw:1,0")
      - Device index storage: store the device index (or persistent ID) since names differ across platforms
- [ ] Ensure device selection UI handles backend-specific naming transparently

### 3.X Tests & Validation

#### [NEW] `tests/test_phase3_audio.py`
- [ ] `test_regression_phase2()` — Verify service manager state machine still works after audio pipeline changes.
- [ ] `test_queue_ack_protocol()` — Ensure unacknowledged chunks aren't dropped when Thread 2 fails mid-processing.
- [ ] `test_compute_failure_detection_heartbeat()` — Stall Thread 2 processing loop (> 2s); verify watchdog triggers Compute Failure event.
- [ ] `test_compute_failure_pause_resume()` — Trigger Compute Failure; verify Thread 1 pauses capture, then resumes after pending chunks are replayed to Vosk.
- [ ] `test_silence_detection_energy()` — Feed audio blocks below -50 dB RMS; verify `silence_detected` event flag is set after 3 seconds.
- [ ] `test_silence_detection_ttl_override()` — Verify 3s silence triggers partial buffer flush for Dynamic RRF Scaling.
- [ ] **Integration Tests:** Mock sounddevice InputStream with a sine wave generator; verify Queue A depth increases.
- [ ] **Validation:** Unplug mock audio device; verify FATAL_AUDIO_LOSS is propagated to main thread.

---

## Phase 4 — STT Engine

Faster-Whisper on GPU, 15-word sliding window, Vosk failover.

### 4.1 Primary STT: Faster-Whisper (Thread 2)

- [ ] Load model in Phase 1:

      ```python
      from faster_whisper import WhisperModel
      model = WhisperModel("tiny.en", device="cuda", compute_type="int8")
      ```

- [ ] **CUDA Toolkit verification** – At startup, attempt a tiny dummy inference. If CUDA missing, fall back to Vosk as primary (not just failover) and show error dialog: “CUDA Toolkit not found. Running in CPU‑only mode (Vosk).”
- [ ] Implement 15-word sliding window:

      ```python
      word_buffer = []
      trigger_buffer = collections.deque(maxlen=50)   # 50-word rolling lookback

      # On each transcribed segment:
      #   append words to word_buffer and trigger_buffer
      #   if len(word_buffer) >= 15:
      #     push 15 words to Queue B as payload dict
      #     retain last 6 words (trailing overlap)
      #     drop oldest 9 words
      ```

- [ ] TTL Override (slow speech deadlock prevention):
      - 3–5 second silence timer (uses energy detection from Phase 3)
      - On TTL fire: flush partial buffer, mark `word_count < 15` for Dynamic RRF Scaling

- [ ] Wait State (trigger-driven snap):
      - Preceding: extract prior 15 words from `trigger_buffer`
      - Proceeding: set `wait_state` flag, collect future words, then snap

- [ ] Push Queue B payload:

      ```python
      {
        "session_id": session_id,
        "sequence_id": sequence_counter++,
        "timestamp_ms": int(time.time() * 1000),
        "text_chunk": " ".join(words),
        "word_count": len(words)
      }
      ```

- [ ] Simultaneously push raw STT payload to DB Write Queue (Stage 1 logging)

### 4.2 Vosk Failover (Thread 2-Fallback)

- [ ] Download Vosk model: `vosk-model-small-en-us` (~50 MB)
      https://alphacephei.com/vosk/models
      Extract to `data/vosk-model-small-en-us/`

- [ ] Load Vosk model during Phase 1 (warm standby, zero CPU):

      ```python
      from vosk import Model, KaldiRecognizer
      vosk_model = Model("vosk-model-small-en-us")
      # Block thread with OS event flag — consumes 0 CPU cycles
      ```

- [ ] Cap OpenBLAS/MKL threads during Phase 1 (pre-Vosk activation):

      ```python
      os.environ["OMP_NUM_THREADS"] = "2"
      os.environ["OPENBLAS_NUM_THREADS"] = "2"
      ```

- [ ] Failover activation sequence:
      1. Compute Failure declared (heartbeat stall or queue depth)
      2. Thread 2 (GPU) halted
      3. OS event flag flipped — Vosk thread unblocks instantly
      4. Pending unacknowledged chunks replayed from Queue A
      5. Drain loop yields: `time.sleep(0.01)` between chunks
       6. Thread 1 continues pushing new audio (after pause/resume logic) — no audio loss

### 4.3 Backup Embedding Model

- [ ] Document `paraphrase-MiniLM-L3-v2` as the fallback embedding model:
      - Model size: ~60 MB (vs 90 MB for primary all-MiniLM-L6-v2)
      - Output dimensions: 384 (same as primary — no FAISS index rebuild needed)
      - Trade-off: slightly lower paraphrase recognition accuracy, faster CPU inference
      - Activation condition: activated only if primary model causes unacceptable CPU latency during testing
- [ ] Add fallback loading logic in Phase 1: if primary embedding model fails to load or exceeds latency budget, load backup automatically

### 4.X Tests & Validation

#### [NEW] `tests/test_phase4_stt.py`
- [ ] `test_regression_phase3()` — Verify Queue A acknowledgment protocol still intact after STT changes.
- [ ] `test_sliding_window_overlap()` — Verify 6-word trailing overlap is retained on 15-word buffer flush.
- [ ] `test_cuda_toolkit_verification()` — Mock CUDA unavailable; verify Vosk is activated as primary with error dialog.
- [ ] `test_vosk_warm_standby_cpu()` — Verify Vosk thread consumes 0 CPU cycles when blocked by OS event flag.
- [ ] `test_openblas_thread_cap()` — Verify `OMP_NUM_THREADS=2` and `OPENBLAS_NUM_THREADS=2` are respected by Vosk.
- [ ] `test_failover_replay_completeness()` — Inject known audio chunks into Queue A, trigger failover, verify all chunks are replayed to Vosk with zero data loss.
- [ ] **Integration Tests:** Inject 2 minutes of silence; verify TTL override flushes partial buffers.
- [ ] **Validation:** Force GPU OOM exception; verify Vosk fallback initializes in < 50ms and processes pending Queue A chunks.

---

## Phase 5 — Hybrid Search Engine

BM25 + FAISS in parallel, RRF fusion, Min-Max normalization.

### 5.1 Load Indexes in Phase 1

- [ ] Load BM25:

      ```python
      bm25 = pickle.load(open("data/indexes/bm25.pkl", "rb"))
      ```

- [ ] Load FAISS:

      ```python
      index = faiss.read_index("data/indexes/faiss.index")
      ```

- [ ] Load embedding model (ONNX CPU):

      ```python
      from sentence_transformers import SentenceTransformer
      embedder = SentenceTransformer(
          "all-MiniLM-L6-v2",
          backend="onnx",
          model_kwargs={"provider": "CPUExecutionProvider"}
      )
      ```


### 5.2 Search Pipeline (Thread 3)

- [ ] Phase 1.5 — 8-word BM25 early exit:
      Configurable via `require_trigger_for_fast_lane` flag
      Default `False`: runs every 8 words unconditionally

- [ ] Lane A — BM25 lexical search (~5 ms):
      - Normalize: strip apostrophes, replace compound punctuation → spaces, lowercase
      - Strip custom stop-words hash set
      - `bm25.get_scores(query_tokens)`
      - Return Top 5 ranked by score

- [ ] Lane B — FAISS semantic search (~20–30 ms):
      - Embed raw (un-normalized) text → 384-dim vector
      - `faiss.normalize_L2(query_vector)`
      - `index.search(query_vector, 5)`
      - Return Top 5 ranked by cosine distance

- [ ] Phase 3 — RRF Fusion (~5 ms):

      ```
      k = 60
      for each verse in merged candidate set:
        rrf = 1/(k + bm25_rank) + 1/(k + faiss_rank)
        # If absent from a lane: that lane contributes 0

      RRF_max_full = 0.0327  (ranked #1 in both lanes, 15 words)
      RRF_min = 0.0153       (ranked #5 in one lane)

      # Dynamic RRF Scaling based on word_count
      scale_factor = min(1.0, word_count / 15.0)
      RRF_max = RRF_max_full * scale_factor
      # For word_count < 8: use more aggressive scaling
      if word_count < 8:
          scale_factor = 0.4 + (word_count - 1) * 0.1
          RRF_max = RRF_max_full * scale_factor

      confidence = (rrf - RRF_min) / (RRF_max - RRF_min) * 100
      confidence = max(0, min(100, confidence))   # clamp
      ```

- [ ] Push Stage 2 payload to DB Write Queue (search metrics)
- [ ] **NEW: Search observability** – In addition to results, log:
      - BM25 rank, FAISS rank, RRF score, confidence
      - Query tokens, embedding latency, search latency
      - Trigger phrase matched (if any)
      - Normalized inputs



### 5.X Tests & Validation

#### [NEW] `tests/test_phase5_search.py`
- [ ] `test_regression_phase4()` — Verify STT sliding window still functions after search engine changes.
- [ ] `test_rrf_scoring_math()` — Verify RRF with k=60 produces correct bounds: rank #1 in both lanes ≈ 0.0327, rank #5 in one lane ≈ 0.0153.
- [ ] `test_dynamic_rrf_scaling()` — Verify short phrases (< 8 words) get more aggressive scale factor; 15-word buffers get scale_factor=1.0.
- [ ] `test_bm25_normalization_reversible()` — Verify symmetric stripping (apostrophes removed, hyphens→spaces, lowercase) produces identical tokens between offline index building and live search.
- [ ] `test_search_observability_payload()` — Verify all search metrics (BM25 rank, FAISS rank, RRF score, confidence, query tokens, embedding latency, search latency, trigger phrase) are included in Stage 2 payload.
- [ ] `test_lane_b_embedding_fallback()` — Force primary embedding model failure; verify backup `paraphrase-MiniLM-L3-v2` activates automatically.
- [ ] **Integration Tests:** Pipe STT Phase 4 output directly into Phase 5 search; verify latency < 50ms.
- [ ] **Validation:** Compare search results against saved "golden" dataset; alert on regression.

---

## Phase 6 — Intent Classification

Zero-compute heuristic gating via `intent_triggers.json` and compiled regex.

### 6.1 Compile Triggers in Phase 1

- [ ] Load `intent_triggers.json`:

      ```json
      {
        "trigger_intent": ["turn to chapter", "turn to", "verse", ...],
        "ignore_intent": ["turn off", "turn down"]
      }
      ```

- [ ] Compile each phrase into a Token-Window Regex:

      ```python
      "turn to chapter" →
        re.compile(r'\bturn\b(?:\s+\w+){0,2}\s+\bto\b(?:\s+\w+){0,2}\s+\bchapter\b', re.IGNORECASE)
      ```

- [ ] Store compiled patterns in RAM as two lists:

      ```python
      ignore_patterns = [...]
      trigger_patterns = [...]
      ```


### 6.2 Evaluation (< 1 ms)

- [ ] Default state for every block: `intent = False`
- [ ] Step 1 — Negative override (evaluated first):

      ```python
      for pattern in ignore_patterns:
        if pattern.search(text_chunk):
          intent = False; return immediately
      ```

- [ ] Step 2 — Positive evaluation:

      ```python
      for pattern in trigger_patterns:
        if pattern.search(text_chunk):
          intent = True; break
      ```

- [ ] Return Boolean Trigger State to Display Decision


### 6.X Tests & Validation

#### [NEW] `tests/test_phase6_intent.py`
- [ ] `test_regression_phase5()` — Verify RRF fusion still produces correct confidence scores after intent classification changes.
- [ ] `test_triggers_match()` — Feed 20 known trigger phrases into regex engine; assert all 20 return `intent = True`.
- [ ] `test_ignore_overrides_triggers()` — Feed phrases containing both ignore and trigger vocabulary (e.g., "turn off the verse"); verify `intent = False` (ignore evaluated first, negative override takes priority).
- [ ] `test_token_window_regex_compilation()` — Verify `"turn to chapter"` compiles to regex: `\bturn\b(?:\s+\w+){0,2}\s+\bto\b(?:\s+\w+){0,2}\s+\bchapter\b`.
- [ ] `test_6word_overlap_boundary()` — Verify 7-word trigger phrases are caught across chunk boundaries thanks to 6-word trailing overlap.
- [ ] **Integration Tests:** Verify "ignore intent" correctly prevents high-confidence matches from entering top of queue.
- [ ] **Validation:** Verify 6-word overlap window doesn't cause double-triggering across chunk boundaries.

---

## Phase 7 — Display Decision & Broadcast

Routing logic, WebSocket payloads, HTML renderer, OBS integration.

### 7.1 Display Decision Matrix

- [ ] Implement in Thread 3 after intent classification:

      ```
      if confidence >= 85 and intent == True:
        → top_of_queue: push to top of UI review queue (highest priority)
      elif confidence >= 40:
        → operator_queue: push to UI review queue (normal priority, with LRU dedup)
      else:
        → discard
      ```

- [ ] LRU Cache deduplication:

      ```python
      cache = {}   # verse_ref → expiry_timestamp
      TTL = 15 seconds
      # On queue push: if ref in cache and not expired → discard
      #                else: cache[ref] = now + TTL; push to queue
      ```

- [ ] Push Stage 3 payload to DB Write Queue (display event)

### 7.2 Historical Note: NDI Deprecation

The original architecture proposed rendering uncompressed 1920×1080 RGBA frames in Python and pushing them over NDI (`ndi-python`). This was abandoned because:
1. Continuous 1920×1080 RGBA frame encoding in Python caused severe CPU bottlenecking.
2. Any GPU-accelerated UI renderer would compete with the STT model for the 4 GB VRAM budget.
3. OBS/vMix already contains a highly optimized, hardware-accelerated Chromium engine (Browser Source) that performs this rendering for free.

**The WebSocket/HTML pivot** (described above) eliminates all three problems by shifting graphical compute entirely to the broadcast software. All documentation references to NDI have been removed in favor of WebSocket/HTML.

### 7.3 Video Background Decoupling

- [ ] Document the correct OBS scene layering:
      - Bottom layer: standard **Media Source** playing a looping MP4/WebM motion background
      - Top layer: transparent **Browser Source** displaying scripture text via WebSocket/HTML
- [ ] Verify Python has zero awareness of or interaction with the video background — all compositing happens in OBS's hardware-accelerated rendering engine.

### 7.4 Operator Version Interaction

- [ ] Implement in the Manual panel's translation bar:
      - **Single-click** a translation: Switch browse view to that version (navigation scrolls to current book/chapter in that translation). No broadcast action.
      - **Double-click** a translation: Immediately display the currently-selected verse in the double-clicked translation on broadcast output. Fires `{"action": "display", "ref": ..., "text": ..., "translation": ..., "theme": ...}`.

### 7.5 HTML Renderer

- [ ] Create `display/display.html` — base structure
- [ ] Create `display/display.js` — WebSocket client with auto-reconnect (2s)
- [ ] Create `display/themes.css` — default, communion, prophetic themes
- [ ] Test in browser: open `display.html` → verify WebSocket connects
- [ ] Test clear/display payloads manually from Python
- [ ] **Tooltips** – Add hover explanations for every UI control (e.g., “Confidence threshold: verses above this and with trigger intent go to top of queue”).

### 7.6 OBS Integration Test

- [ ] Open OBS Studio
- [ ] Add Browser Source → URL: `file:///path/to/display/display.html`
- [ ] Resolution: 1920×1080, transparent background
- [ ] Start Python WebSocket server → verify OBS shows "Connected" in operator UI
- [ ] Send a test display payload → confirm verse renders in OBS preview
- [ ] Kiosk mode test (Option B):

      ```python
      subprocess.Popen(["chrome", "--kiosk", "--disable-gpu",
                        "--app=file:///path/to/display.html",
                        "--window-position=1920,0"])
      ```

- [ ] Kiosk mode test — Append Chrome flags for VRAM protection:
      `--disable-gpu --disable-software-rasterizer`



### 7.X Tests & Validation

#### [NEW] `tests/test_phase7_display.py`
- [ ] `test_regression_phase6()` — Verify intent regex engine still functional after display routing changes.
- [ ] `test_lru_cache_dedup()` — Push same verse ref twice within 15 seconds; verify second push is discarded.
- [ ] `test_video_backgrounds_decoupled()` — Verify OBS scene structure has decoupled Media Source + Browser Source layers.
- [ ] `test_obs_reconnect_cache()` — Disconnect OBS WebSocket client, reconnect; verify last-known display state is re-pushed.
- [ ] `test_operator_version_single_vs_double_click()` — Mock single click on translation → verify browse behavior. Mock double-click → verify display broadcast fires.
- [ ] `test_kiosk_flags()` — Verify kiosk mode Chrome is launched with `--disable-gpu --disable-software-rasterizer`.
- [ ] **Integration Tests:** Connect mock HTML client via WebSocket; broadcast 5 verses; verify client receives all 5 payloads.
- [ ] **Validation:** Verify `broadcast_display()` does NOT fire automatically on >= 85 confidence (operator routing only).

---

## Phase 8 — GPU Thermal Monitor

pynvml polling, hardware-level power throttling, operator dashboard.

### 8.1 Implement Thread 5

- [ ] Phase 1 init:

      ```python
      import pynvml
      pynvml.nvmlInit()
      handle = pynvml.nvmlDeviceGetHandleByIndex(0)
      ```

- [ ] Admin privilege check at startup:

      ```python
      def check_admin():
        if sys.platform == "win32":
          import ctypes; return ctypes.windll.shell32.IsUserAnAdmin()
        else:
          return os.geteuid() == 0
      if not check_admin(): warn operator, disable throttling
      ```

- [ ] Polling loop (every 2–5 seconds):

      ```python
      temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
      if temp >= 82:   # CRITICAL_THRESHOLD (configurable)
        pynvml.nvmlDeviceSetPowerManagementLimit(handle, 45_000)  # 45W
        is_throttled = True
      elif temp <= 70 and is_throttled:  # SAFE_BASELINE (configurable)
        default_power = pynvml.nvmlDeviceGetPowerManagementDefaultLimit(handle)
        pynvml.nvmlDeviceSetPowerManagementLimit(handle, default_power)
        is_throttled = False
      ```

- [ ] Telemetry pushed to UI: temp, power draw, VRAM usage, utilization %, throttle state
- [ ] Log VRAM usage to DB Write Queue for post-service leak detection

### 8.2 CPU & RAM Monitoring (Extension)

- [ ] Extend Thread 5 to also poll `psutil.virtual_memory()` every 30 seconds.
- [ ] If available RAM drops below 500 MB, push a critical alert to operator and force service shutdown (to prevent crash).
- [ ] Log top 10 memory‑consuming Python objects using `tracemalloc` when threshold crossed.


### 8.X Tests & Validation

#### [NEW] `tests/test_phase8_hardware.py`
- [ ] `test_regression_phase7()` — Verify display routing still works after thermal monitor changes.
- [ ] `test_throttle_temperature_trigger()` — Mock pynvml to return 85°C; verify throttling logic calls `nvmlDeviceSetPowerManagementLimit()` with 45W.
- [ ] `test_throttle_restore()` — Mock initial 85°C then drop to 65°C; verify power limit restored to default.
- [ ] `test_ram_critical_shutdown()` — Mock psutil to return < 500 MB available RAM; verify graceful shutdown sequence is initiated.
- [ ] `test_tracemalloc_logging()` — Trigger critical RAM threshold; verify top 10 memory-consuming Python objects are logged.
- [ ] `test_nvml_missing_graceful()` — Mock pynvml import failure; verify Thread 5 continues without crashing and logs a warning.
- [ ] `test_vram_leak_detection()` — Push periodic VRAM telemetry to UI; verify post-service comparison detects leaks > 10% MB increase.
- [ ] **Integration Tests:** Mock pynvml to return 85°C; verify throttling logic attempts to set lower power limit.
- [ ] **Validation:** Verify Thread 5 gracefully ignores NVML missing (e.g., when run on CPU-only test machine).

---

## Phase 9 — Operator UI

Main thread: Presentation tab, operator review queue, hotkeys, schedule panel, predictive scripture input.

### 9.1 Presentation Tab (Critical Path)

- [ ] Framework choice: PyQt6 (recommended for rich UI + keyboard intercept)

      `pip install PyQt6`

- [ ] Lazy tab loading: only Presentation tab renders at boot
      All other tabs (Settings, Profile, Extensions, Theme Designer) load on first click

- [ ] Presentation tab layout:
      - Left panel:   Schedule panel (drag-and-drop ordered verse list)
      - Center panel: Auto-detected verse feed + operator review queue
      - Right panel:  Manual navigation + translation bar
      - Bottom bar:   Predictive scripture input, start/stop controls
      - Status bar:   OBS connection indicator (green/red), GPU telemetry strip, RAM warning

- [ ] Operator review queue:
      - Show/Reject buttons per item
      - Show → fires `broadcast_display()` + Stage 3 DB log
      - Reject → discards, removes from queue
      - **Color-coded Confidence Indicators:** 
        - Tier 1 (≥ 85%): Distinct accent color (e.g., bright green) to indicate Top of Queue priority.
        - Tier 2 (≥ 60%): Moderate accent color (e.g., yellow)
        - Tier 3 (≥ 40%): Low accent color (e.g., orange)

- [ ] Clear/Recall toggle:
      - First press: broadcast `{"action": "clear"}`
      - Second press (when clear): re-broadcast last cleared verse


### 9.2 Hotkey System

- [ ] Load hotkey bindings at Phase 1:
      - defaults from `config.json`
      - overrides from SQLite `settings` table

- [ ] Intercept key events at application level (suppress default OS behavior)
- [ ] Configurable actions: Display, Clear/Recall, Theme Cycle Forward/Back/Reset
- [ ] Settings UI for operator to remap bindings → saved via DB Write Queue
- [ ] **Default bindings use function keys (F1–F12)** – rarely used by other applications.

### 9.3 Predictive Scripture Input

- [ ] Input box with 3 logical sections: Book | Chapter | Verse
      - Spacebar advances focus between sections
      - Backspace: delete char, or retreat to previous section if empty
      - Enter: navigate Bible browser to reference

- [ ] Predictive book name algorithm:
      - On each keystroke: find first book matching typed prefix
      - Valid next character: silently accept, update highlight
      - Invalid character: silently ignore (no input field change)
      - Untyped suffix: display highlighted (selected) in field

- [ ] Numeric prefix handling:
      - Type "1" → "1 Samuel" (first matching book); continue typing letters immediately


### 9.4 Translation Bar & Drag-and-Drop

- [ ] Translation bar (bottom of Manual panel):
      - Single-click: switch browse view to that version
      - Double-click: broadcast currently-selected verse in that version

- [ ] Schedule panel drag-and-drop:
      - Accept drags from Bible browser + operator review queue
      - Drop appends to end or inserts at position (visual indicator)
      - Reorder within panel
      - Each item stores: ref, translation, text, theme


### 9.5 Theme Designer (Extension)

- [ ] Minimal viable version: standalone PyQt6 window that loads `themes.css` into a `QTextEdit`.
- [ ] Provide live preview using embedded `QWebEngineView` pointed to `display.html` with a local server.
- [ ] Simple property panel (font, colour, shadow) to generate CSS rules.
- [ ] Export saves back to `themes.css`. Keep feature self-contained.

### 9.6 UI Performance Constraints

- [ ] No blocking operations on UI thread (all DB access, network calls, heavy processing offloaded)
- [ ] Max UI refresh rate: 30 FPS (debounce telemetry updates)
- [ ] Operator queue renders at most 50 items at once (virtual scrolling)
- [ ] Use `QThread` for any background work that could take >50 ms


### 9.X Tests & Validation

#### [NEW] `tests/test_phase9_ui.py`
- [ ] `test_regression_phase8()` — Verify thermal monitor still polls and throttles correctly after UI changes.
- [ ] `test_lazy_tab_loading()` — Verify only the Presentation tab renders at boot; Settings, Profile, Extensions, and Theme Designer tabs load on first click only.
- [ ] `test_ui_performance_30fps()` — Verify telemetry updates (GPU temp, queue depths) are debounced to max 30 FPS.
- [ ] `test_virtual_scrolling_50_items()` — Verify operator queue renders at most 50 items at once; items beyond 50 are virtualized.
- [ ] `test_predictive_scripture_input()` — (using pytest-qt) Type "e" → verify "Exodus" appears with 'e' unhighlighted. Type "b" → verify key ignored (not valid for Exodus). Type "1" → verify "1 Samuel" appears immediately.
- [ ] `test_hotkey_default_bindings()` — Verify F1-F12 defaults from config.json are loaded at boot.
- [ ] `test_hotkey_override_persistence()` — Customize a hotkey binding; verify it saves to SQLite settings table and overrides config.json on next boot.
- [ ] **Integration Tests:** Drag-and-drop a mock verse from the Bible browser into the Schedule Panel; verify internal schedule list updates with correct item data (ref, translation, text, theme).
- [ ] **Validation:** Click 'Reject' on an operator queue item; verify it disappears and memory is freed. Verify color-coding applies correctly based on confidence tier (≥85% green, ≥60% yellow, ≥40% orange).

---

## Phase 10 — Cloud Extraction Pipeline

Post-service LLM extraction, retry logic, offline queuing, reconnection polling.

### 10.1 Data Privacy

- [ ] Document data privacy posture:
      - Sermon transcripts are sent to enterprise-grade cloud providers via API (Gemini, Claude, GPT-4o-mini, Groq)
      - Standard, cost-effective commercial APIs are used (church services are publicly broadcast)
      - Enterprise zero-data-retention policies apply (Gemini, Claude, and most commercial APIs do not train on API-submitted data by default)
      - No personally identifiable information (PII) beyond the sermon content is transmitted
      - API keys stored in system keyring or `.env` — never in database

- [ ] Create `.env.example` with placeholder entries:
      `GEMINI_API_KEY=your-key-here`
      `CLAUDE_API_KEY=your-key-here`
      `GROQ_API_KEY=your-key-here`
      `OPENAI_API_KEY=your-key-here`

### 10.2 Transcript Reconstruction

- [ ] Implement `stitch_transcript()`:

      ```sql
      SELECT text_chunk FROM transcripts
      WHERE session_id = ? ORDER BY sequence_id ASC
      ```
      Deduplicate 6-word trailing overlap between consecutive chunks:

      `if len(chunk.split()) > 6: result += " ".join(chunk.split()[6:])`


### 10.3 LLM Extraction with Retry

- [ ] Implement `cloud/extraction.py`:
      - Primary: Gemini 1.5 Flash
      - Secondary: Claude 3 Haiku
      - Tertiary: GPT-4o-mini
      - Fallback: Llama 3.1 via Groq (standard OpenAI client format)

- [ ] Always use native JSON Mode / Structured Outputs parameter
- [ ] Retry loop (`MAX_RETRIES = 3`):
      - On JSON parse failure: append error to prompt for self-correction
      - After 3 failures: failover to next model in chain

- [ ] **Pre‑truncation safety** – If transcript tokens > model context window minus 5000, truncate from the **middle** (preserve first 10% and last 10% of sermon). Log warning.
- [ ] API keys loaded from `.env` file only – never persisted to any table. Optionally use system keyring (Windows Credential Manager / libsecret) via `keyring` library.

### 10.4 Offline Queue & Reconnection

- [ ] `queue_for_later(transcript, reason)`:
      - Append JSON line to `OFFLINE_QUEUE_PATH` (disk persistence)
      - `reason`: `"network_down"` | `"api_exhausted"`

- [ ] Operator Consent Gate at boot:
      - If `OFFLINE_QUEUE_PATH` has data:
        Raise non-blocking UI alert: "X past services pending. Process now or after service?"

- [ ] Reconnection polling — exponential backoff with jitter:

      `BASE = 5s, MAX = 300s, MULTIPLIER = 2, JITTER = ±20%`
      - `network_down`: ping 1.1.1.1
      - `api_exhausted`: ping provider status endpoint

- [ ] Segregated verification: wrong ping target = silent ban loop


### 10.5 Forensic Audit Trail

- [ ] Implement forensic query support for threshold tuning:

      ```sql
      -- Find all false positives: top-queued verses with low actual relevance
      SELECT source_text, top_verse_ref, confidence_pct, intent_score
      FROM search_results
      WHERE session_id = ?
        AND action_taken = 'top_queued'
      ORDER BY confidence_pct ASC;
      ```
- [ ] Add the above query to the operator's post-service analysis tools.

### 10.X Tests & Validation

#### [NEW] `tests/test_phase10_cloud.py`
- [ ] `test_regression_phase9()` — Verify operator UI review queue still functions after cloud pipeline changes.
- [ ] `test_stitch_transcript()` — Feed overlapping chunks; verify 6-word trailing overlap is stripped during concatenation.
- [ ] `test_pre_truncation_middle_cut()` — Feed transcript exceeding model context window minus 5000 tokens; verify middle 80% is removed while first 10% and last 10% are preserved.
- [ ] `test_api_key_keyring()` — (Integration) Verify system keyring integration reads/writes API keys correctly and falls back to `.env`.
- [ ] `test_data_privacy_no_pii()` — Verify no PII fields (beyond sermon content) are transmitted in cloud payload.
- [ ] `test_forensic_audit_top_queued_false_positives()` — Execute forensic SQL query; verify it returns expected false positives.
- [ ] **Integration Tests:** Mock API failure; verify transcript is successfully written to `OFFLINE_QUEUE_PATH`.
- [ ] **Validation:** Simulate network recovery; verify exponential backoff jitter gracefully resumes queue processing.

---

## Phase 11 — Cross-Platform Packaging

### 11.1 Windows .exe (Built Inside the Windows VM)

- [ ] Enter Windows VM (GPU passthrough active)
- [ ] Install PyInstaller in the Windows virtualenv

      `pip install pyinstaller`

- [ ] Create `rhemacast.spec`:
      - `hidden_imports`: `['pynvml', 'sounddevice', '_sounddevice_data']`
      - `datas`: `[('data/indexes/', 'data/indexes/'), ('data/intent_triggers.json', 'data/'), ('display/', 'display/')]`
      - `collect_data_files('faster_whisper')`
      - `collect_data_files('vosk')`
      - DO NOT bundle CUDA DLLs — target system must have CUDA Toolkit

- [ ] Build:

      `pyinstaller rhemacast.spec --onefile --windowed`

- [ ] **Inno Setup script** (`rhemacast.iss`) – creates installer that:
      - Checks for CUDA Toolkit and prompts to download if missing.
      - Installs `.exe`, `data/`, `display/` folders in `%ProgramFiles%\RhemaCast`.
      - Creates Start Menu shortcuts and optionally desktop icon.
      - Writes registry entries for uninstallation.

- [ ] **Automatic update check** – On startup, ping a public version manifest URL (e.g., GitHub release). If newer version available, show notification with “Download” button.
- [ ] Installer note:
      Document that users must install NVIDIA CUDA Toolkit separately.
      Test on a clean Windows VM (no pre-installed CUDA) to confirm the exe fails with a clear error message rather than a silent crash.


### 11.2 Linux .deb

- [ ] Create `debian/` directory structure:

      `debian/control`:
      ```
      Package: rhemacast
      Depends: python3.11, python3-pip, libportaudio2,
               nvidia-cuda-toolkit, libgomp1
      ```

- [ ] Write `debian/postinst`:

      `pip3 install -r /opt/rhemacast/requirements.txt`

- [ ] Build:

      `dpkg-buildpackage -us -uc`
      # Or simpler: `fpm -s python -t deb .`

- [ ] Test install on a clean Ubuntu VM:

      `sudo dpkg -i rhemacast_*.deb`
      `rhemacast --check-deps`



### 11.X Tests & Validation

#### [NEW] `tests/test_phase11_packaging.py`
- [ ] `test_regression_phase10()` — Verify offline queue mechanism still works after packaging changes.
- [ ] `test_cuda_dlls_not_bundled()` — Inspect the packaged .exe; verify it does NOT contain `cublas*.dll` or `cudnn*.dll`.
- [ ] `test_auto_update_check()` — Mock version manifest response with newer version; verify notification dialog appears with "Download" button.
- [ ] `test_installer_cuda_check()` — Run installer on a system without CUDA Toolkit; verify installer displays clear error message (not silent crash).
- [ ] **Integration Tests:** Run `rhemacast --check-deps` on the packaged binary to assert embedded paths work.
- [ ] **Validation:** Install .deb on a clean Ubuntu VM and assert execution paths function. Confirm Windows .exe fails gracefully if CUDA Toolkit is missing.

---

## Phase 12 — Integration Testing & Hardening

End-to-end stress tests simulating real 2-hour services.

### 12.1 Pre-Service Checklist Tests

- [ ] OBS connection indicator: disconnect/reconnect OBS → verify green/red toggle
- [ ] Wireless receiver unplug → FATAL_AUDIO_LOSS lockout triggers correctly
- [ ] CUDA unavailable (VM without GPU passthrough) → Vosk fallback activates with clear error dialog
- [ ] Admin check: run without elevated privileges → throttling disabled with clear warning
- [ ] Offline queue consent gate: create fake offline queue → verify boot prompt

### 12.2 Unit Tests & Regression

- [ ] Write unit tests with `pytest` for each module (search_engine, intent_classification, db_writer, etc.). Mock out heavy dependencies (FAISS, GPU).
- [ ] **Automated regression test of BM25/FAISS** – After rebuilding indexes, run a script that compares search results for 100 known phrases against a saved “golden” answer set. Alert on any significant rank change.

### 12.3 Rehearsal Mode → Extended to Deterministic Replay

- [ ] Add a UI toggle that reads a pre‑recorded 16kHz WAV file and pushes it into Queue A as if from the microphone.
- [ ] Operator can run a full service mock, verify display decisions, and export a test report.
- [ ] Use rehearsal mode to calibrate confidence thresholds without live congregation.
- [ ] **NEW: Record raw Queue A audio stream to `.pcm` with timestamps** during live services.
- [ ] **NEW: Replay Session System** – Feed the recorded `.pcm` back into the pipeline offline, capture all thread outputs, compare against a golden baseline. Detect regressions automatically.

### 12.4 Stress Tests

- [ ] 2-hour simulated service (audio loop):
      - VRAM usage must stay under 3 GB throughout (log with Thread 5)
      - Queue A depth must stay under 50 items under normal load
      - DB Writer thread must have zero skipped payloads
      - Flat file must match SQL transcript exactly (diff them post-test)

- [ ] Thermal throttle simulation:
      - Manually set power limit to 45W mid-test
      - Confirm transcription slows but continues
      - Confirm no audio loss (Queue A ack protocol intact)
      - Restore power → confirm full speed returns

- [ ] Compute Failure drill:
      - Intentionally kill Thread 2 mid-service
      - Verify Vosk activates in < 10ms (event flag flip)
      - Verify all pending Queue A chunks are replayed (zero audio loss)
      - Verify service continues uninterrupted

- [ ] Shutdown stress test:
      - Flood DB Write Queue with 5000 payloads, then click End Service
      - Verify all payloads committed before Thread 4 exits
      - Verify WAL checkpoint completes cleanly


### 12.5 Search Quality Calibration

- [ ] Collect 50 real sermon audio clips (with known scripture references)
- [ ] Run each through the full pipeline
- [ ] Measure: correct verse in Top 1 result (target: > 80%)
- [ ] Measure: correct verse in Top 5 result (target: > 95%)
- [ ] Adjust RRF_min, top-of-queue threshold (85%), and discard threshold (40%)
      based on empirical false-positive/false-negative rates

- [ ] Re-test intent classification: tune trigger phrases in `intent_triggers.json`

### 12.6 Data Integrity Tests

- [ ] Run `PRAGMA integrity_check` on SQLite at startup and after each service
- [ ] Auto-backup database daily (keep 7 days)
- [ ] Schedule WAL checkpoint every 1000 transactions or on shutdown
- [ ] Verify FAISS vector count matches number of verses
- [ ] Verify BM25 document count matches
- [ ] SHA256 hash transcript exports and verify chunk continuity


### 12.X Tests & Validation

#### [NEW] `tests/test_phase12_integration.py`
- [ ] `test_regression_all_phases()` — Comprehensive suite: run all previous phase regression tests to ensure no regressions.
- [ ] `test_2hour_stress_vram()` — 2-hour simulated service; assert VRAM usage stays strictly under 3 GB (logged by Thread 5 every 30s).
- [ ] `test_2hour_stress_queue_a_depth()` — 2-hour simulated service; assert Queue A depth stays under 50 items under normal load.
- [ ] `test_2hour_stress_db_completeness()` — 2-hour simulated service; diff SQL transcript against flat file — must match exactly.
- [ ] `test_thermal_throttle_simulation()` — Manually set power limit to 45W mid-test; confirm transcription slows but continues with zero audio loss. Restore power; confirm full speed returns.
- [ ] `test_compute_failure_drill()` — Kill Thread 2 mid-service; verify Vosk activates in < 10ms (event flag flip). Verify all pending Queue A chunks are replayed. Verify service continues uninterrupted.
- [ ] `test_shutdown_stress_5000_payloads()` — Flood DB Write Queue with 5000 payloads, then click End Service. Verify all 5000 payloads committed before Thread 4 exits. Verify WAL checkpoint completes cleanly.
- [ ] `test_prg_integrity_check()` — Run `PRAGMA integrity_check` on SQLite; assert result is "ok".
- [ ] `test_auto_backup_rotation()` — Verify daily auto-backups are kept for 7 days; older backups are rotated out.
- [ ] `test_shasum_transcript_continuity()` — Verify SHA256 hash of transcript export matches expected hash and chunk continuity is intact.
- [ ] **Validation:** Compute Failure Drill — kill Thread 2 mid-service, verify Vosk activates, no audio is dropped.
- [ ] **Validation:** OBS connection indicator: disconnect/reconnect OBS → verify green/red toggle.

---

## Phase 13 — Documentation for Users

- [ ] **Operator quick start** – One page covering: connecting wireless receiver, starting transcription, using review queue, hotkeys, clear/recall, handling GPU throttle warning.
- [ ] **Admin guide** – Installing CUDA Toolkit, editing `intent_triggers.json`, adding custom CSS themes, configuring offline queue consent gate, troubleshooting FATAL_AUDIO_LOSS.
- [ ] **Tooltips** – Hover explanations for every UI control (as noted in Phase 7.2).
- [ ] **NEW: Operator Recovery Procedures** – A dedicated section with drills:
      - GPU failure during sermon → automatic Vosk failover, operator action: none
      - Audio receiver unplugged → FATAL_AUDIO_LOSS lockout, operator action: restart app
      - OBS disconnected → check browser source, restart OBS
      - Windows update popup → postpone updates, or set active hours
      - Full disk → clear old logs, move offline queue to another drive
      - Internet outage → cloud extraction queues offline, no disruption to live service
      - Corrupt index → rebuild from Bible source using offline script
      - App freeze → force‑quit and restart; session resumes automatically
  Symptoms, automatic response, operator action, recovery confirmation.


### 13.X Tests & Validation

#### [NEW] `tests/test_phase13_docs.py`
- [ ] `test_docs_all_ndi_removed()` — Grep all documentation files for "NDI" references; assert zero occurrences (WebSocket/HTML is the standard).
- [ ] `test_checklist_accuracy()` — Verify CHECKLIST.md accurately reflects current architectural state (e.g., no auto-display, no DistilBERT, no NDI).
- [ ] **Validation:** Ensure CHECKLIST.md accurately reflects architectural state.

---

## Phase 14 — Production Survivability & Architectural Hardening

This phase adds operational resilience, architectural boundaries, and non‑functional guarantees.

### 14.1 Operational Modes

- [ ] Implement modes in `core/service_manager.py`:
      - `NORMAL` – full GPU, FAISS, cloud extraction, throttling
      - `SAFE_MODE` – disable FAISS, disable cloud, disable throttling, use BM25+Vosk only
      - `CPU_ONLY` – Faster‑Whisper on CPU, Vosk as fallback, no GPU monitoring
      - `REHEARSAL` – read from WAV file, disable live broadcast
      - `HEADLESS` – no UI, for remote monitoring or automated testing
      - `DEBUG` – verbose logging, extra checks
      - `BENCHMARK` – measure latencies, no real broadcast

- [ ] Allow mode override via command line flag or config file.

### 14.2 Explicit Memory Budgets & Cold Boot Targets

**VRAM Budget (GTX 1650, 4 GB)**
- [ ] Faster-Whisper: max 3 GB
- [ ] CUDA overhead: 500 MB
- [ ] Safety margin: 500 MB
- [ ] Reject model upgrades that exceed budget.

**RAM Budget (16 GB system)**
- [ ] FAISS: 300 MB
- [ ] BM25: 100 MB
- [ ] SQLite cache: 256 MB
- [ ] Embedding model (ONNX): 200 MB
- [ ] UI (PyQt): 150 MB
- [ ] Audio buffers & queues: 100 MB
- [ ] Operating system & other processes: ~4 GB
- [ ] Total headroom: > 2 GB free at all times.

**Cold Boot Time Targets**
- [ ] Cold boot (from launch to "Ready"): < 30 seconds
- [ ] Warm restart (service stop → start again): < 10 seconds
- [ ] Vosk failover latency: < 50 ms
- [ ] OBS reconnect: < 2 seconds
- [ ] Queue drain on shutdown: < 5 seconds

Benchmark each target in CI and alert on regression.

### 14.3 Performance Benchmarks per Phase

Add measurable engineering targets:

- [ ] Audio callback execution: < 5 ms
- [ ] STT 15‑word window processing: < 300 ms (GPU)
- [ ] BM25 query: < 10 ms
- [ ] FAISS query: < 40 ms
- [ ] Intent classification: < 1 ms
- [ ] RRF fusion: < 5 ms
- [ ] Display broadcast latency (from decision to WebSocket send): < 100 ms
- [ ] UI telemetry refresh: debounced to 2 Hz max

Monitor these in rehearsal mode and log violations.

### 14.4 Non‑Functional Requirements (Architectural Guardrails)

- [ ] **Reliability** – Zero audio loss during failover (validated by replay tests)
- [ ] **Availability** – Survive 2‑hour service continuously without crash or intervention
- [ ] **Recoverability** – Resume session after crash with no manual data repair
- [ ] **Determinism** – Replaying the same PCM stream produces identical search outputs (version‑locked models)
- [ ] **Portability** – Same `config.json` works on Windows and Linux (paths resolved dynamically)
- [ ] **Maintainability** – No circular imports; each module < 1000 LOC; all public methods typed

### 14.5 Technical Debt Prevention Rules

- [ ] No global mutable state outside `service_manager`
- [ ] No thread directly talks to another thread (use queues / events only)
- [ ] No silent exceptions – every exception caught is logged and, if fatal, escalates
- [ ] Every thread has a heartbeat monitored by service manager
- [ ] Every background loop includes a sleep or yield
- [ ] Every config option is documented in `config_schema.py`
- [ ] Every public method has type hints
- [ ] Every queue payload is versioned (in `events.py`)

### 14.6 Model Management

- [ ] Central model registry (`core/models.py`)
- [ ] Store checksums (SHA256) for Faster‑Whisper, Vosk, embedding model
- [ ] On startup, verify checksums; if mismatch, warn and optionally auto‑redownload
- [ ] Version pinning: lock model versions in `config.json`
- [ ] Automatic download from trusted URLs (with user consent)
- [ ] Cache cleanup policy: remove unused models after N days
- [ ] Compatibility validation: ensure embedding model dimension matches FAISS index

### 14.7 Architectural Split: Three Isolated Subsystems

**A. Real‑Time Engine** (hard realtime‑ish)
- Audio capture, STT, search, broadcast
- Runs in dedicated threads with highest priority
- No blocking calls to subsystems B or C
- Communicates via message passing only

**B. Operator Application** (human‑facing)
- PyQt UI, review queue, scheduling, themes
- Runs on main thread, can be slower
- Observes real‑time engine via queues, never blocks it

**C. Post‑Service Processing** (non‑realtime)
- Cloud extraction, analytics, exports, reports
- Runs after service ends or as low‑priority background tasks
- Can be paused or throttled without affecting live service

- [ ] Implement clear message‑passing interfaces between subsystems
- [ ] Verify real‑time engine never waits for B or C
- [ ] Document subsystem boundaries in developer guide

#### [NEW] `tests/test_phase14_modes.py`
- [ ] `test_operational_mode_safe()` — Run service in `SAFE_MODE`; verify FAISS and Cloud Extraction are disabled.
- [ ] `test_operational_mode_cpu_only()` — Verify GPU monitoring disabled in `CPU_ONLY`.
- [ ] `test_operational_mode_rehearsal()` — Verify WAV file input works, broadcast disabled.
- [ ] `test_cold_boot_under_30s()` — Time from launch to READY, assert < 30s.
- [ ] `test_model_checksum_verification()` — Corrupt a model file, verify checksum mismatch warning.
- [ ] `test_three_subsystem_isolation()` — Verify Real-Time Engine never blocks on B or C.
- [ ] `test_vram_budget_enforcement()` — Attempt to load over-budget model, verify rejection.

---

## Phase 15 — Sermon Archive & Semantic Search

Build the post-service repository and the natural language search interface.

### 15.1 Insight Database & Vectorization

- [ ] Create `sermon_insights` table in SQLite
      Columns: `id, session_id, type (Prophecy/Declaration/etc), content, metadata_json`
- [ ] Implement incremental vectorization for insights
      - On extraction completion: encode each insight → FAISS vector
      - Store in dedicated `archive.index`
- [ ] Implement hybrid search for History tab:
      - BM25 on `content`
      - FAISS on `archive.index`

### 15.2 History UI — The Insight Browser

- [ ] Pivot History tab from raw logs to "Insight Cards"
- [ ] Implement "Natural Language Search" bar (BM25 + FAISS)
- [ ] Add category filters: Prophecies, Declarations, Scriptures, Prayer Points
- [ ] Implement "Context Reveal": Click insight to see surrounding transcript


### 15.X Tests & Validation

#### [NEW] `tests/test_phase15_archive.py`
- [ ] `test_regression_phase14()` — Verify operational modes still work after archive changes.
- [ ] `test_insight_categorization()` — Ensure Prophecies/Declarations route to correct UI tabs.
- [ ] `test_insight_vectorization_incremental()` — Add new insight, verify auto-vectorized to `archive.index`.
- [ ] `test_hybrid_search_history()` — Search in History tab, verify BM25 + FAISS fusion on insights.
- [ ] `test_context_reveal()` — Click Context Reveal on insight, verify surrounding transcript fetched from SQLite.

---

## Dependency & Phase Map (Updated)

```
Phase 0 (VM + Environment)
    └── Phase 1 (Bible Indexes)
            └── Phase 2 (Core Infrastructure + Config + Events + Startup)
            ├── Phase 3 (Audio Pipeline)
            ├── Phase 4 (STT Engine)
            │       └── Phase 5 (Search Engine)
            │               └── Phase 6 (Intent)
            │                       └── Phase 7 (Display)
            │                               ├── Phase 8 (GPU Monitor) [parallel]
            │                               └── Phase 9 (Operator UI)
            │                                       └── Phase 10 (Cloud Pipeline)
            │                                               └── Phase 11 (Packaging)
            │                                                       └── Phase 12 (Testing)
            │                                                               └── Phase 13 (Documentation)
            │                                                                       └── Phase 14 (Hardening)
            │                                                                               └── Phase 15 (Archive Search)
```

---

## Key Constraints Reference (Updated)

| Constraint | Rule |
|---|---|
| VRAM | 4 GB hard cap; only Faster-Whisper touches GPU |
| All other models | CPU via ONNX Runtime / standard RAM |
| Bible versions | Exactly 6: KJV, NKJV, ESV, NIV, NLT, AMP |
| Audio source | Wireless hardware only; no software noise bridges |
| BM25 normalization | Symmetric: same map used offline (index build) and live |
| CUDA DLLs | Never bundled in .exe; CUDA Toolkit assumed on target system |
| Cloud payloads | Monolithic only; chunking prohibited |
| Offline queue path | System data dir only; never Desktop/Documents/Downloads |
| Admin privileges | Required for `nvmlDeviceSetPowerManagementLimit`; check at boot |
| DB writes | Single-writer pattern only; no thread writes directly to SQLite |
| **WebSocket** | Binds only to localhost; remote connections rejected |
| **UI responsiveness** | No blocking ops on UI thread; max 30 FPS |
| **Memory budgets** | Enforced via startup checks; reject upgrades exceeding budget |
| **Cold boot** | < 30 seconds to READY state |
| **Zero audio loss** | Guaranteed during failover (replay validated) |

