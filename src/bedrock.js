// ── Claude via Amazon Bedrock (Messages API transport) ───────────────────
// Transport only. This file knows how to *send* a request to Claude on
// Bedrock and how to read the answer back; it knows nothing about commits,
// prompts or business rules. Callers hand in the system/user text (and an
// optional JSON schema) and get a string or a parsed object back, so swapping
// providers never means touching a prompt.
//
// Wire format, per the "Claude in Amazon Bedrock" docs:
//   POST https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages
//   x-api-key: <BEDROCK_API_KEY>       ← the key rides here, NOT Authorization
//   anthropic-version: 2023-06-01
//   content-type: application/json
// Body is the ordinary Messages API shape: { model, max_tokens, system,
// messages }.
//
// No AWS SDK and no SigV4 signing. SigV4 is only needed for the AWS-credential
// path; an API key authenticates on its own — which is what we want, because
// the AWS SDK does not run well on Workers.
//
// The key is read from `env` (the Worker binding) on every call. Never from
// process.env, and never at module scope — bindings do not exist up there.

// Bedrock grants Opus 5 per-account, so a 403 on the first model is an
// expected outcome rather than an error. Walk down the chain until one
// answers, then remember which one did (see the pin, below).
export const MODEL_CHAIN = [
  'anthropic.claude-opus-5',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-sonnet-5',
];

const DEFAULT_REGION = 'us-east-1';
const ANTHROPIC_VERSION = '2023-06-01';
const PIN_KEY = 'llm_bedrock_pin';
const DEFAULT_TIMEOUT_MS = 20000;

// ── Configuration ────────────────────────────────────────────────────────

export function bedrockKey(env) {
  return (env && env.BEDROCK_API_KEY) || '';
}

export function hasBedrock(env) {
  return !!bedrockKey(env);
}

export function hasOpenAI(env) {
  return !!(env && env.OPENAI_API_KEY);
}

export function bedrockRegion(env) {
  const r = String((env && env.BEDROCK_REGION) || '').trim();
  return r || DEFAULT_REGION;
}

function endpoint(env) {
  return `https://bedrock-mantle.${bedrockRegion(env)}.api.aws/anthropic/v1/messages`;
}

// Which provider handles a call. LLM_PROVIDER wins whenever it is set, so
// flipping back to OpenAI later is a one-variable change and needs no deploy
// of new code. With it unset, Bedrock is primary whenever its key is present
// and OpenAI is the automatic fallback.
export function llmProvider(env) {
  const forced = String((env && env.LLM_PROVIDER) || '').trim().toLowerCase();
  if (forced === 'openai') return 'openai';
  if (forced === 'bedrock' || forced === 'claude' || forced === 'anthropic') return 'bedrock';
  return hasBedrock(env) ? 'bedrock' : 'openai';
}

// BEDROCK_MODEL pins one model and skips the chain entirely.
export function modelChain(env) {
  const one = String((env && env.BEDROCK_MODEL) || '').trim();
  return one ? [one] : MODEL_CHAIN.slice();
}

// Strip secrets out of anything we are about to hand back to a caller. Bedrock
// does not echo the key in its errors, but a health endpoint that returns raw
// upstream text should not be the thing standing between a bad day and a
// leaked credential.
export function redact(text, env) {
  let s = String(text == null ? '' : text);
  for (const secret of [bedrockKey(env), env && env.OPENAI_API_KEY]) {
    if (secret && String(secret).length >= 8) s = s.split(String(secret)).join('[redacted]');
  }
  return s;
}

// ── Pinning the model + structured-output format ─────────────────────────
// Two things are discovered at runtime: which model this account may call, and
// whether structured output goes through output_config or forced tool use.
// Both are stable, so cache them per-isolate and (best effort) in KV, or every
// cold start re-earns the Opus 5 403 before getting any work done.

let PIN = { model: null, format: null };

async function loadPin(env) {
  if (PIN.model) return PIN;
  try {
    const raw = env && env.MANUAL && (await env.MANUAL.get(PIN_KEY));
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.model === 'string') PIN = { model: p.model, format: p.format || null };
    }
  } catch {
    // The pin is an optimisation. Losing it costs a round trip, nothing more.
  }
  return PIN;
}

async function savePin(env, next) {
  const merged = { model: next.model || PIN.model, format: next.format || PIN.format };
  const changed = merged.model !== PIN.model || merged.format !== PIN.format;
  PIN = merged;
  if (!changed) return;
  try {
    if (env && env.MANUAL) await env.MANUAL.put(PIN_KEY, JSON.stringify({ ...merged, at: new Date().toISOString() }));
  } catch {
    // Ignore — the in-memory pin still holds for the rest of this isolate.
  }
}

