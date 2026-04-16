# Architectural Q&A: Resolved Items

## 1. VRAM Allocation & Contention
**Question:** How do the models share the restricted 2GB VRAM without OOM exceptions?

~~**Resolution:** The documentation needs to be updated. The system actually has 4GB of available VRAM, which provides sufficient headroom for the selected models to run concurrently.~~

## 2. Failover Detection Mechanics
**Question:** How is a crash or overload detected to trigger the fail-safe?

**Resolution:** The system will monitor resources via active polling. If temperatures get too high, GPU usage will be throttled. A slight delay in output is considered acceptable during these thermal events, provided the hardware doesn't crash.

## 3. Offline API Queuing
**Question:** What happens if the internet drops when the service ends?

**Resolution:** The system will utilize a local queue to store the transcript payload and process it once the connection is restored.

## 4. The Confidence Score Math
**Question:** How is the Reciprocal Rank Fusion (RRF) converted to a 0-100% score?

**Resolution:** The scoring math will be empirically determined through testing. By observing the range of values for perfect matches versus poor matches, a mapping formula will be created to assign the final percentage, with appropriate headroom.

## 5. NDI Payload Formatting
**Question:** What is the exact string format pushed to the NDI feed?

**Resolution:** The payload is dynamically generated. It includes the raw text and appends the Book, Chapter, and Verse reference, the translation (either the default or the closest match), and incorporates the chosen display theme.

## 6. The "No-Pause" Audio Chunking Edge Case & Thread Synchronization
**Question:** How do we prevent rapid speech with no pauses from causing memory spikes or cutting words in half, and how do we stop threads from falling out of sync if a chunk takes too long to process?

**Resolution:** We are transitioning from a sequence-to-sequence chunking model to a Continuous Stream (CS) STT model to handle rapid speech seamlessly.
* **Off-Site Fine-Tuning:** The streaming model will be heavily trained on the pastor's specific voice off-site (via Kaggle) to ensure high accuracy while completely bypassing our local 4GB VRAM constraint.
* **Sliding Window Search Engine:** To provide the `all-MiniLM-L6-v2` semantic model with enough context without causing CPU overhead, the stream utilizes a strictly fixed word-count buffer. The search pipelines (FAISS and BM25) trigger exactly every 15 words. After triggering, the buffer retains the last 6 words as a trailing overlap to ensure context is preserved across the bridge of the next phrase. Acoustic pause triggers are explicitly omitted to conserve GPU compute and reduce system complexity.
* **Asynchronous Queuing:** To guarantee thread synchronization, operations are strictly decoupled using thread-safe queues (Audio Capture → Queue A → STT Inference → Queue B → Search & Display). This ensures that continuous audio ingestion never halts, even if a semantic search iteration spikes from 40ms to 90ms.

## 7. Database Concurrency Locks
**Question:** How do we prevent the SQLite database from locking and crashing the app when multiple threads (the Continuous Stream STT and the UI operator) attempt to write at the exact same millisecond? 

**Resolution:** We will utilize a single SQLite database file configured with WAL (Write-Ahead Logging) mode, paired with a dedicated asynchronous write queue.
* **The WAL Advantage:** Enabling WAL mode allows simultaneous reading and writing. This ensures that the UI can freely query past verses from the database without ever blocking incoming transcript writes.
* **The Single Writer Queue:** To solve the multiple-writer collision risk introduced by the highly frequent Continuous Stream, we will completely prohibit individual threads from writing to the database directly. Instead, all threads (Search, UI, STT) push their payload to a thread-safe `Database_Write_Queue`.
* **The Dedicated DB Thread:** A single, dedicated background thread pulls items from this queue one by one and executes the SQL inserts sequentially. This guarantees that SQLite only ever has one writer at a time, completely eliminating `database is locked` errors without the complex, fragile architecture of managing and consolidating multiple `.db` files.

## 8. Database Queue Ordering and Timestamp Logic
**Question:** How does the Dedicated DB Thread know the sequential order of concurrent events, and does it use timestamps to prioritize writes?

