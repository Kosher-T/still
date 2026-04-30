# Cloud Pipeline

This document specifies how Still handles post-service transcript extraction via cloud LLMs, including payload construction, structured output enforcement, retry logic, offline queuing, and reconnection polling.

---

## Overview

After the service ends (Phase 3), the complete sermon transcript is sent to a cloud-based Large Language Model for structured extraction. The LLM identifies and isolates three categories of content:

1. **Declarations** — Formatted prayer points, commands, and petitions.
2. **Prophecies** — Prophetic words, "Thus says the Lord" moments isolated from general preaching.
3. **Summary** — A condensed overview of the sermon's key themes and scripture references.

---

## Payload Construction

### Monolithic Transmission

The entire transcript is transmitted as a **single monolithic payload**. Chunking is strictly prohibited.

| Property | Value |
|----------|-------|
| **Typical transcript length** | ~15,000 words (~20,000 tokens) for a 2-hour service |
| **Transmission** | Single API request containing the complete transcript |
| **Why no chunking?** | Chunking destroys the overarching narrative context required to correlate tonal shifts, identify prophetic moments vs. casual references, and understand sermon arc |

### Context Window Compatibility

The monolithic payload fits comfortably within the context windows of all target models:

| Model | Context Window | Payload Utilization |
|-------|---------------|---------------------|
| Gemini 1.5 Flash | 2,000,000 tokens | ~1% |
| Claude 3 Haiku | 200,000 tokens | ~10% |
| GPT-4o-mini | 128,000 tokens | ~16% |
| Llama 3.1 (via Groq) | 128,000 tokens | ~16% |

---

## Structured Output Enforcement

### The Problem

An LLM may occasionally return malformed text, incomplete JSON, or deviate from the requested schema. This must never crash the extraction phase.

### The Solution

1. **Native structured outputs.** Always use the inference API's native "Structured Outputs" or "JSON Mode" parameter. This forces the model to return valid JSON conforming to a predefined schema.
2. **Schema definition.** Provide the expected JSON schema in the API request.
3. **Retry loop.** If deserialization still fails, the system retries.

### Expected Response Schema

```json
{
  "declarations": [
    {
      "text": "I declare that no weapon formed against this house shall prosper.",
      "context": "Spoken during the altar call segment.",
      "timestamp_approx": "01:23:45"
    }
  ],
  "prophecies": [
    {
      "text": "Thus says the Lord: I am opening doors that no man can shut.",
      "context": "Delivered during the prophetic segment after worship.",
      "timestamp_approx": "00:45:12"
    }
  ],
  "summary": {
    "title": "Walking Through Open Doors",
    "key_themes": ["faith", "divine provision", "prophetic destiny"],
    "scriptures_referenced": ["Isaiah 54:17", "Revelation 3:8", "John 3:16"],
    "duration_minutes": 118
  }
}
```

### Example Prompt Structure

```
You are a church service transcript analyzer. You will receive the full, unedited transcript of a live sermon. Your task is to extract the following:

1. DECLARATIONS: Any prayer points, commands, decrees, or petitions spoken by the pastor. Strip filler words and format as clear, bulleted statements.

2. PROPHECIES: Any moments where the pastor speaks in a prophetic tone — "Thus says the Lord," direct divine utterances, or words of knowledge. Isolate these from general preaching.

3. SUMMARY: A concise overview of the sermon including the implied title, key themes, and all scripture references mentioned.

Return your response as a JSON object conforming to this exact schema:
{schema}

TRANSCRIPT:
{transcript}
```

---

## Retry Logic

The extraction function is wrapped in a robust retry loop:

```python
MAX_RETRIES = 3

async def extract_with_retry(transcript: str) -> dict:
    for attempt in range(MAX_RETRIES):
        try:
            response = await call_primary_llm(transcript)
            return json.loads(response)  # Validate JSON
        except (json.JSONDecodeError, ValidationError) as e:
            if attempt < MAX_RETRIES - 1:
                # Append the error to the prompt for self-correction
                transcript_with_error = (
                    f"{transcript}\n\n"
                    f"[SYSTEM NOTE: Your previous response failed JSON parsing "
                    f"with error: {str(e)}. Please return valid JSON only.]"
                )
                continue
            else:
                # All retries exhausted on primary — failover to backup
                return await call_backup_llm(transcript)
```

### Failover Chain

| Priority | Model | Trigger |
|----------|-------|---------|
| 1 | Gemini 1.5 Flash | Default primary |
| 2 | Claude 3 Haiku | Primary fails all 3 retries or API outage |
| 3 | GPT-4o-mini | Both primary and secondary fail |
| 4 | Open-source (Llama 3.1 / Qwen 2.5 via Groq/Together AI) | All commercial APIs down |

---

## Offline Queuing

### The Problem

The church's internet connection may drop at the end of the service, preventing immediate cloud handoff.

### The Solution

If the initial API request fails due to a network error, **or if the cloud LLM pipeline encounters an HTTP 429 (Rate Limit) or HTTP 5xx (Server Error) across the entire failover chain**, the monolithic payload is preserved in a **local offline queue**. The system then categorizes the failure and polls for restoration.