// Exposed so a deploy that changes entitlements can clear the cached pin.
export async function clearPin(env) {
  PIN = { model: null, format: null };
  try {
    if (env && env.MANUAL) await env.MANUAL.delete(PIN_KEY);
  } catch {
    // Nothing to do — the in-memory pin is already cleared.
  }
}

// ── Request building ─────────────────────────────────────────────────────

// Note what is *absent*: temperature, top_p and top_k. Opus 5, 4.8 and 4.7
// reject sampling parameters with a 400, so the body is built here from a
// fixed set of fields rather than spread from caller input — that way no call
// site can reintroduce one.
function buildBody({ system, user, maxTokens, schema, toolName, toolDescription, format }) {
  const body = {
    max_tokens: maxTokens || 512,
    messages: [{ role: 'user', content: user }],
  };
  if (system) body.system = system;
  if (schema && format === 'json_schema') {
    body.output_config = { format: { type: 'json_schema', schema } };
  } else if (schema && format === 'tool') {
    // Forced tool use: one tool whose input_schema IS the schema, and a
    // tool_choice that leaves the model no other move.
    const name = toolName || 'respond';
    body.tools = [{
      name,
      description: toolDescription || 'Return the answer using this schema.',
      input_schema: schema,
    }];
    body.tool_choice = { type: 'tool', name };
  }
  return body;
}

async function send(env, model, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': bedrockKey(env),
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ ...body, model }),
      signal: ctl.signal,
    });
    // Read once, as text: error bodies are not reliably JSON.
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* leave data null, keep raw */ }
    return { ok: res.ok, status: res.status, data, raw };
  } finally {
    clearTimeout(timer);
  }
}

// ── Response reading ─────────────────────────────────────────────────────
// These calls are not streamed, so the whole body arrives at once. If anyone
// adds streaming later: parse the SSE with `res.body.getReader()` and buffer
// across chunks (frames split mid-line) — `for await (const chunk of res.body)`
// is Node-only and breaks on the Workers runtime. Tool payloads arrive as
// `input_json_delta`, not `text_delta`.

function extractText(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
}

function extractToolInput(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const t = blocks.find((b) => b && b.type === 'tool_use');
  return t ? t.input : null;
}

// json_schema mode returns the object as JSON text; tolerate a stray code fence.
function parseJsonText(txt) {
  const s = String(txt || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function errText(r, env) {
  const e = r && r.data && r.data.error;
  const m = (e && (e.message || e.type)) || (r && r.data && r.data.message) || (r && r.raw) || '';
  return redact(String(m), env).slice(0, 300);
}

// ── The call ─────────────────────────────────────────────────────────────
// Returns { ok:true, model, format, value, usage } or
//         { ok:false, reason, status, error, tried }.
// Never throws for an HTTP-level failure — callers decide whether to fall back.
export async function bedrockCall(env, opts) {
  if (!hasBedrock(env)) {
    return { ok: false, reason: 'no-key', status: 0, error: 'BEDROCK_API_KEY is not set.', tried: [] };
  }
  const schema = opts && opts.schema;
  await loadPin(env);

  const chain = modelChain(env);
  const models = PIN.model && chain.includes(PIN.model)
    ? [PIN.model, ...chain.filter((m) => m !== PIN.model)]
    : chain;

  // Structured calls try output_config first and fall back to forced tool use:
  // some deployments reject the former with
  //   "output_config.format: Extra inputs are not permitted".
  const allFormats = ['json_schema', 'tool'];
  const formats = !schema
    ? [null]
    : (PIN.format ? [PIN.format, ...allFormats.filter((f) => f !== PIN.format)] : allFormats);

  const tried = [];
  let last = { reason: 'error', status: 0, error: 'No models attempted.' };

  for (const model of models) {
    for (const format of formats) {
      let r;
      try {
        r = await send(env, model, buildBody({ ...opts, format }), opts && opts.timeoutMs);
      } catch (e) {
        const aborted = e && e.name === 'AbortError';
        tried.push({ model, format, status: 0, error: aborted ? 'timeout' : 'network' });
        last = { reason: aborted ? 'timeout' : 'network', status: 0, error: redact(String((e && e.message) || e), env) };
        break; // this model is not answering; try the next one
      }

      if (r.ok) {
        const value = schema
          ? (format === 'tool' ? extractToolInput(r.data) : parseJsonText(extractText(r.data)))
          : extractText(r.data);
        const empty = value === null || value === undefined || value === '';
        if (empty) {
          // 200 but nothing usable — most often a structured mode that was
          // accepted and then ignored. Try the other mode before giving up.
          tried.push({ model, format, status: 200, error: 'empty response' });
          last = { reason: 'empty', status: 200, error: 'Model returned no usable content.' };
          continue;
        }
        await savePin(env, { model, format: schema ? format : null });
        tried.push({ model, format, status: 200, ok: true });
        return {
          ok: true,
          provider: 'bedrock',
          model,
          format: format || 'text',
          value,
          usage: (r.data && r.data.usage) || null,
          tried,
        };
      }

      const error = errText(r, env);
      tried.push({ model, format, status: r.status, error });
      last = { reason: 'http', status: r.status, error, model };

      if (r.status === 401) {
        // Bad or revoked key — no other model will accept it.
        return { ok: false, reason: 'auth', status: 401, error, tried };
      }
      if (r.status === 400 && schema && format === 'json_schema') {
        continue; // this deployment rejects output_config — retry as tool use
      }
      if (r.status === 400) {
        return { ok: false, reason: 'bad-request', status: 400, error, tried };
      }
      if (r.status === 429) {
        // Throttling is account-wide; hammering the rest of the chain hurts.
        return { ok: false, reason: 'rate-limit', status: 429, error, tried };
      }
      // 403/404 (not entitled to this model) and 5xx: move to the next model.
      break;
    }
  }
  return { ok: false, reason: last.reason || 'error', status: last.status || 0, error: last.error, tried };
}

// Plain-text convenience wrapper.
export async function bedrockText(env, { system, user, maxTokens, timeoutMs }) {
  return bedrockCall(env, { system, user, maxTokens, timeoutMs });
}

// Structured-JSON convenience wrapper. `schema` must stay inside the subset
// json_schema mode accepts: no minimum/maximum, no minLength/maxLength, no
// recursive $ref, and additionalProperties:false on every object.
export async function bedrockJson(env, { system, user, schema, toolName, toolDescription, maxTokens, timeoutMs }) {
  return bedrockCall(env, { system, user, schema, toolName, toolDescription, maxTokens, timeoutMs });
}

// ── Health check ─────────────────────────────────────────────────────────
// One cheap structured call, so "is the key live?" is answerable in seconds
// without kicking off any real work. Reports which provider and model actually
// answered. Deliberately returns no part of any key.

const HEALTH_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Always true.' },
    provider: { type: 'string', description: 'Always the single word: bedrock' },
  },
  required: ['ok', 'provider'],
  additionalProperties: false,
};

