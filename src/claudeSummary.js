// ── LLM summary (Claude via AWS Bedrock) ─────────────────────────────────
// Parallel path to summarizeMessages() in commits.js, selected by setting
// the LLM_PROVIDER env var to "claude" (default stays "openai", so nothing
// changes unless someone opts in). Mirrors the exact same input/output
// contract as the OpenAI path — a '\n'-joined "• " bullet string, '' for no
// commits, same fallback behavior when no key is set or the call fails — so
// callers can't tell which provider produced the summary. Self-contained:
// deleting this file + the toggle in commits.js fully removes this path.
const BEDROCK_REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export async function summarizeMessagesClaude(env, repo, day, messages) {
  const lines = (messages || []).map((m) => (typeof m === 'string' ? m : m.message)).filter(Boolean);
  if (!lines.length) return '';
  const fallback = lines.slice(0, 3).map((l) => '• ' + l).join('\n').slice(0, 500);
  const key = env && env.temp_claude_token;
  if (!key) return fallback;
  try {
    const region = (env && env.BEDROCK_REGION) || BEDROCK_REGION;
    const modelId = (env && env.BEDROCK_MODEL_ID) || BEDROCK_MODEL_ID;
    const res = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        system: [{ text: 'You summarize a day of code commits for a NON-technical founder. Reply with 1 to 3 very short bullet points, each on its own line starting with "• ". Use plain language, no jargon, no file names or code terms. Fewer points is better. If little happened, use one bullet.' }],
        messages: [
          { role: 'user', content: [{ text: `Repo ${repo}, ${day}. Commit messages:\n` + lines.slice(0, 40).map((l) => '- ' + l).join('\n') }] },
        ],
        inferenceConfig: { temperature: 0.2, maxTokens: 180 },
      }),
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    const content = j && j.output && j.output.message && j.output.message.content;
    let txt = Array.isArray(content) ? content.map((c) => (c && c.text) || '').join('') : '';
    txt = (txt || '').trim();
    if (!txt) return fallback;
    // Normalize each line to a "• " bullet — identical to the OpenAI path.
    txt = txt.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/^([•\-*]\s*)?/, '• ')).join('\n');
    return txt.slice(0, 600);
  } catch {
    return fallback;
  }
}