**Resolution:** The Dedicated DB thread relies entirely on the First-In-First-Out (FIFO) mechanics of the thread-safe queue, not on timestamps, to determine the write order.
* **FIFO Execution:** The DB thread strictly processes payloads in the exact order they enter the queue. It does not perform any sorting or prioritization.
* **Microscopic Tie-Breaking:** If multiple threads (e.g., STT and UI) attempt to push data to the queue at the exact same millisecond, the operating system's internal thread scheduler acts as the tie-breaker, guaranteeing sequential insertion into the queue.
* **Role of Timestamps:** Millisecond-precise timestamps are included in every database payload, but they are utilized strictly for post-service data reconstruction (e.g., stitching the continuous stream chunks back into a chronologically perfect transcript using SQL `ORDER BY`) and archival tracking, rather than managing database write priority.

## 9. Exact Keyword Stripping Logic
**Question:** Should the BM25 search engine use standard English stop-words or a custom Biblical list (e.g., stripping "thou", "hath", "unto")?

**Resolution:** We will use a standard, lightweight English stop-word list (removing words like "the," "is," and "a"), explicitly choosing **not** to strip archaic or Biblical vocabulary. 
* **The "Fingerprint" Strategy:** Because the semantic search lane (FAISS) already handles the underlying meaning and paraphrase matching, the BM25 engine's sole purpose is exact-text detection. Retaining words like "thou," "hath," and "unto" turns them into high-value lexical fingerprints.
* **Instant Translation Matching:** Leaving these words in the text allows BM25 to instantly and mathematically distinguish between a traditional quote (like the KJV) and a modern paraphrase (like the NIV) without requiring any additional translation-checking logic or CPU overhead.
* **Processing Speed:** Avoiding a custom, exhaustive Biblical stop-word list keeps the text stripping process mathematically simple, saving crucial fractions of a millisecond during the Phase 2 split.

## 10. Regex Fallback Specifications
**Question:** What format are the fallback Intent Regex patterns stored in, and how are they loaded if the primary DistilBERT intent classifier fails or is throttled?

**Resolution:** The fallback rules will be stored in an external, lightweight `intent_triggers.json` configuration file rather than being hardcoded into the application logic.
* **Format & Storage:** The JSON file will contain arrays of common pastoral trigger phrases (e.g., "turn to," "book of," "chapter," "verse"). Configurable at startup/decicated setting.
* **Memory Loading:** During Phase 1 (Initialization), this JSON file is read and stored permanently in standard RAM, ensuring instant access with zero disk read overhead during a live service.
* **Execution Logic:** If the system degrades and DistilBERT is bypassed, the system falls back to basic string-matching. It scans the incoming text buffer against the JSON arrays. If a trigger phrase is detected alongside a high BM25/FAISS confidence score, the Intent Score is automatically flagged as "High" and the auto-display is triggered. This provides a brittle but highly reliable, zero-compute safety net.

# Architecture Clarifications and Technical Specifications

This document resolves the previously identified architectural edge cases, missing data flows, and hardware constraints, providing explicit definitions for system development.

---

## 11. GPU Throttling Mechanism

To execute the GPU throttling mechanism without interrupting the active inference of the Continuous Stream STT engine, the system utilizes hardware-level power limiting via the NVIDIA Management Library (NVML). In a Python-based pipeline, this is accessed through the `pynvml` library. This API directly interfaces with the NVIDIA driver to physically constrain the hardware without altering the loaded AI models residing in VRAM. 

The programmatic workflow operates as follows:

* **Library Initialization:** At startup, alongside model loading, the application initializes the NVML bindings (`pynvml.nvmlInit()`).
* **Active Polling Trigger:** The background diagnostic thread continuously polls the GPU die temperature using the `pynvml.nvmlDeviceGetTemperature()` command.
* **Throttle Execution:** If the polled temperature exceeds the defined critical threshold (e.g., 82°C), the thread issues the `pynvml.nvmlDeviceSetPowerManagementLimit()` command. By programmatically reducing the GPU's maximum wattage allowance (e.g., dropping a 75W limit down to 45W), the NVIDIA firmware instantly forces the GPU to downclock its core frequency to survive within the new power envelope.
* **Inference Delay:** This forced downclocking mechanically starves the STT model of raw compute speed. This physical hardware constraint directly produces the slight delay in transcription output while preventing a catastrophic thermal crash that would trigger the CPU fallback models.
* **System Restoration:** The diagnostic thread continues active polling. Once the temperature drops back to a safe baseline, a subsequent `nvmlDeviceSetPowerManagementLimit` command restores the original power allowance, instantly returning inference to full real-time speeds.
* **Execution Constraint:** The host application must be executed with elevated administrator or root privileges for NVML power state modification commands to be accepted by the driver during the live service.

