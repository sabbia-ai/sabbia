import { hasUsableTokens } from "./tokens";

export type Intent = "smalltalk" | "capability" | "knowledge" | "other";
export interface PreviousAssistant { verdict?: string; text?: string }
function normalize(text: string): string {
  return text.trim().toLowerCase()
    .replace(/^[\p{P}\p{Z}\p{S}]+|[\p{P}\p{Z}\p{S}]+$/gu, "")
    .replace(/\s+/g, " ")
    .replace(/(.)\1+/gu, "$1");
}
const phrases = (text: string) => new Set(text.split("|").map(normalize));
const acknowledgement = phrases("ok|okay|k|yes|yeah|yep|no|nope|sure|cool|nice|great|fine|lol|hmm|umm|got it|understood|alright|right");
const gratitude = phrases("thanks|thx|thank you|ty|3q");
const greeting = phrases("hello|hi|hey|hi there|hello there|good morning|good afternoon|good evening|howdy");
const farewell = phrases("bye|goodbye|see you|see ya|later");
const capability = phrases("what can you do|who are you|what are you|help");
// Non-Latin scripts still supply a language cue for tokenless turns.
export const usesChinese = (text: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u.test(text);
function needsContextualAcknowledgement(previous?: PreviousAssistant): boolean {
  if (!previous) return false;
  if (previous.verdict === "refuse" || previous.verdict === "escalate") return true;
  return /(?:can[’']t help|opened escalation|flagged for review|does not cover|do not cover|not covered|available information does not answer|no relevant information|no passage)/i.test(previous.text ?? "");
}
function isBareAcknowledgement(text: string): boolean {
  const normalized = normalize(text);
  return !normalized || acknowledgement.has(normalized);
}
export function classifyIntent(text: string, previousAssistant?: PreviousAssistant): Intent {
  const normalized = normalize(text);
  if (isBareAcknowledgement(text) && needsContextualAcknowledgement(previousAssistant)) return "smalltalk";
  // Whole-message matches preserve real questions following an opener. The same
  // normalization accepts short openers with repeated characters or punctuation.
  if (acknowledgement.has(normalized) || gratitude.has(normalized) || greeting.has(normalized) || farewell.has(normalized)) return "smalltalk";
  if (capability.has(normalized)) return "capability";
  if (!hasUsableTokens(normalized)) return "smalltalk";
  return "knowledge";
}
export function localReply(intent: "smalltalk" | "capability", text: string, previousAssistant?: PreviousAssistant): string {
  const normalized = normalize(text);
  if (intent === "capability") return "I'm Sabbia AI. I can answer questions from your documents with citations and analyse images.";
  if (gratitude.has(normalized)) return "You're welcome!";
  if (farewell.has(normalized)) return "Goodbye!";
  if (greeting.has(normalized)) return "Hello! How can I help?";
  if (isBareAcknowledgement(text) && needsContextualAcknowledgement(previousAssistant)) {
    return "Sorry I didn’t help just now. Tell me what you’d like to ask, in your own words.";
  }
  return "Okay. Is there anything else I can help with?";
}
