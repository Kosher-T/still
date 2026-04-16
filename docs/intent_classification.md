# Intent Classification

This document specifies how Still determines whether the pastor is actively quoting scripture or merely referencing a biblical narrative. Intent classification is Phase 4 of the search pipeline and runs in approximately 15–20 milliseconds.

---

## Purpose

A high-confidence verse match is meaningless if the pastor is telling a casual story about David and Goliath without wanting 1 Samuel 17 displayed on screen. The intent classifier prevents false auto-displays by evaluating the **context and language** of the spoken text, independent of the search confidence score.

---

## Primary Classifier: Fine-Tuned DistilBERT

### Model Overview

| Property | Value |
|----------|-------|
| **Base model** | `DistilBERT` (Hugging Face) |
| **Fine-tuning** | Trained on labeled pastoral speech segments (quoting vs. narrative vs. casual) |
| **Execution** | CPU (standard RAM) — no GPU VRAM consumed |
| **Inference time** | ~15–20 ms per 15-word text block |
| **Output** | Categorical: High / Medium / Low intent score |

### Output Definitions

| Score | Meaning | Example |
|-------|---------|---------|
| **High** | The pastor is actively directing the congregation to a scripture reference, using command language or transitional quote phrases | *"Turn to John chapter 3 verse 16..."* |
| **Medium** | Ambiguous — the speech contains biblical language but could be narrative or quotation | *"And the Bible tells us that God so loved the world..."* |
| **Low** | Casual mention of a biblical concept, character, or theme without quoting intent | *"It's like when David faced Goliath, you know, we all have giants..."* |

### Training Data Strategy

The DistilBERT model requires labeled training data in three categories:

1. **High intent samples** — Transcribed segments where the pastor explicitly directs the congregation to open their Bibles, quotes scripture verbatim, or uses command language (e.g., "turn to," "read with me," "the Word says").
2. **Medium intent samples** — Segments where the pastor references scripture indirectly, paraphrases, or uses transitional phrasing that could indicate either quoting or storytelling.
3. **Low intent samples** — Segments of general preaching, illustrations, personal anecdotes, and narrative storytelling that happen to reference biblical characters or themes.

> [!TIP]
> Historical sermon transcripts from the same pastor are the ideal training corpus. The model should be fine-tuned on the specific speech patterns, cadence, and transitional phrases used by the target pastor for maximum accuracy.

---

## Fallback Classifier: `intent_triggers.json`

If DistilBERT proves too heavy for the hardware, fails during the service, or is explicitly bypassed during a system degradation event, the system falls back to zero-compute string matching against a preloaded JSON configuration file.

### Schema Definition

The JSON file uses a strict, flat root-level structure. Keys define the target Intent State, and values are one-dimensional arrays of exact trigger strings.

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

> [!IMPORTANT]
> **Why this schema?** The flat structure allows the initialization thread to deserialize the JSON directly into native Python dictionary sets or lists. This permits highly optimized string inclusion checks (`if any(trigger in spoken_text for trigger in triggers['high_intent']):`) with zero parsing overhead during the live service.

### Loading and Storage

1. During **Phase 1 (Initialization)**, the JSON file is read from disk and deserialized.
2. The resulting dictionary is stored **permanently in standard RAM** for the entire application lifecycle.
3. There is **zero disk read overhead** during the live service — all matching runs against the in-memory data structure.
4. The file is configurable — the system admin can edit trigger phrases at startup or via a dedicated settings interface without modifying application code.

### Fallback Execution Logic

When DistilBERT is bypassed:

1. The system scans the incoming 15-word text buffer against every string in the `high_intent` and `medium_intent` arrays.
2. If a trigger phrase is detected **alongside** a high BM25/FAISS confidence score, the Intent Score is automatically flagged as "High."
3. This triggers auto-display via the standard Phase 5 routing logic.

The `ignore_intent` array provides explicit negative overrides — phrases like "turn off" or "turn down" that share vocabulary with legitimate triggers ("turn to") but indicate non-biblical commands.

---

## Trigger Boundary Math

### The 6-Word Overlap Guarantee

The search engine's sliding window retains the last 6 words as a trailing overlap between consecutive iterations (see [search_engine.md](search_engine.md)). This overlap creates a mathematical guarantee for fallback trigger detection:

**Any hardcoded trigger phrase of 7 words or fewer is guaranteed to appear contiguously in at least one execution window.**

### Proof by Example

Suppose the pastor says *"everyone please turn to chapter three"* right at the word boundary between Chunk A and Chunk B:

| Chunk | Buffer Contents | Trigger Check |
|-------|----------------|---------------|
| **Chunk A** | `[... "everyone", "please", "turn", "to"]` | ❌ Partial match only ("turn to") — but no "chapter" |
| **Chunk B** | `["please", "turn", "to", "chapter", "three", ...]` | ✅ Full match: "turn to chapter" |

Because Chunk B initializes with the 6-word overlap from Chunk A, the multi-word trigger phrase *"turn to chapter"* appears contiguously and is caught.

### Design Constraint

All trigger phrases in `intent_triggers.json` should be **6 words or fewer** to guarantee reliable detection. Phrases exceeding this length risk being split across two chunks with no overlap to bridge them.

> [!NOTE]
> The 7-word guarantee (6-word overlap + 1) applies to the absolute maximum phrase length that is mathematically guaranteed to be caught. In practice, keep phrases concise (2–4 words) for the fastest matching.

---

## Integration with the Search Pipeline

Intent classification occurs at **Phase 4** of the search pipeline, after RRF fusion scoring is complete:

```mermaid
graph LR
    P3["Phase 3<br>RRF Score: 0-100%"] --> P4["Phase 4<br>Intent: High/Med/Low"]
    P4 --> P5["Phase 5<br>Display Decision"]
```

The display decision matrix in Phase 5 combines both scores:

| Confidence | Intent | Action |
|-----------|--------|--------|
| ≥ 85% | High | Auto-Display |
| ≥ 85% | Medium | Auto-Display |
| 40–84% | Any | Operator Review Queue |
| < 40% | Any | Discard |

See [search_engine.md](search_engine.md) Phase 5 for the complete routing specification.

---

## Cross-References

- **Search pipeline integration:** [search_engine.md](search_engine.md)
- **DistilBERT model specifications:** [ai_models.md](ai_models.md)
- **Display routing after intent check:** [display_and_broadcast.md](display_and_broadcast.md)