---

## 12. RRF Mapping Formula

### Step 1: The RRF Baseline
The standard Reciprocal Rank Fusion (RRF) formula requires a smoothing constant, $k$. In production search pipelines, $k$ is almost universally set to 60. The score for a specific document ($d$) across the two parallel lanes is calculated as:

$$RRF(d) = \frac{1}{k + rank_{BM25}(d)} + \frac{1}{k + rank_{Vector}(d)}$$

### Step 2: Defining the Bounds
Because the system only pulls the Top 5 verses from each lane, there are strict mathematical boundaries for the RRF outputs:

* **The Absolute Maximum ($RRF_{max}$):** A verse is ranked #1 in both the Lexical and Semantic lanes. 
    $$\frac{1}{60+1} + \frac{1}{60+1} \approx 0.0327$$
* **The Absolute Minimum ($RRF_{min}$):** A verse is ranked #5 in only one lane, and does not appear in the other. 
    $$\frac{1}{60+5} + 0 \approx 0.0153$$

### Step 3: The Continuous Mapping Formula
To convert these arbitrary floating-point numbers into the required 0-100% Confidence Score, standard Min-Max normalization is applied:

$$Confidence = \left( \frac{RRF_{observed} - RRF_{min}}{RRF_{max} - RRF_{min}} \right) \times 100$$

This provides a continuous mathematical curve. If empirical testing determines that verses hovering at 60% confidence are triggering false positives in the Auto-Display tier, the $RRF_{min}$ variable in the code is adjusted to artificially compress the scale, forcing lower-ranked combinations to yield lower percentage outputs.

---

## 13. Data Deduplication in Overlapping Windows

The search engine cannot be prevented from evaluating overlapping words because the semantic vector model (`all-MiniLM-L6-v2`) requires the full 15-word context to generate accurate mathematical coordinates. Therefore, deduplication must happen strictly at the routing decision layer (Phase 5). The verifiable, production-standard method for this is implementing a Time-To-Live (TTL) debounce using a Least Recently Used (LRU) cache.

The execution pipeline is handled as follows:

* **The Cache:** A small, fast dictionary is allocated in standard RAM (the LRU Cache) specifically for tracking queued outputs.
* **The Interception:** When Phase 5 determines a verse meets the criteria for the Operator Review Queue (moderate confidence, low intent), the system intercepts the dynamically generated NDI payload or the raw scripture reference (e.g., "John 3:16") before it is pushed to the UI or the `Database_Write_Queue`.
* **The Check:** The system checks the LRU cache. If the exact Verse Reference already exists in the cache, the new result is immediately discarded as a duplicate. If it does not exist, it is pushed to the operator's Review Queue.
* **The TTL (Time-To-Live):** The newly added Verse Reference is assigned a strict TTL (e.g., 15 to 20 seconds). Once the TTL expires, the reference is automatically purged from the cache.

This guarantees that if the 6-word overlap triggers the exact same verse on the next sequential slide, it is silently dropped. By utilizing a 15-second TTL, the system is prevented from locking out the verse permanently; if the pastor deliberately quotes the same verse again three minutes later, the system will correctly queue it as a fresh event.

---

## 14. Offline Cloud Queue Volatility

The architectural foundation for this approach already exists through the `Database_Write_Queue` and the dedicated background thread writing to the SQLite WAL database. To safely save data at as many stages as possible, the pipeline must be converted to treat every critical action as an independent event payload and push it to this existing queue. 

* **Stage 1:** The raw STT output is persisted. The exact millisecond the 15-word sliding window fires, the raw text string must be packaged with its timestamp and pushed to the queue.
* **Stage 2:** Search result metrics are logged. When the fusion and scoring phase completes, the top verse reference, confidence score, and intent score are pushed to the queue to create a forensic audit trail.
* **Stage 3:** UI state changes are captured, logging whenever a verse is auto-displayed via the dynamic NDI payload or pushed to the operator review queue. 