export async function llmHealth(env) {
  const started = Date.now();
  const provider = llmProvider(env);
  const config = {
    llmProvider: provider,
    bedrockKeySet: hasBedrock(env),
    openaiKeySet: hasOpenAI(env),
    region: bedrockRegion(env),
    modelChain: modelChain(env),
  };

  if (provider === 'bedrock') {
    const r = await bedrockJson(env, {
      system: 'You are a health check. Reply only through the given schema.',
      user: 'Reply with ok = true and provider = "bedrock".',
      schema: HEALTH_SCHEMA,
      toolName: 'health',
      toolDescription: 'Report that the model is reachable.',
      maxTokens: 64,
      timeoutMs: 15000,
    });
    if (r.ok) {
      return {
        ok: true,
        answeredBy: 'bedrock',
        model: r.model,
        structuredVia: r.format, // json_schema | tool — whichever this deployment accepts
        ms: Date.now() - started,
        reply: r.value,
        usage: r.usage,
        attempts: r.tried,
        config,
      };
    }
    // Bedrock is down or the key is wrong — exercise the fallback so the answer
    // reflects what a real request would actually do.
    const fb = await openaiPing(env);
    return {
      ok: fb.ok,
      answeredBy: fb.ok ? 'openai' : null,
      model: fb.ok ? fb.model : null,
      structuredVia: null, // fallback leg is a plain text ping, not structured
      ms: Date.now() - started,
      bedrock: { ok: false, reason: r.reason, status: r.status, error: r.error, attempts: r.tried },
      openai: fb.ok ? { ok: true } : { ok: false, error: fb.error },
      config,
    };
  }

  const fb = await openaiPing(env);
  return {
    ok: fb.ok,
    answeredBy: fb.ok ? 'openai' : null,
    model: fb.ok ? fb.model : null,
    structuredVia: null,
    ms: Date.now() - started,
    openai: fb.ok ? { ok: true } : { ok: false, error: fb.error },
    config,
  };
}

// Cheap liveness ping for the OpenAI fallback. Plain text on purpose: the
// OpenAI path in commits.js is plain text too, so this checks the real thing.
async function openaiPing(env) {
  if (!hasOpenAI(env)) return { ok: false, error: 'OPENAI_API_KEY is not set.' };
  const model = (env && env.OPENAI_MODEL) || 'gpt-4o-mini';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      signal: ctl.signal,
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, model, error: redact(raw, env).slice(0, 300) };
    return { ok: true, model };
  } catch (e) {
    return { ok: false, model, error: redact(String((e && e.message) || e), env) };
  } finally {
    clearTimeout(timer);
  }
}
