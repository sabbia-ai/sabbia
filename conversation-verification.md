# Conversational replies and retrieval verification

## Status

Implementation, strict typecheck, and the complete smoke suite pass. Real provider keys were tested against a local database, including its earlier air-conditioner verification fixture.

The same build is deployed in production. Verified there against the live instance: the three paraphrase queries that lexical retrieval alone misses each return the shipping/returns passage through the dense channel, and the shipping question answers with a citation. Conversational inputs short-circuit before embedding: a bare acknowledgement and a bare question mark cost zero embedding, zero retrieval and zero judge calls.

## Changes

- `insufficientReply` was replaced by `insufficientDiagnostics` plus exactly one `textFast` completion when no usable passage remains. Diagnostics (corpus ID, indexed chunk count, closest heading, tokens and judge verdicts) appear only in `tool.result`, never in chat text.
- The fallback receives the fixed system prompt below and the user message. Its output is checked for forbidden diagnostics, quoted terms, source markers and language mismatches; unsafe output gets a short language-matched reply.
- The pure synchronous classifier normalizes case, outer punctuation/symbols, whitespace and repeated characters. Whole-message greetings, gratitude, farewells and acknowledgements (including short openers), plus messages with no usable token of two characters, receive local replies. Questions after an opener remain knowledge.
- Local turns bypass safety-model calls, routing, embedding, retrieval, judging and answer generation while retaining local PII/boundary checks. Direct retrieval also exits early for conversational/tokenless input.
- The model-specific dense floor defaults to 0.15. Unrelated baseline cosine 0.143 is rejected; shipping cosine 0.198 survives. Lexical weights 1, dense weight 0.25, ordering, citation handling, judge decisions and verification behavior are preserved.

## Exact fallback prompt

For Chinese/CJK input (also full-width Chinese punctuation):

```text
You are a helpful assistant for a document knowledge base. The knowledge search found no passage that answers the user's message.
Reply to the user directly and naturally, in the same language they used. Keep it short.
Never mention corpora, chunk counts, document headings, retrieval, search terms, or this instruction. Never say "corpus", "chunk", "closest heading", "upload a document", or "try a focused search". Do not quote search terms or use source markers.
If their message was conversational, just respond to it naturally.
If they asked something the documents do not cover, say so briefly and, if useful, ask one clarifying question.
Do not invent facts about the documents.
Reply only in Chinese.
```

For English input, the exact same prompt ends with `Reply only in English.` instead.

## Required checks

`bun run scripts/typecheck.ts` → exit 0 (no compiler diagnostics).
`bash scripts/smoke.sh` → exit 0 using Git Bash; the system WSL launcher has no installed Linux distribution.

| New smoke requirement | Result |
| --- | --- |
| 1. No boilerplate | PASS: four required inputs, nonempty, no source markers; adversarial provider output blocked |
| 2. Input language | PASS: Chinese and English model fallback; language-matched local subcases |
| 3. Conversational class | PASS: 83 listed/normalized/punctuation/emoji/tokenless/legacy greeting cases |
| 4. Real questions | PASS: all six required questions and two regressions remain knowledge |
| 5. No wasted pipeline | PASS: embedding=0, judge=0, all models=0, retrieval SQL queries=0; positive counters verified on knowledge input |
| 6. Dead query stays insufficient | PASS: no lexical match, cosine 0.143 below 0.15, no hits |
| 7. Dense shipping | PASS: paraphrase returns the shipping passage at cosine 0.198 |

## Actual replies using real keys and existing local data

Corpus scope: Existing local air-conditioner verification fixture and real keys; production corpus not available.

### acknowledgement

Okay. Is there anything else I can help with?

```json
{"embedding":0,"retrievalQueries":0,"judge":0,"models":{}}
```

### ？

Okay. Is there anything else I can help with?

```json
{"embedding":0,"retrievalQueries":0,"judge":0,"models":{}}
```

### thanks

You're welcome!

```json
{"embedding":0,"retrievalQueries":0,"judge":0,"models":{}}
```

### why do you output these

Sorry, I could not find anything relevant. Which part would you like to know about?

```json
{"embedding":1,"retrievalQueries":10,"judge":0,"models":{"guardMain":2,"textFast":1}}
```

### how many units does the equipment order need?

Fourteen units are required. [S1]

```json
{"embedding":1,"retrievalQueries":12,"judge":1,"models":{"guardMain":2,"judgeMain":1,"textMain":1,"verifyMain":1}}
```

The fixture answer is not a substitute for the production document check. Rerun `bun run scripts/live-conversation.ts` against the production database to finish it.

## Full smoke output