Because the single, dedicated background thread executes these SQL inserts sequentially, the host OS and SQLite will naturally batch these continuous micro-writes without ever forcing the live transcription engines to wait for the hard drive to spin.

**[INDUSTRY STANDARD]** While SQLite WAL mode is highly robust, a sudden power loss during an active database commit can occasionally corrupt the database file index, requiring a zero-overhead fail-safe purely for the raw transcript. Alongside pushing the raw STT output to the database queue, the text must be written directly to an append-only flat file using the operating system's native stream writer. Append-only file streams require virtually zero compute overhead and do not require indexing, guaranteeing that even if the SQLite database is irreparably corrupted by a hardware failure, the entirety of the spoken sermon text remains intact on disk.

---

## 15. BM25 Lexical Stripping Definition

The established production standard for highly specialized text corpora, such as a Bible database, is to abandon default third-party library lists entirely and construct a custom, hardcoded array converted into a strict hash set in memory. Standard libraries like NLTK or spaCy routinely update their default English stop-word lists; relying on them introduces severe regression risks where a minor library update might quietly categorize a crucial archaic word as a standard stop-word, instantly degrading lexical search accuracy. 

To guarantee absolute deterministic stripping, a highly restricted, lightweight array containing strictly modern structural words must be manually defined and permanently integrated into the codebase. This list includes: "the," "is," "a," "and," "to," "of," "in," and "that".

---

## 16. Intent Fallback Trigger Boundaries

In continuous streaming NLP architectures, token overlapping is the established standard for preserving multi-word n-grams without requiring cross-chunk memory state reconstruction. The system design explicitly states that the buffer retains the last 6 words to bridge context into the next iteration. 

Because of this duplication, any trigger phrase up to 7 words in length is mathematically guaranteed to appear contiguously in at least one execution window. For example, if the pastor says "turn to chapter" right at the boundary, Chunk A will evaluate `[..., "turn", "to"]` and fail the intent check. However, Chunk B will initialize with the overlap, evaluating `["turn", "to", "chapter", ...]` and successfully trigger the match against the `intent_triggers.json` array. As long as hardcoded strings remain 6 words or fewer, the system requires absolutely zero additional logic to reliably catch the intent.

---

## 17. Database Tie-Breaking Sequence

A millisecond Unix epoch timestamp cannot be relied upon to guarantee perfect sequence reconstruction. Modern STT inference running on dedicated parallel threads can easily generate multiple overlapping chunk outputs within the same 1-millisecond window. If Thread A and Thread B push distinct text chunks within that same millisecond, they receive identical timestamps. During post-service reconstruction, an `ORDER BY` timestamp query will result in an arbitrary, unpredictable tie-break by the SQLite engine, destroying the chronological flow of the transcript. 

The verifiable, production-standard method to resolve this is implementing a **Monotonically Increasing Sequence ID**. The STT thread must assign a localized, auto-incrementing integer (e.g., Chunk 1, Chunk 2, Chunk 3) to every text payload before it is pushed to the queue. The reconstruction query then becomes `ORDER BY sequence_id ASC`, making the OS scheduler's timing jitter and database insertion order completely irrelevant.

---

## 18. NDI Payload Schema

The established, production-standard execution for NDI graphics pipelines requires the custom application to act as the primary rendering engine. The "payload" sent over NDI is not a structured text file; it is an uncompressed, 32-bit raw video frame (RGBA format).

The execution pipeline operates as follows:

* **Local Rendering:** When the system decides to auto-display a verse, the Python application must use an internal graphics framework (such as PyQt, OpenCV, or an offscreen HTML renderer) to draw the exact scripture text, the reference, and the chosen visual theme onto a transparent digital canvas (e.g., 1920x1080 resolution).
* **Frame Conversion:** This rendered canvas is converted into a raw byte array representing the exact color and alpha (transparency) values of every single pixel on the screen.
* **NDI Transmission:** This completed RGBA byte array is passed into the NDI SDK (via wrappers like `ndi-python`) as a video frame.
* **Broadcast Ingestion:** OBS or vMix connects to this NDI source and overlays it like a standard camera feed. It requires zero data parsing, zero schema logic, and zero rendering compute from the broadcast software.

