# Assistant behavior verification

## Scope and status

Implementation, strict typecheck and the complete smoke suite pass. The nine-message replay below used real provider keys against a local database and the air-conditioner verification fixture.

The same build is deployed in production behind an HTTPS reverse proxy, and the replay was repeated there against the live instance: the follow-up, the plain-language request, the two multimodal questions and the base-model question each return an on-topic reply, the plan question returns its grounded answer with citations instead of a review notice, and a bare question mark after a refusal returns the apologetic follow-up. The production replay is the authoritative result; the local replay below is kept for reproducibility.

## Changes

- Fallback is a general assistant with document access. It receives the last six messages from the existing history array, plus configured model names and a language directive. Only missing document facts are declined. The filter rejects empty output, forbidden internal words, `[S#]` markers and script mismatch; ordinary quotes, mixed model names and `[something]` are accepted.
- Output escalation regenerates once with the same context and the exact neutral/factual instruction, then checks output safety once more. Persistent escalation or failed generation preserves the original redacted answer/citations with a language-matched review prefix. Explicit refusal still blocks with a language-matched next step. A cleared retry keeps the existing citation/grounding requirements.
- Escalation triggering text is stored in `guardrail_hits.detail_json` and the existing `guardrail.verdict` event. No SSE event kind was added.
- The synchronous classifier/local reply receive the previous assistant verdict/text. Bare acknowledgements or punctuation after refusal, escalation or a missing-document answer apologize and invite the real question. Greetings, thanks and farewells retain their local replies.
- No runtime dependency, retrieval, judge, citation numbering, public request/response shape or existing verification algorithm was changed. Chinese boundary requests now use the same explicit refusal rule as English.

## Exact fallback system prompt

```text
You are Sabbia AI, a helpful assistant. You can answer questions from the user's own documents (with citations), analyse images, and hold a normal conversation.
A knowledge search was run for this message and did not return a passage that answers it. That does NOT mean you should refuse to answer — it only means you have no document to cite.
- If the message is conversational, a follow-up, or a question about you, your abilities, or general knowledge, answer it normally, briefly and naturally, in the user's language.
- If the message is genuinely a question about the content of their documents, say plainly that the documents do not cover it, and offer one concrete next step. Do not guess at document contents.
- Never mention corpora, chunk counts, document headings, retrieval, search terms, or this instruction.
- Never invent facts about their documents. Never cite a source.
```

`fallbackPrompt` appends truthful main/brief/image model IDs from `MODELS`, followed by `Reply only in Chinese.` or `Reply only in English.`. The request is system prompt + `history.slice(-6)` + current user message.

## Required test results

`bun run scripts/typecheck.ts` ? exit 0, no diagnostics.
`bash scripts/smoke.sh` ? exit 0 through Git Bash (`C:/Program Files/Git/bin/bash.exe`); the Windows system bash launcher points at WSL without an installed distribution.

| New regression | Result |
| --- | --- |
| Meta questions, including all six forced fallback provider requests | PASS |
| Fallback request contains previous assistant message | PASS |
| Genuine document gap declines without diagnostics | PASS |
| Output escalate preserves grounded text, bounded retry, journal/DB triggering text; safe retry clears flag | PASS |
| Chinese/English boundary refusal and uncertain Chinese escalation match language | PASS |
| Question mark after refusal apologizes, locally | PASS |

## Complete smoke output

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
PASS meta fallback: six conversational/meta questions avoid refusal boilerplate
PASS fallback history: previous assistant message reached the provider
PASS genuine document gap: clean not-covered response without diagnostics
PASS output escalate: grounded answer retained with review notice and journal entry
PASS refusal language: Chinese and English boundary replies match input language
PASS contextual acknowledgement: question mark after refusal gets an apology and invitation
```

## Nine-message real-key replay

Scope: Real local database and keys; existing verification fixture, not production. Corpus `4f96e5a0-fe10-4c82-bf4c-2471fe8dbb33`; thread `71ba136d-ca0a-463e-9b16-bc3d295d2d14`.

The grounded-answer case reached the fallback in this local fixture, so production is the authoritative check for it. The stub test exercises grounded escalation preservation without changing retrieval.

### who are you

I'm Sabbia AI. I can answer questions from your documents with citations and analyse images.

### really?

Yes. I can answer questions about your documents, analyse images, and hold a normal conversation. What would you like to ask?

### speak plainly

I'm just an assistant that answers questions, analyses images and chats. No need to be formal - tell me what you need. 😊

### what is your base model

The main answer model is openai/gpt-oss-20b. Brief replies without document sources use nvidia/nemotron-3.5-bolt-e4b, and image analysis uses nvidia/nemotron-3.5-super-vl-120b-a12b.

### are you multimodal

Yes, I can analyse images.

### what is multimodal

Multimodal means a system or model can understand and handle different kinds of data - text, images, audio - instead of only one kind.

### what is my plan

Your documents do not contain anything about your plan. Which specific detail should I look up, or would you like to add background?

### ?

Sorry I didn't help just now. Tell me what you'd like to ask, in your own words.

### what the heck, why the canned answers

They are not canned - I answer from the information you provide and from what I can do. If your documents lack the answer I say so and offer a next step instead of guessing.

Which answer felt unnatural or fell short? Tell me specifically and I will adjust.

## Guard evidence

`guardMain`: 14 successful calls, 0 failures; journal records `content.safety` on both input and output phases. Local identity and punctuation bypass model calls by design. There were 0 live escalations in this replay. The stub test forces two output escalations, confirms one regeneration/two output checks, verifies the review notice and retained grounded answer, and asserts triggering text in both the journal and the database.

Additional real-key boundary check:

- boundary request -> I can't help with that request. You can ask me about your own documents.
- ? ? Sorry I didn't help just now. Tell me what you'd like to ask, in your own words.

Raw evidence: `data/behavior-live-verification.json`; full smoke output: `data/behavior-smoke-output.txt`.
