import { threads, voiceSegments, voiceSessions } from "./db";
import { queueTurn, redactPII, runTurn } from "./agents";
import { HttpError } from "./http";

export function createVoiceSession(existingThread?: string) {
  const existing = existingThread ? threads.get(existingThread) : null;
  if (existingThread && (!existing || existing.surface !== "voice")) throw new HttpError(400, "threadId must identify an active voice thread");
  const thread = existing ?? threads.create("voice", "Voice conversation");
  const sessionId = voiceSessions.create(thread.id); return { sessionId, threadId: thread.id };
}
export async function voiceTurn(sessionId: string, speaker: "caller" | "assistant", transcript: string, interrupted = false) {
  const session = voiceSessions.get(sessionId); if (!session || session.ended_at) throw new HttpError(404, "Active voice session not found");
  return queueTurn(session.thread_id, async () => {
    const started = Date.now(), offset = started - Date.parse(session.started_at);
    if (interrupted) voiceSegments.interrupt(sessionId);
    voiceSegments.add(sessionId, speaker, redactPII(transcript), offset, offset + Math.max(1, Math.round(transcript.length / 14 * 1000)), interrupted);
    if (speaker === "assistant") return { reply: "", latency_ms: 0 };
    const result = await runTurn(session.thread_id, transcript), ended = Date.now() - Date.parse(session.started_at);
    voiceSegments.add(sessionId, "assistant", result.reply, ended, ended + Math.round(result.reply.length / 14 * 1000));
    return { reply: result.reply, latency_ms: Date.now() - started, verdict: result.verdict };
  });
}