---

## 19. Audio Interface Ingestion Specs

### Whisper Ingestion Specifications
Regardless of how the audio arrives at the computer, to prevent the CPU from burning compute cycles on real-time downsampling, Thread 1 must be hardcoded to capture and ingest the audio exactly as Faster-Whisper natively expects it:

* **Sample Rate:** 16,000 Hz (16 kHz).
* **Channel Count:** 1 Channel (Mono). Whisper's architecture does not process stereo separation.
* **Bit Depth:** 16-bit PCM. Within the Python script, this is normalized into a 32-bit float array ranging from -1.0 to 1.0 immediately before being passed to the model.

### [INDUSTRY STANDARD] Wireless Audio Transmission (Primary Objective)
Securing a clean, dedicated audio feed remains the primary objective. By circumventing physical XLR cable requirements with a standard wireless transmitter (e.g., a prosumer Rode Wireless PRO or a Sennheiser IEM transmitter) connected to an isolated Aux Send or Matrix on the FOH console, a clean signal is guaranteed. Crucially, this utilizes zero system compute, protecting the strict 4GB VRAM hardware constraint.

### [CREATIVE WORKAROUND] DeepFilterNet 3 (DFN 3) Pre-Processing (Last Resort)
If hardware budgeting for a wireless unit is denied and physical routing is impossible, executing a software patch via C++ DFN 3 plugins is the remaining option to salvage room audio. Corrupted audio must be piped through the DFN 3 algorithm to strip background noise before reaching the 15-word sliding window buffer. To make this viable, the custom streaming STT model must be fine-tuned strictly on the artifact-heavy output generated by DFN 3 within that specific church sanctuary.

---

## 20. JSON Intent Structure

To maintain the lightweight, zero-compute execution mandated by the architecture, the established standard structure must be a flat, root-level JSON object. The keys must strictly define the target Intent State, and the values must be one-dimensional arrays of exact strings.

```json
{
  "high_intent": [
    "turn to chapter",
    "turn to",
    "open your bibles",
    "verse"
  ],
  "medium_intent": [
    "the bible says",
    "scripture tells us",
    "jesus said"
  ],
  "ignore_intent": [
    "turn off",
    "turn down"
  ]
}
```

This specific schema is the industry standard for fast, in-memory text matching because it allows the initialization thread to deserialize the JSON directly into native Python dictionary sets or lists. This structure permits highly optimized string inclusion checks (e.g., `if any(trigger in spoken_text for trigger in triggers['high_intent']):`) during Phase 4 of the search pipeline without introducing complex parsing overhead.


## 21. Slow Speech & The Deadlock Threshold
**Question:** If the pastor speaks 14 words and pauses for a two-minute musical transition, does the inference engine hang indefinitely waiting for the 15th word, and how do we score the resulting fragment?

**Resolution:** * **The TTL Flush [INDUSTRY STANDARD]:** The system must implement a strict Time-To-Live (TTL) timeout on the ingestion buffer (e.g., 3 to 5 seconds of silence). Upon timeout, the system executes a partial search on the current buffer contents (e.g., the 14 words) through the BM25 and FAISS lanes. Immediately following this evaluation, the buffer must be completely flushed. Retaining stale text across a two-minute pause and concatenating it with newly resumed speech will mathematically destroy the geometric vector coordinates generated by the semantic model.
* **Dynamic RRF Scaling [INDUSTRY STANDARD]:** Because a flushed, partial buffer inherently lacks the robust semantic context required by all-MiniLM-L6-v2, the raw Reciprocal Rank Fusion (RRF) score will naturally drop. To prevent unfairly penalizing shorter scriptures, the normalization algorithm must introduce a dynamic scaling factor. As the buffer's word count drops below the 15-word threshold, the system programmatically lowers the RRF_max variable in the normalization equation. This compresses the grading scale, allowing mathematically weaker raw RRF scores from a 6-word phrase to successfully achieve the 85% Auto-Display threshold.

