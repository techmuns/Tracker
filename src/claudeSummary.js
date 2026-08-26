// ── LLM summary (Claude via Amazon Bedrock) ──────────────────────────────
// The Claude half of summarizeMessages() in commits.js. Same prompt, same
// input, same "• "-bullet output as the OpenAI path — only the transport
// differs, so callers cannot tell which provider produced a summary.
//
// One difference from the OpenAI path, and it matters: this returns '' when it
// cannot produce a summary (no key, HTTP error, empty answer) instead of
// quietly returning the plain-text fallback bullets. commits.js reads that ''
// as "Bedrock could not answer" and moves on to OpenAI; if this returned
// fallback bullets they would look like success and the fallback would never
// fire. The caller still owns the final fallback, so the contract that
// summarizeMessages() always returns something is unchanged.
//
// Wire details (headers, endpoint, model chain, no-temperature rule) all live
// in ./bedrock.js — this file only supplies the prompt.
import { bedrockText } from './bedrock.js';

export async function summarizeMessagesClaude(env, repo, day, messages) {
  const lines = (messages || []).map((m) => (typeof m === 'string' ? m : m.message)).filter(Boolean);
  if (!lines.length) return '';

  const r = await bedrockText(env, {
    system: 'You summarize a day of code commits for a NON-technical founder. Reply with 1 to 3 very short bullet points, each on its own line starting with "• ". Use plain language, no jargon, no file names or code terms. Fewer points is better. If little happened, use one bullet.',
    user: `Repo ${repo}, ${day}. Commit messages:\n` + lines.slice(0, 40).map((l) => '- ' + l).join('\n'),
    maxTokens: 180,
  });
  if (!r.ok) return '';

  const txt = String(r.value || '').trim();
  if (!txt) return '';
  // Normalize each line to a "• " bullet — identical to the OpenAI path.
  return txt.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^([•\-*]\s*)?/, '• ')).join('\n')
    .slice(0, 600);
}
