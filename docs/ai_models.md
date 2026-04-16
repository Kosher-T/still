# AI Models

This document specifies every AI model integrated into Still, including its purpose, hardware placement, memory footprint, and backup strategy.

---

## VRAM and RAM Partitioning Strategy

All model placement follows a strict rule: **only the primary STT model touches the GPU**. Every other model runs on CPU via standard RAM to protect the 4 GB VRAM budget.

| Model | Runs On | Memory Type | Estimated Footprint |
|-------|---------|-------------|---------------------|
| Custom Faster-Whisper (STT) | GPU | VRAM | ~1–2 GB (model-dependent) |
| `all-MiniLM-L6-v2` (Embedding) | CPU | RAM | ~90 MB |
| Fine-tuned DistilBERT (Intent) | CPU | RAM | ~250 MB |
| FAISS Index (186K verses × 384 dims) | CPU | RAM | ~280 MB |
| BM25 Inverted Index | CPU | RAM | ~50–100 MB |
| `intent_triggers.json` (Fallback) | CPU | RAM | < 1 KB |
| Vosk `vosk-model-small-en-us` (Failover) | CPU | RAM | ~50 MB |

> [!NOTE]
> **Total estimated RAM usage** for all non-GPU models and indexes: ~700 MB – 1 GB. This is well within the 16 GB minimum system requirement, leaving ample headroom for the OS, Python runtime, SQLite, and the WebSocket server.

---

## 1. Speech-to-Text (STT) Engine — Continuous Stream

The core engine that converts live audio into text in real-time using a continuous streaming architecture driven by a 15-word sliding window.

### Primary: Custom Fine-Tuned Streaming STT

| Property | Value |
|----------|-------|
| **Base** | Faster-Whisper (CTranslate2 backend) |
| **Execution** | GPU (VRAM) |
| **Fine-tuning** | Heavily trained off-site via Kaggle on the target pastor's specific voice |
| **Input format** | 16 kHz, mono, 32-bit float (see [audio_ingestion.md](audio_ingestion.md)) |
| **Architecture** | Continuous stream — no VAD chunking, no acoustic pause triggers |

**Why fine-tune off-site?** Training is computationally expensive and would saturate the local 4 GB VRAM. By fine-tuning on Kaggle's GPU infrastructure, the training compute is completely offloaded, and the local GPU is reserved strictly for optimized real-time inference.

**DFN 3 adaptation:** If a clean wireless audio feed cannot be secured and corrupted room audio must be salvaged via DeepFilterNet 3, the STT model must be specifically fine-tuned on the artifact-heavy audio output produced by DFN 3 within the target church sanctuary. This ensures the model learns to transcribe accurately from DFN 3's characteristic processing artifacts rather than being confused by them.

### Backup: Vosk (`vosk-model-small-en-us`)

| Property | Value |
|----------|-------|
| **Execution** | CPU only (standard RAM) |
| **Model size** | ~50 MB |
| **Streaming** | Native word-by-word streaming |
| **Activation** | Triggered only when the primary GPU model crashes or causes a critical thermal event that cannot be resolved by power throttling |

Vosk is the **final fail-safe**. It runs entirely on the CPU, producing lower-quality transcription but ensuring the service never goes dark. See [threading_and_lifecycle.md](threading_and_lifecycle.md) for the acknowledgment receipt protocol that ensures zero audio loss during the GPU → CPU failover transition.

> [!IMPORTANT]
> Standalone Voice Activity Detection (VAD) chunking has been **deprecated** in favor of the fixed-word sliding window architecture. This reduces system complexity and conserves GPU compute.

---

## 2. Semantic Embedding Model — The Search Brain

Powers the FAISS semantic search lane by converting spoken text into 384-dimensional mathematical vectors.

### Primary: `all-MiniLM-L6-v2`

| Property | Value |
|----------|-------|
| **Model size** | ~90 MB |
| **Execution** | CPU via ONNX Runtime (CPU execution provider) |
| **Output dimensions** | 384 |
| **Inference time** | ~20–30 ms per 15-word block |
| **VRAM usage** | Zero — runs entirely in standard RAM |