## 22. Vosk Failover & Buffer Handoff
**Question:** When the GPU overheats and the Faster-Whisper thread is killed, how does the continuous audio stream survive the transition to the CPU-only Vosk model without dropping the sentence mid-flight?

**Resolution:** * **Acknowledgment Receipt System [INDUSTRY STANDARD]:** Simply killing the STT thread will destroy any un-transcribed audio currently held in its local memory. To prevent this, the audio ingestion queue (Queue A) must enforce a strict acknowledgment receipt protocol. When the primary STT thread pulls a 16kHz audio chunk, that chunk remains in a "pending" state. It is only purged from Queue A after the STT engine successfully pushes the resulting text payload to Queue B. If the primary model crashes, the system flags all unacknowledged audio chunks as failed, allowing the newly initialized Vosk thread to seamlessly pull those exact same chunks and resume transcription without data loss.

## 23. NDI Python CPU Bottleneck & UI VRAM Contention
**Question:** Pushing uncompressed 1920x1080 RGBA video frames continuously through a Python NDI wrapper will cause severe CPU bottlenecking. Furthermore, how do we restrict the Python UI renderer to standard RAM so it doesn't fight the STT model for the 4GB of VRAM?

**Resolution:** * **The WebSocket/HTML Pivot [INDUSTRY STANDARD]:** The Python application must be completely abandoned as a pixel renderer. You must shift the graphical compute burden entirely to the broadcast software.
    1. **The Dispatcher:** Python initializes a lightweight WebSocket server. When an Auto-Display is triggered, Python packages the text, reference, and theme ID into a microscopic JSON string (e.g., `{"action": "display", "ref": "John 3:16", "theme": "communion"}`) and pushes it over the network.
    2. **The Renderer:** A static HTML/CSS/JS file acts as the receiver. The JavaScript listens to the WebSocket and updates the DOM. Visual themes are executed instantly by swapping CSS classes (handling fonts, kerning, and drop-shadows natively).
    3. **Broadcast Ingestion:** In OBS/vMix, the NDI Media Source is replaced with a "Browser Source" pointing to the HTML file. The broadcast software’s highly optimized internal Chromium engine executes the render via hardware acceleration, permanently eliminating Python VRAM contention and CPU bottlenecks.
* **Video Backgrounds [INDUSTRY STANDARD]:** Looping MP4/WebM motion backgrounds must be decoupled from the text rendering. Place the video loop as a standard Media Source on the bottom layer of your OBS scene, and place the transparent HTML Browser Source above it. Do not attempt to force Python or the Browser Source to decode background video files.

## 24. Cloud LLM Payload Size & Formatting Resiliency
**Question:** A 2-hour transcript exceeds 15,000 words. Do we send this monolithic string to Gemini/Claude, or chunk it? If the LLM returns malformed text instead of JSON, does it crash the extraction phase? Can we use open-source models for free?

**Resolution:**
* **Monolithic Payloads [INDUSTRY STANDARD]:** The entire 15,000-word (approx. 20,000 tokens) transcript must be transmitted as a single monolithic payload. Chunking destroys the overarching narrative context required to correlate prophetic tonal shifts. This easily fits within the context windows of Gemini 1.5 Flash (2M tokens) and Claude 3 Haiku (200K tokens).
* **Extraction Stability [INDUSTRY STANDARD]:** You must enforce schema strictly by utilizing the native "Structured Outputs" or "JSON Mode" parameters provided by the inference API. Furthermore, the extraction function must be wrapped in a try/except block with a 3-attempt retry loop. If deserialization fails, the parsing error is appended to the prompt and the endpoint is re-queried before failing over to the backup model.
* **Open-Source via Serverless Inference [INDUSTRY STANDARD]:** To utilize open-source models (Llama 3.1, Qwen 2.5) efficiently and at zero cost, you must query them via serverless inference API providers with generous free tiers (e.g., Groq, Together AI). Building custom, asynchronous batch-processing pipelines on platforms like Kaggle introduces catastrophic execution latency (15-30 minutes) and violates standard production REST architecture.

## 25. Cloud Reconnect Polling Logic
**Question:** If the internet drops, what is the exact polling frequency to check if the connection is restored without flooding the network interface?