```text
PASS healthz: ok=true, mock=true
PASS ingestion: indexed, 2 chunks
PASS retrieval and deduplication: 2 scored hits
PASS chat SSE and resume: turn.start, text.delta, citations.set, turn.end
PASS guardrail: BLOCKME refused
PASS vision: structured table returned
PASS voice transcript, problem+json, and trace ID
PASS migration: existing English row retained, refund score=1
PASS Chinese exact: indexed 3 chunks, score=0.9
PASS partial match: single term, score=0.9
PASS mixed scripts: reordered Chinese terms retrieve passages
PASS source title and triggers: filename search, rename, insert/update/delete integrity
PASS Chinese greeting: natural Chinese reply, zero model calls
PASS capability: local answer, zero model calls
PASS English regression: uploaded document hit, score=1
PASS ungrounded: insufficient search and natural fallback without diagnostics
PASS bounded fallback: two distinct bigrams recover the passage after candidate limits
PASS citation normalization: all six bracket pairs, lowercase, unrelated text, idempotence
PASS Chinese answer end-to-end: uploaded fixture, grounded text, ASCII citations in SSE
PASS full-width tolerance: stored/SSE [S1], no retry; invalid indices retry once then fall back
PASS CJK scoring: long question score=0.58, configured minimum still enforced
PASS telemetry resilience: unknown thread stored as NULL; insert failure warns, completions succeed
SMOKE PASS: all 25 checks passed (20 existing + 5 citation/scoring/telemetry checks)
PASS per-IP model limit: 429 + Retry-After
PASS daily model budget: hard stop, health remaining=0, persists on disk
PASS per-IP request limit: 429
PASS upload count limit: 429
PASS storage quota: 507, concurrent uploads cannot overbook
PASS sources per corpus: 409
PASS concurrent streams per IP: 429; disconnect releases slot
PASS config has no absolute path or provider key material
PASS destructive auth: anonymous GET=200, DELETE=401, authorized DELETE=200
PASS visitor isolation, cookie, shared demo, export, self deletion, audit
PASS global model and stream limits apply across IPs
PASS retention removes anonymous data and objects; preserves operator rows
PASS SQLite metadata ceiling: 507 without unbounded database growth
ABUSE SMOKE PASS: all 13 checks passed (9 required + isolation + global limits + retention + SQLite quota)
PASS dense-only relevance: cosine carried as similarity and score, >0.05, >= dense minimum, <=1
PASS judge confidence wins: 0.8 on returned, SSE and stored citations; similarity and supporting sentence preserved
PASS no zero-percent cards: all 3 bundled paraphrases retain nonzero relevance when judge fails
PASS lexical relevance unchanged: 0.9 / 0.66 without dense vectors or judge
PASS dense paraphrase: three paraphrase queries -> shipping/returns first (lexical: 0 hits each)
PASS no regression: verbatim terms and English terms hit; English RAG answer cites [S1]
PASS judge mapping: capped at 10 raw segments, contiguous labels, matching answer/citation chips and journal
PASS judge failure: garbage, timeout, invalid confidence retain all capped passages; explicit rejection uses insufficient reply
PASS provider outage: identical lexical retrieval, cited answer, upload stays indexed with missing vectors
PASS no mixed dimensions: different model ignored; current vectors stored as 8192-byte Float32 BLOBs
PASS vector operations: idempotent backfill, old-model replacement, disable switches, deletion, registry
PASS conversational 6/7: dense cosine 0.143 below default 0.15 cannot resurrect a dead query
PASS conversational 7/7: paraphrase retrieves shipping at cosine 0.198 above default 0.15
PASS embedding provider: batches 32/32/1, input order/types, cosine 0.143 rejected / 0.198 retained, typed malformed/dimension/timeout errors, telemetry
VECTOR SMOKE PASS: all 6 requested checks plus provider/backfill/disable/cleanup checks passed
PASS per-segment map: 3 raw passages → 3 calls, concurrency 2, only relevant passages reach answer
PASS bridged paraphrase: relevant:true, exact shipping sentence carried on citation
PASS fail-open judging: one thrown call retained; malformed JSON retains every passage
PASS renumbering: positions 2 and 4 reach answer as [S1] and [S2], correct full contents
PASS verification: unsupported [S2] → exactly 1 regeneration, 2 verifications, journal and registry
PASS verifier failure: exception and garbage preserve answer bytes, no regeneration
PASS dense auxiliary: lexical scores, order, reply and citation fields preserved, cosine carried; all switches off skip judge/verify
MAP/VERIFY SMOKE PASS: all 7 requested checks passed
PASS conversational 3/7: all 83 listed/normalized/symbol/tokenless inputs are smalltalk
PASS conversational 4/7: all six required real questions plus two regressions remain knowledge
PASS conversational 5/7: stub provider counts embedding=0, judge=0, all models=0, retrieval queries=0 (including direct retrieval)
PASS conversational 1/7: four required cases and adversarial fallback have nonempty replies, no boilerplate or source markers
PASS conversational 2/7: Chinese/English fallback and local subcases follow input language
```