**Why ONNX?** Running the embedding model via ONNX Runtime on the CPU execution provider ensures it never competes with the STT model for GPU memory. ONNX provides near-native inference speeds on CPU, making it ideal for the strict VRAM isolation requirement.

### Backup: `paraphrase-MiniLM-L3-v2`

| Property | Value |
|----------|-------|
| **Model size** | ~60 MB |
| **Output dimensions** | 384 |
| **Trade-off** | Slightly lower paraphrase recognition accuracy in exchange for faster CPU inference |

Activated only if the primary model causes unacceptable CPU latency during testing.

---

## 3. Intent Classifier — The Trigger Decision

Determines whether the pastor is actively quoting scripture or casually referencing a biblical narrative. See [intent_classification.md](intent_classification.md) for the full specification.

### Primary: Fine-Tuned DistilBERT

| Property | Value |
|----------|-------|
| **Base model** | DistilBERT (Hugging Face) |
| **Model size** | ~250 MB |
| **Execution** | CPU (standard RAM) |
| **Output** | Categorical: High / Medium / Low intent score |
| **Inference time** | ~15–20 ms |

DistilBERT is a compressed language model that accurately detects quoting context in real-time without consuming GPU resources.

### Backup: `intent_triggers.json` (String Matching)

| Property | Value |
|----------|-------|
| **Compute cost** | Zero (simple string inclusion checks) |
| **Storage** | < 1 KB in RAM |
| **Activation** | Automatic when DistilBERT is bypassed or fails |

A flat JSON file containing arrays of pastoral trigger phrases (e.g., "turn to," "open your bibles," "verse") loaded into RAM at startup. Provides a brittle but highly reliable safety net using basic `if any(trigger in text ...)` matching. See [intent_classification.md](intent_classification.md) for the full schema and matching logic.

---

## 4. Cloud LLM — Post-Service Extraction

After the service ends, the complete transcript is sent to a cloud-based LLM for structured extraction of prayer points, declarations, and prophetic words. See [cloud_pipeline.md](cloud_pipeline.md) for the full pipeline specification.

### Primary: Gemini 1.5 Flash / Claude 3 Haiku

| Property | Gemini 1.5 Flash | Claude 3 Haiku |
|----------|-------------------|----------------|
| **Context window** | 2,000,000 tokens | 200,000 tokens |
| **Specialty** | Blazing-fast text analysis, high-volume extraction | Strict formatting compliance, consistent JSON output |
| **Cost** | Highly cost-effective | Highly cost-effective |

Both models comfortably ingest the full ~20,000-token monolithic sermon transcript in a single request. See [cloud_pipeline.md](cloud_pipeline.md) for why chunking is prohibited.

### Backup: GPT-4o-mini

A capable alternative activated if the primary models experience API outages or formatting inconsistencies.

### Open-Source Alternative: Serverless Inference

Open-source models (Llama 3.1, Qwen 2.5) can be queried at zero cost via serverless inference API providers with generous free tiers:

| Provider | Free Tier |
|----------|-----------|
| **Groq** | Generous token allowance, extremely fast inference |
| **Together AI** | Free tier for common open-source models |

> [!WARNING]
> **Do not** attempt to run open-source models via custom batch-processing pipelines on Kaggle. This introduces catastrophic execution latency (15–30 minutes) and violates standard production REST architecture. Always use serverless inference APIs.

---

## Cross-References

- **VRAM and thermal management:** [gpu_and_hardware.md](gpu_and_hardware.md)
- **Audio input format for STT:** [audio_ingestion.md](audio_ingestion.md)
- **Search pipeline (embedding + FAISS):** [search_engine.md](search_engine.md)
- **Intent classification details:** [intent_classification.md](intent_classification.md)
- **Cloud extraction pipeline:** [cloud_pipeline.md](cloud_pipeline.md)
- **Vosk failover protocol:** [threading_and_lifecycle.md](threading_and_lifecycle.md)
