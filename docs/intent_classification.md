# Intent Classification

This document specifies how Still determines whether the pastor is actively quoting scripture or merely referencing a biblical narrative. Intent classification is Phase 4 of the search pipeline and executes in less than 1 millisecond.

---

## The Deprecation of DistilBERT

> [!IMPORTANT]
> **DistilBERT is deprecated.** An early version of the architecture relied on a 250 MB fine-tuned DistilBERT model to classify intent into Categorical states (High/Medium/Low). This proved to be a massive compute and memory sink that over-complicated the problem. It has been entirely struck from the architecture.

"Intent" is now simplified to a single boolean state: **Trigger Detected (True/False)**.

---

## Heuristic Gating: `intent_triggers.json`

The system relies on a zero-compute Regex matching engine driven by a predefined JSON configuration file.

### Schema Definition

The JSON file uses a strictly flat, root-level structure.

```json
{
  "trigger_intent": [
    "turn to chapter",
    "turn to",
    "open your bibles",
    "verse"
  ],
  "ignore_intent": [
    "turn off",
    "turn down"
  ]
}
```

### Token-Window Regex Compilation (Phase 1)

**The Problem:** Human stutters (e.g., "turn to, uh, chapter") break standard contiguous substring matching logic defined for simple JSON trigger phrases.

**The Solution:** During Phase 1 Initialization, the system parses the user-defined trigger phrases and compiles them into bounded Regular Expressions.

A trigger like `"turn to chapter"` compiles algorithmically to allow for a token wildcard gap (e.g., up to 2 filler words between target tokens):

```regex
\bturn\b(?:\s+\w+){0,2}\s+\bto\b(?:\s+\w+){0,2}\s+\bchapter\b
```

This natively absorbs filler words and stutters while executing at C-level speeds, matching the dynamic nature of human speech without the overhead of an ML model.

---

## Intent Fallback & State Mapping

Every 15-word block entering Phase 4 initializes with a default Intent Score of **False**.

### 1. The Negative Override Priority

The `ignore_intent` array provides explicit negative overrides — phrases like "turn off" or "turn down" that share vocabulary with legitimate triggers ("turn to") but indicate non-biblical commands.

This array is evaluated **first**. If a match is found:
- The system locks the Intent state to `False`.
- Evaluation immediately exits to prevent false positives.

### 2. The Positive Evaluation

If no negative override is found, the compiled regex patterns from `trigger_intent` are evaluated.
- If a match is found: Intent becomes `True`.
- If no positive trigger is found: The block simply exits retaining its default `False` state.

---

## Trigger Boundary Math

### The 6-Word Overlap Guarantee

The search engine's sliding window retains the last 6 words as a trailing overlap between consecutive iterations (see [search_engine.md](search_engine.md)). This overlap creates a mathematical guarantee for fallback trigger detection:

**Any hardcoded trigger phrase (excluding wildcards) of 7 words or fewer is guaranteed to appear contiguously in at least one execution window.**

### Proof by Example

Suppose the pastor says *"everyone please turn to chapter three"* right at the word boundary between Chunk A and Chunk B:

| Chunk | Buffer Contents | Trigger Check |
|-------|----------------|---------------|
| **Chunk A** | `[... "everyone", "please", "turn", "to"]` | ❌ Partial |
| **Chunk B** | `["please", "turn", "to", "chapter", "three", ...]` | ✅ Full match |

Because Chunk B initializes with the 6-word overlap from Chunk A, the multi-word trigger phrase is guaranteed to appear contiguously within the window.

---

## Integration with the Display Decision

Intent classification occurs at **Phase 4** of the search pipeline, after RRF fusion scoring is complete.

The display decision matrix in Phase 5 combines the RRF Rank Score with the Boolean Trigger State:

| Confidence | Trigger State | Action |
|-----------|---------------|--------|
| ≥ 85% | `True` | **Auto-Display** (Pushed instantly to OBS) |
| ≥ 85% | `False` | **Operator Review Queue** |
| 40–84% | Any | **Operator Review Queue** |
| < 40% | Any | **Discard** |

See [search_engine.md](search_engine.md) Phase 5 for the complete routing specification.

---

## Cross-References

- **Search pipeline integration:** [search_engine.md](search_engine.md)
- **Display routing after intent check:** [display_and_broadcast.md](display_and_broadcast.md)
- **Regex compilation phase:** [architecture.md](architecture.md)
