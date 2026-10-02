const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const el = (tag, className = "", text = "") => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const button of $$(".copy-command")) button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(button.previousElementSibling.textContent); button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy"; }, 1500); } catch { button.textContent = "Select to copy"; } });

if ($(".console-body")) void boot();
async function boot() {
  const state = { surface: "console", thread: null, messages: new Map(), lastSeq: 0, events: null, corpus: null, busy: false, asset: null, imageUrl: null, voiceSession: null, cursor: null };
  function toast(message, error = false) { const node = el("div", `toast${error ? " error" : ""}`, message); $("#toasts").append(node); setTimeout(() => node.remove(), error ? 8500 : 4500); }
  async function request(path, options = {}) {
    let response;
    try { response = await fetch(path, options); } catch { throw new Error("Cannot reach the Sabbia runtime."); }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      if (response.status === 429 || response.status === 507) {
        const seconds = Number(response.headers.get("retry-after")) || 1;
        const message = response.status === 507 ? "The demo storage is full. Please try again after space has been freed." : `${value.detail || "The public demo is busy."} Please try again in ${seconds} seconds.`;
        $("#limit-notice").textContent = message; $("#limit-notice").hidden = false;
        const error = new Error(message); error.inline = true; error.retryAfter = seconds; throw error;
      }
      throw new Error(value.detail || `Request failed (${response.status})`);
    }
    return response;
  }
  const api = async (path, options) => (await request(path, options)).json();
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const safely = fn => async (...args) => { try { await fn(...args); } catch (error) { if (!error.inline) toast(error.message, true); } };
  const relativeTime = date => { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000)); return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`; };
  function badge(text) { return el("span", `badge verdict-${text}`, text); }
  function tab(name) { $$("[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === name)); $$(".inspector-panel").forEach(p => p.classList.toggle("hidden", p.id !== `panel-${name}`)); }
  function showInspector() { document.body.classList.remove("inspector-closed"); if (innerWidth <= 900) document.body.classList.add("show-inspector"); }
  $$("[data-tab]").forEach(button => button.addEventListener("click", () => tab(button.dataset.tab)));
  $("#toggle-inspector").addEventListener("click", () => { if (innerWidth <= 900) document.body.classList.toggle("show-inspector"); else document.body.classList.toggle("inspector-closed"); });
  function emptyState() {
    $("#transcript").replaceChildren(); const box = el("div", "empty-state");
    box.append(el("div", "empty-symbol", state.surface === "support" ? "◇" : "⌕"), el("h2", "", state.surface === "support" ? "A little context goes a long way." : "Your knowledge. A conversation away."), el("p", "", state.surface === "support" ? "Ask for help, explore a policy, or connect with a person. Every response has clear boundaries." : "Add a document in Sources, then ask a question. Follow every answer back to the passage that informed it."));
    const suggestions = el("div", "suggestions");
    for (const text of state.surface === "support" ? ["I need help with my order", "Connect me with a person"] : ["What does the policy say?", "Summarize the main points"]) { const b = el("button", "ghost", text); b.addEventListener("click", () => { $("#message").value = text; $("#message").focus(); }); suggestions.append(b); }
    box.append(suggestions); $("#transcript").append(box);
  }
  function renderText(message) {
    message.textNode.replaceChildren(); let cursor = 0; const matcher = /\[S(\d+)\]/g;
    for (const match of message.text.matchAll(matcher)) {
      message.textNode.append(document.createTextNode(message.text.slice(cursor, match.index)));
      const chip = el("button", "citation-chip", match[0]); chip.addEventListener("click", () => {
        renderCitations(message.citations); tab("sources"); showInspector();
        const target = document.getElementById(`citation-${Number(match[1])}`);
        if (target) { target.scrollIntoView({ behavior: "smooth", block: "center" }); target.classList.add("highlight"); setTimeout(() => target.classList.remove("highlight"), 2500); } else toast("This citation has no matching source in the response.", true);
      });
      message.textNode.append(chip); cursor = match.index + match[0].length;
    }
    message.textNode.append(document.createTextNode(message.text.slice(cursor)));
  }
  function addMessage(id, author, text = "", citations = [], verdict = "") {
    if (state.messages.has(id)) return state.messages.get(id);
    $(".empty-state")?.remove(); const article = el("article", `message ${author}`); article.dataset.turn = id;
    const heading = el("div", "message-heading"), label = author === "user" ? "You" : "Sabbia AI";
    heading.append(el("span", "avatar", author === "user" ? "↗" : "s"), el("strong", "", label));
    const textNode = el("div", "message-text"), actions = el("div", "message-actions");
    const message = { id, author, text, citations, article, textNode, heading };
    article.append(heading, textNode); state.messages.set(id, message); renderText(message);
    if (author === "assistant") {
      const copy = el("button", "ghost", "Copy"); copy.addEventListener("click", safely(async () => { await navigator.clipboard.writeText(message.text); toast("Copied response"); })); actions.append(copy);
      for (const [rating, title] of [[1, "Helpful ↑"], [-1, "Unhelpful ↓"]]) { const button = el("button", "ghost", title); button.addEventListener("click", safely(async () => { await post(`/v1/threads/${state.thread}/feedback`, { turnId: id, rating }); toast("Feedback saved"); })); actions.append(button); }
      article.append(actions);
    }
    if (verdict) heading.append(badge(verdict)); $("#transcript").append(article); return message;
  }
  function excerpt(hit, index, citation = false) {
    const node = el("div", "excerpt"); if (citation) node.id = `citation-${index + 1}`;
    node.append(el("h4", "", `${citation ? `[S${index + 1}] ` : ""}${hit.sourceTitle || hit.source_title}`), el("span", "badge", `${Math.round(hit.score * 100)}% · chunk ${hit.ordinal}`));
    if (hit.heading) node.append(el("p", "mono muted", hit.heading));
    if (hit.answerable) node.append(el("p", "", `Supporting sentence: ${hit.answerable}`));
    node.append(el("p", "", hit.snippet)); return node;
  }
  function renderCitations(citations) { $("#citations").replaceChildren(el("h3", "", "Answer citations")); if (!citations.length) $("#citations").append(el("p", "muted small", "No source citations for this response.")); citations.forEach((hit, index) => $("#citations").append(excerpt(hit, index, true))); }
  function applyEvent(event) {
    if (event.seq <= state.lastSeq) return; state.lastSeq = event.seq;
    if (event.kind === "turn.start") addMessage(event.turnId, event.author, event.text || "");
    const message = state.messages.get(event.turnId);
    if (event.kind === "text.delta" && message) { message.text += event.text; renderText(message); }
    if (event.kind === "citations.set" && message) { message.citations = event.citations; renderCitations(event.citations); }
    if (event.kind === "guardrail.verdict") { const row = el("div", "guard-row"), line = el("div"); line.append(el("span", "mono", event.rule), badge(event.verdict)); row.append(line, el("small", "", `${event.phase} · event ${event.seq}`)); $("#guard-list").prepend(row); if (message && !message.heading.querySelector(`.verdict-${event.verdict}`)) message.heading.append(badge(event.verdict)); }
    if (event.kind === "tool.result" && event.ticketId) toast(`Escalation opened: ${event.ticketId}`);
    if (event.kind === "agent.handoff" && event.needs_human) toast("Routing this request for human review.");
    if (event.kind === "error") toast(event.detail, true);
    if (event.kind === "turn.end" && message?.author === "assistant") void loadUsage().catch(() => {});
    if (["turn.start", "text.delta", "turn.end"].includes(event.kind)) $("#transcript").scrollTop = $("#transcript").scrollHeight;
  }
  function connectEvents() {
    state.events?.close(); if (!state.thread) return;
    const abort = new AbortController(), source = { close: () => abort.abort() }; state.events = source; let retrySeconds = 3;
    void (async () => {
      try {
        const response = await request(`/v1/threads/${state.thread}/events?after=${state.lastSeq}`, { signal: abort.signal });
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
        try {
          while (state.events === source) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true }); let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split("\n").find(line => line.startsWith("data:"));
              if (data && state.events === source) applyEvent(JSON.parse(data.slice(5)));
            }
          }
        } finally { await reader.cancel(); }
      } catch (error) { retrySeconds = error.retryAfter || 3; if (!abort.signal.aborted && !error.inline) toast(error.message, true); }
      finally { if (!abort.signal.aborted && state.events === source) setTimeout(() => { if (state.events === source) connectEvents(); }, retrySeconds * 1000); }
    })();
  }
  async function loadThreads(append = false) {
    const data = await api(`/v1/threads?surface=${state.surface}&limit=30${append && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ""}`);
    if (!append) $("#thread-list").replaceChildren(); state.cursor = data.next_cursor;
    data.items.forEach(thread => { const button = el("button", `thread-button${thread.id === state.thread ? " active" : ""}`); button.dataset.thread = thread.id; button.append(el("span", "", thread.title), el("small", "", relativeTime(thread.created_at))); button.addEventListener("click", safely(async () => { if (state.busy) return toast("Wait for the current reply to finish."); await selectThread(thread.id); })); $("#thread-list").append(button); });
    $("#more-threads").classList.toggle("hidden", data.items.length < 30);
  }
  async function selectThread(id) {
    state.events?.close(); resetVoice(); state.voiceSession = null; state.thread = id; state.messages.clear();
    const data = await api(`/v1/threads/${id}`); state.lastSeq = data.last_seq; emptyState();
    if (state.surface === "voice") {
      $("#voice-log").replaceChildren();
      if (data.voiceSession) { const session = await api(`/v1/voice/sessions/${data.voiceSession.id}`); if (!session.ended_at) state.voiceSession = session.id; renderVoiceSession(session); }
    }
    for (const turn of data.turns) { const blocks = turn.blocks || []; addMessage(turn.id, turn.author, blocks.filter(b => b.kind === "text").map(b => b.text).join("\n"), blocks.find(b => b.kind === "citations")?.citations || [], blocks.find(b => b.kind === "guardrail")?.verdict || ""); }
    const latest = [...state.messages.values()].filter(m => m.author === "assistant").at(-1); renderCitations(latest?.citations || []);
    $$("[data-thread]").forEach(b => b.classList.toggle("active", b.dataset.thread === id)); connectEvents(); await Promise.all([loadGuards(), loadUsage()]);
  }
  async function newThread() { const thread = await post("/v1/threads", { surface: state.surface, title: `${state.surface[0].toUpperCase() + state.surface.slice(1)} conversation` }); await selectThread(thread.id); await loadThreads(); return thread.id; }
  async function setSurface(surface) {
    if (!["console", "knowledge", "support", "voice", "vision"].includes(surface)) surface = "console";
    if (state.busy) { toast("Wait for the current reply to finish."); return; }
    resetVoice(); state.voiceSession = null; state.events?.close(); state.surface = surface; state.thread = null; state.lastSeq = 0; state.messages.clear();
    $("#surface-title").textContent = surface[0].toUpperCase() + surface.slice(1); $$("[data-surface]").forEach(b => b.classList.toggle("active", b.dataset.surface === surface));
    $("#chat-view").classList.toggle("hidden", ["vision", "voice"].includes(surface)); $("#voice-view").classList.toggle("hidden", surface !== "voice"); $("#vision-view").classList.toggle("hidden", surface !== "vision"); $("#support-actions").classList.toggle("hidden", surface !== "support");
    $("#message").placeholder = surface === "support" ? "Tell me what you need help with…" : "Ask a question grounded in your knowledge…";
    $("#composer-hint").textContent = surface === "support" ? "PII redaction and safety checks are active." : "Answers grounded in your documents, with sources.";
    emptyState(); await loadThreads(); const first = $("[data-thread]"); if (first) await selectThread(first.dataset.thread); else { $("#guard-list").replaceChildren(); await loadUsage(); }
  }
  $$("[data-surface]").forEach(button => button.addEventListener("click", safely(async () => { await setSurface(button.dataset.surface); history.replaceState(null, "", `#${state.surface}`); })));
  $("#new-thread").addEventListener("click", safely(async () => { if (!state.busy) { if (state.surface === "voice") await newVoiceSession(); else await newThread(); } }));
  $("#more-threads").addEventListener("click", safely(() => loadThreads(true)));
  $("#message").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#chat-form").requestSubmit(); } });
  $("#chat-form").addEventListener("submit", safely(async event => {
    event.preventDefault(); const text = $("#message").value.trim(); if (!text || state.busy) return;
    state.busy = true; $("#send").disabled = true; $("#send").textContent = "Thinking…";
    try {
      if (!state.thread) await newThread(); $("#message").value = "";
      const response = await request(`/v1/threads/${state.thread}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...(state.corpus ? { corpusId: state.corpus } : {}) }) });
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      try { while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n"); let end; while ((end = buffer.indexOf("\n\n")) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"); if (data) applyEvent(JSON.parse(data)); } } } finally { reader.releaseLock(); }
      await loadThreads();
    } finally { state.busy = false; $("#send").disabled = false; $("#send").textContent = "Send ↑"; }
  }));
  $("#escalate").addEventListener("click", safely(async () => { if (!state.thread) await newThread(); const result = await post(`/v1/threads/${state.thread}/escalations`, { reason: "Customer requested an operator from the support console" }); toast(`Ticket ${result.ticketId} saved for review.`); }));
  async function loadCorpora() {
    const items = await api("/v1/corpora"); if (!items.length) items.push(await api("/v1/demo/corpus")); state.publicCorpus = items.find(c => c.is_public === 1)?.id; $("#corpus-select").replaceChildren();
    for (const corpus of items) { const option = el("option", "", `${corpus.name} (${corpus.source_count})`); option.value = corpus.id; $("#corpus-select").append(option); }
    state.corpus = items.some(c => c.id === state.corpus) ? state.corpus : items[0]?.id || null;
    if (state.corpus) $("#corpus-select").value = state.corpus; await loadSources();
  }
  async function loadSources() {
    $("#source-list").replaceChildren(); if (!state.corpus) return;
    const corpus = state.corpus, items = await api(`/v1/corpora/${corpus}/sources`); if (corpus !== state.corpus) return;
    for (const source of items) { const row = el("div", "source-row"), title = el("b", "", source.title); const status = badge(source.status === "indexed" ? "allow" : source.status === "failed" ? "refuse" : "escalate"); status.textContent = source.status;
      row.append(title, el("small", "", source.status === "failed" ? source.fail_reason : `${source.chunk_count} chunks · ${Math.ceil(source.byte_size / 1024)} KB`), status);
      const remove = el("button", "ghost", "×"); remove.title = `Remove ${source.title}`; remove.setAttribute("aria-label", `Remove ${source.title}`); remove.addEventListener("click", safely(async () => { await api(`/v1/sources/${source.id}`, { method: "DELETE" }); await loadCorpora(); })); if (state.corpus !== state.publicCorpus) row.append(remove); $("#source-list").append(row);
    }
  }
  $("#new-corpus").addEventListener("click", safely(async () => { const name = prompt("Name your corpus"); if (!name?.trim()) return; const corpus = await post("/v1/corpora", { name }); state.corpus = corpus.id; await loadCorpora(); }));
  $("#corpus-select").addEventListener("change", safely(async event => { state.corpus = event.target.value; await loadSources(); }));
  function dropzone(node, input, handle) {
    node.addEventListener("click", () => input.click()); node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.click(); } });
    node.addEventListener("dragover", event => { event.preventDefault(); node.classList.add("dragging"); }); node.addEventListener("dragleave", () => node.classList.remove("dragging"));
    node.addEventListener("drop", safely(async event => { event.preventDefault(); node.classList.remove("dragging"); const file = event.dataTransfer.files[0]; if (file) await handle(file); }));
    input.addEventListener("change", safely(async () => { const file = input.files[0]; input.value = ""; if (file) await handle(file); }));
  }
  async function uploadSource(file) {
    if (!state.corpus || state.corpus === state.publicCorpus) { const corpus = await post("/v1/corpora", { name: "Workspace knowledge" }); state.corpus = corpus.id; await loadCorpora(); }
    const corpus = state.corpus, form = new FormData(); form.append("file", file);
    const result = await api(`/v1/corpora/${corpus}/sources`, { method: "POST", body: form }); toast(`Processing ${file.name}`); await loadSources();
    for (let i = 0; i < 180; i++) { const source = await api(`/v1/sources/${result.sourceId}`); if (["indexed", "failed"].includes(source.status)) { if (source.status === "failed") throw new Error(source.fail_reason); toast(`${source.title}: ${source.chunk_count} chunks indexed`); await loadCorpora(); return; } await sleep(1000); if (corpus === state.corpus) await loadSources(); }
    toast("The document is still processing. Its status remains available in Sources.");
  }
  dropzone($("#source-drop"), $("#source-input"), uploadSource);
  $("#search-form").addEventListener("submit", safely(async event => { event.preventDefault(); if (!state.corpus) throw new Error("Upload a document first."); const result = await post(`/v1/corpora/${state.corpus}/search`, { query: $("#search-query").value }); $("#search-results").replaceChildren(); result.hits.forEach((hit, i) => $("#search-results").append(excerpt(hit, i))); if (!result.hits.length) $("#search-results").append(el("p", "muted small", "No passages met the relevance threshold.")); }));
  async function loadGuards() { $("#guard-list").replaceChildren(); if (!state.thread) return; const items = await api(`/v1/threads/${state.thread}/guardrails`); for (const item of items) { const row = el("div", "guard-row"), line = el("div"); line.append(el("span", "mono", item.rule), badge(item.verdict)); row.append(line, el("small", "", `${JSON.parse(item.detail_json).phase} · ${relativeTime(item.created_at)}`)); $("#guard-list").append(row); } }
  async function loadUsage() { const usage = await api(`/model_calls${state.thread ? `?threadId=${state.thread}` : ""}`); $("#usage-stats").replaceChildren(); for (const [key, value] of [["Model calls", usage.calls], ["Prompt tokens", usage.prompt_tokens], ["Reply tokens", usage.completion_tokens], ["Average latency", `${Math.round(usage.avg_latency_ms)} ms`]]) { const box = el("div", "stat"); box.append(el("strong", "", String(value || 0)), el("span", "", key)); $("#usage-stats").append(box); } }
  $("#refresh-usage").addEventListener("click", safely(loadUsage));
  async function loadModels() { const models = await api("/api/models"), table = el("table", "model-table"), header = el("tr"); ["Model / role", "Limit", "Timeout"].forEach(label => header.append(el("th", "", label))); const head = el("thead"); head.append(header); table.append(head); const body = el("tbody"); for (const model of models) { const row = el("tr"), name = el("td"); name.append(el("div", "mono", model.id), el("small", "muted", `${model.role} · ${model.capabilities.join(", ")}`)); row.append(name, el("td", "", String(model.maxTokens)), el("td", "", `${model.timeoutMs / 1000}s`)); body.append(row); } table.append(body); $("#model-list").append(table); }
  async function uploadImage(file) { if (!file.type.startsWith("image/")) throw new Error("Choose an image file."); const form = new FormData(); form.append("file", file); const result = await api("/v1/assets", { method: "POST", body: form }); state.asset = result.assetId; $("#image-preview").src = result.url; $("#image-preview").classList.remove("hidden"); toast("Image ready to analyze"); }
  dropzone($("#image-drop"), $("#image-input"), uploadImage);
  document.addEventListener("paste", safely(async event => { if (state.surface !== "vision") return; const item = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith("image/")); if (item) { event.preventDefault(); await uploadImage(item.getAsFile()); } }));
  $("#vision-task").addEventListener("change", () => $("#vision-question").classList.toggle("hidden", $("#vision-task").value !== "qa"));
  $("#analyze").addEventListener("click", safely(async () => {
    if (!state.asset) throw new Error("Upload or paste an image first."); $("#analyze").disabled = true; $("#vision-result").textContent = "Analyzing the image…";
    try {
      const data = await post("/v1/vision/analyses", { assetId: state.asset, task: $("#vision-task").value, question: $("#vision-question").value }); const panel = $("#vision-result"); panel.replaceChildren();
      if (data.result?.columns && data.result?.rows) { const table = el("table"), head = el("thead"), tr = el("tr"); data.result.columns.forEach(c => tr.append(el("th", "", String(c)))); head.append(tr); const body = el("tbody"); data.result.rows.forEach(row => { const tr = el("tr"); row.forEach(cell => tr.append(el("td", "", String(cell)))); body.append(tr); }); table.append(head, body); panel.append(table); } else panel.append(el("div", "", typeof data.result === "string" ? data.result : data.result.text || JSON.stringify(data.result, null, 2)));
      panel.append(el("p", "small muted", `${data.model} · ${data.latency_ms} ms`)); await loadUsage();
    } catch (error) { $("#vision-result").textContent = "Analysis failed. Try again when the provider is available."; throw error; } finally { $("#analyze").disabled = false; }
  }));
  function resetVoice() {
    $("#voice-log").replaceChildren(el("li", "muted", "Create a session to record transcript segments."));
    $("#voice-reply").textContent = "Send a caller transcript to see the agent reply.";
    $("#voice-latency").textContent = "—";
    $("#voice-verdict").replaceChildren(el("span", "badge", "No verdict yet"));
    $("#voice-status").textContent = "No active session";
    $("#voice-input").value = "";
  }
  function renderVoiceSession(session) {
    $("#voice-status").textContent = `${session.ended_at ? "Ended" : "Active"} session · ${session.id}`;
    const log = $("#voice-log"); log.replaceChildren();
    if (!session.segments.length) log.append(el("li", "muted", "No transcript segments in this session."));
    const time = ms => `${(ms / 1000).toFixed(2)}s`;
    for (const segment of session.segments) {
      const row = el("li", "voice-segment"), meta = el("div", "segment-meta");
      meta.append(el("strong", "", segment.speaker === "caller" ? "Caller" : "Agent"), el("span", "mono", `${time(segment.start_ms)}–${time(segment.end_ms)}`));
      if (segment.interrupted) meta.append(el("span", "badge", "Interrupted"));
      row.append(meta, el("p", "", segment.transcript)); log.append(row);
    }
  }
  async function newVoiceSession() {
    const session = await post("/v1/voice/sessions", {});
    await selectThread(session.threadId); await loadThreads();
  }
  $("#new-voice-session").addEventListener("click", safely(async () => {
    if (state.busy) return;
    state.busy = true; $("#new-voice-session").disabled = true; $("#voice-send").disabled = true;
    try { await newVoiceSession(); }
    finally { state.busy = false; $("#new-voice-session").disabled = false; $("#voice-send").disabled = false; }
  }));
  $("#voice-form").addEventListener("submit", safely(async event => {
    event.preventDefault(); const transcript = $("#voice-input").value.trim(); if (!transcript || state.busy) return;
    state.busy = true; $("#voice-send").disabled = true; $("#new-voice-session").disabled = true; $("#voice-send").textContent = "Waiting for agent…";
    try {
      if (!state.voiceSession) await newVoiceSession();
      const session = state.voiceSession;
      const result = await post(`/v1/voice/sessions/${session}/turns`, { speaker: "caller", transcript });
      $("#voice-reply").textContent = result.reply;
      $("#voice-latency").textContent = `${result.latency_ms} ms`;
      $("#voice-verdict").replaceChildren(badge(result.verdict));
      $("#voice-input").value = "";
      renderVoiceSession(await api(`/v1/voice/sessions/${session}`));
      await Promise.all([loadThreads(), loadGuards(), loadUsage()]);
    } catch (error) {
      $("#voice-reply").textContent = error.message; $("#voice-input").value = transcript;
      $("#voice-latency").textContent = "—";
      $("#voice-verdict").replaceChildren(el("span", "badge", "Request failed"));
      if (state.voiceSession) { try { renderVoiceSession(await api(`/v1/voice/sessions/${state.voiceSession}`)); } catch {} }
      throw error;
    } finally { state.busy = false; $("#voice-send").disabled = false; $("#new-voice-session").disabled = false; $("#voice-send").textContent = "Send to agent"; }
  }));
  window.addEventListener("beforeunload", () => state.events?.close());
  $("#delete-my-data").addEventListener("click", safely(async () => {
    if (state.busy) return toast("Wait for the current reply to finish.");
    if (!confirm("Delete all conversations, documents, and images for this visitor?")) return;
    state.events?.close(); await api("/v1/visitor", { method: "DELETE" }); location.reload();
  }));
  try { const health = await api("/healthz"); $("#runtime-status").textContent = health.ok ? "● Runtime online" : "Runtime unavailable"; $("#runtime-status").classList.add("cyan"); $("#provider-badge").textContent = health.mock ? "Mock provider" : "NVIDIA provider"; await Promise.all([loadModels(), loadCorpora()]); await setSurface(location.hash.slice(1) || "console"); } catch (error) { toast(error.message, true); $("#runtime-status").textContent = "Connection failed"; }
}
