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

- [ ] Blacklist nvidia driver for vfio

      `/etc/modprobe.d/vfio.conf`:
      `options vfio-pci ids=10de:1f82,10de:10fa`

- [ ] Create libvirt hook: `/etc/libvirt/hooks/qemu`
      # On VM start: unbind nvidia → bind vfio-pci
      # On VM stop:  unbind vfio-pci → bind nvidia

      `chmod +x /etc/libvirt/hooks/qemu`

- [ ] Attach GPU to VM in virt-manager:
      Add Hardware → PCI Host Device → select GPU + Audio device

- [ ] Test: Boot Windows VM → confirm Device Manager shows GTX 1650
      Install NVIDIA driver inside VM
      Run `nvidia-smi.exe` to verify CUDA access

**Validation checkpoint:** From inside the Windows VM, run a quick Faster-Whisper test transcription on a sample WAV file. If it completes on GPU (cuda device), the passthrough is correct.

### 0.3 Python Environment — Both Platforms

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
      `pip install sentence-transformers onnxruntime`
      `pip install rank_bm25`
      `pip install websockets aiohttp`
      `pip install pynvml`
      `pip install sqlite3`   # stdlib, no install needed
      `pip install pyinstaller`  # Windows VM only, for packaging

- [ ] Verify GPU access in Python (Windows VM)

      `python -c "import torch; print(torch.cuda.is_available())"`
      # Or via CTranslate2:

      `python -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"`


### 0.4 Repository Structure

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

### 0.5 CUDA Toolkit — Windows VM

- [ ] Download NVIDIA CUDA Toolkit (match your driver version)
      https://developer.nvidia.com/cuda-downloads
      Recommended: CUDA 12.x

- [ ] Install cuDNN (required by CTranslate2)
      https://developer.nvidia.com/cudnn
      Copy DLLs to CUDA bin directory

- [ ] Verify: `nvcc --version` (should report CUDA version)

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
      AUTO_DISPLAY_THRESHOLD = 85      # confidence %
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

---

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

### 2.7 Startup Validation Pipeline

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
- [ ] Cold boot (from launch to “Ready”): < 30 seconds
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
      embedder = SentenceTransformer("all-MiniLM-L6-v2")
      # Ensure it uses ONNX Runtime CPU execution provider (no GPU)
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

---

## Phase 7 — Display Decision & Broadcast

Routing logic, WebSocket payloads, HTML renderer, OBS integration.

### 7.1 Display Decision Matrix

- [ ] Implement in Thread 3 after intent classification:

      ```
      if confidence >= 85 and intent == True:
        → auto_display: broadcast_display(payload)
      elif confidence >= 40:
        → operator_queue: push to UI review queue (with LRU dedup)
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

### 7.2 HTML Renderer

- [ ] Create `display/display.html` — base structure
- [ ] Create `display/display.js` — WebSocket client with auto-reconnect (2s)
- [ ] Create `display/themes.css` — default, communion, prophetic themes
- [ ] Test in browser: open `display.html` → verify WebSocket connects
- [ ] Test clear/display payloads manually from Python
- [ ] **Tooltips** – Add hover explanations for every UI control (e.g., “Confidence threshold: verses above this and with trigger intent go to top of queue”).

### 7.3 OBS Integration Test

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

---

## Phase 10 — Cloud Extraction Pipeline

Post-service LLM extraction, retry logic, offline queuing, reconnection polling.

### 10.1 Transcript Reconstruction

- [ ] Implement `stitch_transcript()`:

      ```sql
      SELECT text_chunk FROM transcripts
      WHERE session_id = ? ORDER BY sequence_id ASC
      ```
      Deduplicate 6-word trailing overlap between consecutive chunks:

      `if len(chunk.split()) > 6: result += " ".join(chunk.split()[6:])`


### 10.2 LLM Extraction with Retry

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

### 10.3 Offline Queue & Reconnection

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
- [ ] Adjust RRF_min, auto-display threshold (85%), and discard threshold (40%)
      based on empirical false-positive/false-negative rates

- [ ] Re-test intent classification: tune trigger phrases in `intent_triggers.json`

### 12.6 Data Integrity Tests

- [ ] Run `PRAGMA integrity_check` on SQLite at startup and after each service
- [ ] Auto-backup database daily (keep 7 days)
- [ ] Schedule WAL checkpoint every 1000 transactions or on shutdown
- [ ] Verify FAISS vector count matches number of verses
- [ ] Verify BM25 document count matches
- [ ] SHA256 hash transcript exports and verify chunk continuity

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

---

## Dependency & Phase Map (Updated)

```
Phase 0 (VM + Environment)
    ├── Phase 1 (Bible Indexes) ─────────────────────────────────────┐
    └── Phase 2 (Core Infrastructure + Config + Events + Startup)    │
            ├── Phase 14 (Production Survivability) ←──────────────────────┘
            │       (Architectural hardening, modes, budgets, benchmarks)
            ├── Phase 3 (Audio Pipeline)
            ├── Phase 4 (STT Engine)
            │       └── Phase 5 (Search Engine) ←─────────────────────┘
            │               └── Phase 6 (Intent)
            │                       └── Phase 7 (Display)
            │                               ├── Phase 8 (GPU Monitor) [parallel]
            │                               └── Phase 9 (Operator UI)
            │                                       └── Phase 10 (Cloud Pipeline)
            │                                               └── Phase 11 (Packaging)
            │                                                       └── Phase 12 (Testing)
            │                                                               └── Phase 13 (Documentation)
```
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