**Resolution:**
* **Exponential Backoff with Jitter [INDUSTRY STANDARD]:** A static polling loop will spam a dead router. The system must implement exponential backoff. The first ping attempts after a 5-second delay. Upon failure, the delay multiplies by 2 (10s, 20s, 40s), capped at a hard maximum of 5 minutes. A randomized variance (±20% jitter) should be applied to the interval to prevent predictable execution spikes.
* **Verification Ping:** The connection is officially "restored" only when an HTTP GET request to a highly available endpoint (e.g., 1.1.1.1 or the target API's health check) returns a 200 OK header within a strict 3-to-5 second timeout boundary.

## 26. Thread Teardown Protocol
**Question:** During Phase 3, how exactly are the background AI threads safely "spun down" without leaving database locks or causing deadlocks?

**Resolution:**
* **Sequential Poison Pills [INDUSTRY STANDARD]:** You must never issue forced kill commands against threads interacting with the SQLite database. When the service ends, the main thread pushes a sentinel object (a "poison pill") into Queue A. The STT thread processes its audio, detects the pill, pushes a new pill to Queue B, and exits. The Search Thread pulls from Queue B, detects the pill, pushes a final pill to the Database_Write_Queue, and exits. The DB Thread commits the WAL file, closes the connection, and exits cleanly.
* **Timeout Joins [INDUSTRY STANDARD]:** If the FAISS search thread hangs mid-calculation, it will deadlock the application shutdown sequence if naive blocking joins are used. The main thread must enforce a strict time limit (e.g., `search_thread.join(timeout=3.0)`). If the thread fails to acknowledge the poison pill within 3 seconds, the main thread abandons it, injects a poison pill directly to the DB Queue, and proceeds to cloud extraction. The OS will reap the hung thread upon final process termination.

## 27. Audio Interface Python API
**Question:** Which specific Python library is approved for capturing the 16kHz, 16-bit PCM raw hardware audio and normalizing it to a 32-bit float array?

**Resolution:**
* **Zero-Copy Normalization (sounddevice) [INDUSTRY STANDARD]:** You must mandate the `sounddevice` library. By configuring the InputStream to strictly capture `dtype='float32'`, the underlying C library (PortAudio) handles the 16-bit to 32-bit float conversion at the hardware layer. This native NumPy output completely eliminates the heavy CPU overhead required to mathematically divide raw byte arrays in Python (as would be required by legacy libraries like PyAudio).

## 28. Append-Only File Permissions
**Question:** What is the directory path and naming convention for the append-only flat file fail-safe, and what happens if the OS locks the file?

**Resolution:**
* **Un-synced Paths and ISO 8601 [INDUSTRY STANDARD]:** The file must never be saved in standard user directories (Desktop/Documents) where background agents like OneDrive/Dropbox will instantly lock the file during sync attempts. Route the file to an isolated path (e.g., `C:\ProgramData\YourApp\Logs\`). The file must use ISO 8601 naming (e.g., `YYYY-MM-DD_HH-MM-SS_raw_stt.log`) to prevent arbitrary OS sorting errors.
* **Failover Generation [INDUSTRY STANDARD]:** If an external process places an exclusive lock on the active `.log` file, the `write()` command will throw a `PermissionError`. The DB thread must catch this exception, immediately close the file handle, generate a new file with an incremented suffix (e.g., `..._raw_stt_PART2.log`), append the text to the new file, and trigger a UI warning.

## 29. Sequence ID Scope
**Question:** Does the database tie-breaking "Sequence ID" reset to 1 every time the application boots, or is it a global variable?

**Resolution:**
* **Session-Scoped Composite Keys [INDUSTRY STANDARD]:** Resetting the integer to 1 every service will mathematically destroy chronological retrieval if multiple services are stored in the same database. During Phase 1 Initialization, the application must generate a globally unique identifier for the specific service (a Session UUID, e.g., `2026-04-16_AM`). When the STT thread assigns the localized Sequence ID (1, 2, 3...), it is packaged alongside this Session UUID. The reconstruction query is strictly constrained (`SELECT text FROM transcripts WHERE session_id = ? ORDER BY sequence_id ASC`), ensuring perfect historical isolation while allowing the local counter to safely reset on boot.