```python
async def send_to_cloud(transcript: str):
    try:
        result = await extract_with_retry(transcript)
        save_extraction_results(result)
    except NetworkError:
        queue_for_later(transcript, reason="network_down")
        start_reconnect_polling(reason="network_down")
    except TerminalAPIError:
        # e.g., HTTP 429 or 5xx across all failover models
        queue_for_later(transcript, reason="api_exhausted")
        start_reconnect_polling(reason="api_exhausted")
```

The queued payload is persisted to disk (not just RAM) to survive application restarts:

```python
def queue_for_later(transcript: str):
    payload = {
        'session_id': current_session_id,
        'transcript': transcript,
        'queued_at': int(time.time() * 1000),
    }
    with open(OFFLINE_QUEUE_PATH, 'a') as f:
        f.write(json.dumps(payload) + '\n')
```

### Operator Consent Gate & Backlog Processing

If the system was packed away without internet for weeks, the offline queue script would historically attempt to silently process the backlog of monolithic LLM requests the next time it boots. This immediately hijacked network bandwidth and CPU cycles during a new live service.

To prevent this, background batching must not hijack the system silently:

- Upon boot, the initializer checks if the `OFFLINE_QUEUE_PATH` file contains data.
- If data exists, the Main Thread UI raises a non-blocking, critical alert: *"X past services are pending cloud extraction. Process now or pause until after the current service?"*
- The operator explicitly dictates when network bandwidth is allocated to backlog processing.

---

## Reconnection Polling: Exponential Backoff with Jitter

A static polling loop will spam a dead router. The system implements exponential backoff with randomized jitter.

### Algorithm

```python
import random

BASE_DELAY = 5          # seconds
MAX_DELAY = 300         # 5 minutes
MULTIPLIER = 2
JITTER_RANGE = 0.2      # ±20%
HEALTH_CHECK_URL = "https://1.1.1.1"
TIMEOUT = 5             # seconds

async def reconnect_loop():
    delay = BASE_DELAY
    
    while True:
        await asyncio.sleep(delay)
        
        if await check_connection():
            await process_offline_queue()
            return
        
        # Exponential backoff with jitter
        delay = min(delay * MULTIPLIER, MAX_DELAY)
        jitter = delay * random.uniform(-JITTER_RANGE, JITTER_RANGE)
        delay += jitter
```

### Reconnection Schedule

| Attempt | Base Delay | With Jitter (±20%) |
|---------|------------|---------------------|
| 1 | 5 s | 4–6 s |
| 2 | 10 s | 8–12 s |
| 3 | 20 s | 16–24 s |
| 4 | 40 s | 32–48 s |
| 5 | 80 s | 64–96 s |
| 6 | 160 s | 128–192 s |
| 7+ | 300 s (cap) | 240–360 s |

### Segregated Verification Ping

The system distinguishes between local network failures and remote API exhaustion when polling:

- **`network_down` payloads**: Unblocked by a successful HTTP GET request to `1.1.1.1` (verifying local internet is restored).
- **`api_exhausted` payloads**: Unblocked *only* by pinging the specific LLM provider's status/health endpoint (e.g., OpenAI/Groq API status) using the exponential backoff schedule to prevent ban loops.

```python
async def check_connection(reason: str) -> bool:
    target_url = HEALTH_CHECK_URL if reason == "network_down" else LLM_STATUS_URL
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(target_url, timeout=aiohttp.ClientTimeout(total=TIMEOUT)) as resp:
                return resp.status == 200
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return False
```

> [!TIP]
> Using `1.1.1.1` (Cloudflare DNS) is recommended for `network_down` checks because it is highly available. For `api_exhausted`, querying the provider's specific health endpoint ensures you don't dump the queue into a still-broken API.

---

## Open-Source via Serverless Inference

For zero-cost extraction, open-source models can be queried through serverless inference providers:

| Provider | Models Available | Free Tier | Latency |
|----------|-----------------|-----------|---------|
| **Groq** | Llama 3.1, Mixtral | Generous daily token allowance | Very fast (custom LPU hardware) |
| **Together AI** | Llama 3.1, Qwen 2.5, Mixtral | Free tier for most models | Fast |

### Usage

These providers expose standard REST APIs compatible with the OpenAI client library format:

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-groq-key",
    base_url="https://api.groq.com/openai/v1"
)

response = client.chat.completions.create(
    model="llama-3.1-70b-versatile",
    messages=[{"role": "user", "content": prompt}],
    response_format={"type": "json_object"},
)
```

> [!WARNING]
> **Do not** build custom batch-processing pipelines on platforms like Kaggle for LLM inference. This introduces catastrophic execution latency (15–30 minutes per job) and violates standard production REST architecture. Always use serverless inference APIs for post-service extraction.

---

## Data Privacy

Sermon transcripts are sent to enterprise-grade cloud providers via API. Because church services are publicly broadcasted:

- Standard, cost-effective commercial APIs are used rather than expensive private hosting.
- Enterprise zero-data-retention policies are relied upon (Gemini, Claude, and most commercial APIs do not train on API-submitted data by default).
- No personally identifiable information (PII) beyond the sermon content is transmitted.

---

## Cross-References

- **Phase 3 lifecycle (service conclusion):** [architecture.md](architecture.md)
- **Transcript reconstruction from database:** [database_and_storage.md](database_and_storage.md)
- **Cloud LLM model specifications:** [ai_models.md](ai_models.md)
