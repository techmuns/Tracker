import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockText, bedrockJson, llmProvider, clearPin, MODEL_CHAIN } from '../src/bedrock.js';
import { summarizeMessages } from '../src/commits.js';

// Stand in for the network. Records what was sent so the tests can assert on
// the exact wire shape, which is the whole point of this transport.
function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const call = { url: String(url), headers: (init && init.headers) || {}, body };
    calls.push(call);
    return handler(call);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// The Bedrock transport reads .text() (error bodies aren't reliably JSON); the
// OpenAI path reads .json(). Provide both so either can be stubbed.
const resp = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
  json: async () => obj,
});

const textReply = (t) => resp(200, { content: [{ type: 'text', text: t }] });

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, provider: { type: 'string' } },
  required: ['ok', 'provider'],
  additionalProperties: false,
};

test('bedrock: endpoint, x-api-key auth, and no sampling params', async () => {
  await clearPin({});
  const f = stubFetch(() => textReply('hi'));
  try {
    const r = await bedrockText(
      { BEDROCK_API_KEY: 'k-123', BEDROCK_REGION: 'eu-west-1' },
      { system: 'S', user: 'U', maxTokens: 32 },
    );
    assert.equal(r.ok, true);
    assert.equal(r.value, 'hi');

    const c = f.calls[0];
    assert.equal(c.url, 'https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages');
    // The key is a bearer token, but it rides in x-api-key — not Authorization.
    assert.equal(c.headers['x-api-key'], 'k-123');
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.equal(c.headers.Authorization, undefined);
    assert.equal(c.headers.authorization, undefined);
    // Model IDs carry the anthropic. prefix on Bedrock.
    assert.equal(c.body.model, 'anthropic.claude-opus-5');
    assert.equal(c.body.system, 'S');
    // Sampling params are a 400 on Opus 5 / 4.8 / 4.7 — never send them.
    assert.equal(c.body.temperature, undefined);
    assert.equal(c.body.top_p, undefined);
    assert.equal(c.body.top_k, undefined);
  } finally {
    f.restore();
  }
});

test('bedrock: region defaults to us-east-1', async () => {
  await clearPin({});
  const f = stubFetch(() => textReply('hi'));
  try {
    await bedrockText({ BEDROCK_API_KEY: 'k' }, { user: 'U' });
    assert.match(f.calls[0].url, /^https:\/\/bedrock-mantle\.us-east-1\.api\.aws\//);
  } finally {
    f.restore();
  }
});

test('bedrock: 403 on Opus 5 walks the chain, then pins what answered', async () => {
  await clearPin({});
  const f = stubFetch(({ body }) =>
    body.model === 'anthropic.claude-opus-5'
      ? resp(403, { error: { message: 'not authorized for this model' } })
      : textReply('ok'));
  try {
    const r = await bedrockText({ BEDROCK_API_KEY: 'k' }, { user: 'U' });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'anthropic.claude-opus-4-8');
    assert.deepEqual(f.calls.map((c) => c.body.model), MODEL_CHAIN.slice(0, 2));

    // The pin means the next call skips the known-403 model entirely.
    const before = f.calls.length;
    const again = await bedrockText({ BEDROCK_API_KEY: 'k' }, { user: 'U' });
    assert.equal(again.model, 'anthropic.claude-opus-4-8');
    assert.equal(f.calls.length - before, 1);
  } finally {
    f.restore();
  }
});

test('bedrock: BEDROCK_MODEL pins one model and skips the chain', async () => {
  await clearPin({});
  const f = stubFetch(() => textReply('ok'));
  try {
    const r = await bedrockText(
      { BEDROCK_API_KEY: 'k', BEDROCK_MODEL: 'anthropic.claude-sonnet-5' },
      { user: 'U' },
    );
    assert.equal(r.model, 'anthropic.claude-sonnet-5');
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test('structured: uses output_config.format json_schema when accepted', async () => {
  await clearPin({});
  const f = stubFetch(() => textReply('{"ok":true,"provider":"bedrock"}'));
  try {
    const r = await bedrockJson({ BEDROCK_API_KEY: 'k' }, { user: 'U', schema: SCHEMA });
    assert.equal(r.ok, true);
    assert.equal(r.format, 'json_schema');
    assert.deepEqual(r.value, { ok: true, provider: 'bedrock' });
    assert.deepEqual(f.calls[0].body.output_config, { format: { type: 'json_schema', schema: SCHEMA } });
  } finally {
    f.restore();
  }
});

test('structured: "Extra inputs are not permitted" falls back to forced tool use', async () => {
  await clearPin({});
  const f = stubFetch(({ body }) =>
    body.output_config
      ? resp(400, { error: { message: 'output_config.format: Extra inputs are not permitted' } })
      : resp(200, { content: [{ type: 'tool_use', name: 'health', input: { ok: true, provider: 'bedrock' } }] }));
  try {
    const r = await bedrockJson(
      { BEDROCK_API_KEY: 'k' },
      { user: 'U', schema: SCHEMA, toolName: 'health' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.format, 'tool');
    assert.deepEqual(r.value, { ok: true, provider: 'bedrock' });

    // Retried on the SAME model, as forced single-tool use.
    const tool = f.calls[1];
    assert.equal(tool.body.model, f.calls[0].body.model);
    assert.equal(tool.body.output_config, undefined);
    assert.deepEqual(tool.body.tool_choice, { type: 'tool', name: 'health' });
    assert.equal(tool.body.tools.length, 1);
    assert.deepEqual(tool.body.tools[0].input_schema, SCHEMA);

    // And the working mode is pinned, so the rejected one isn't retried.
    const before = f.calls.length;
    await bedrockJson({ BEDROCK_API_KEY: 'k' }, { user: 'U', schema: SCHEMA, toolName: 'health' });
    assert.equal(f.calls.length - before, 1);
  } finally {
    f.restore();
  }
});

test('llmProvider: Bedrock is primary, LLM_PROVIDER overrides', () => {
  assert.equal(llmProvider({}), 'openai');
  assert.equal(llmProvider({ BEDROCK_API_KEY: 'k' }), 'bedrock');
  assert.equal(llmProvider({ BEDROCK_API_KEY: 'k', LLM_PROVIDER: 'openai' }), 'openai');
  assert.equal(llmProvider({ LLM_PROVIDER: 'claude' }), 'bedrock');
  assert.equal(llmProvider({ LLM_PROVIDER: 'bedrock' }), 'bedrock');
});

test('summarizeMessages: Bedrock primary, OpenAI on failure', async () => {
  await clearPin({});
  const f = stubFetch(({ url }) =>
    url.includes('openai.com')
      ? resp(200, { choices: [{ message: { content: 'shipped the login fix' } }] })
      : resp(500, { error: { message: 'upstream blew up' } }));
  try {
    const out = await summarizeMessages(
      { BEDROCK_API_KEY: 'k', OPENAI_API_KEY: 'o' },
      'techmuns/tracker', '2026-08-01', ['fix login'],
    );
    assert.equal(out, '• shipped the login fix');
    assert.ok(f.calls.some((c) => c.url.includes('bedrock-mantle')), 'tried Bedrock first');
    assert.ok(f.calls.some((c) => c.url.includes('openai.com')), 'fell back to OpenAI');
  } finally {
    f.restore();
  }
});

test('summarizeMessages: Bedrock answers, OpenAI never called', async () => {
  await clearPin({});
  const f = stubFetch(({ url }) =>
    url.includes('bedrock-mantle')
      ? textReply('• shipped the login fix')
      : resp(500, { error: { message: 'should not be reached' } }));
  try {
    const out = await summarizeMessages(
      { BEDROCK_API_KEY: 'k', OPENAI_API_KEY: 'o' },
      'techmuns/tracker', '2026-08-01', ['fix login'],
    );
    assert.equal(out, '• shipped the login fix');
    assert.ok(!f.calls.some((c) => c.url.includes('openai.com')));
  } finally {
    f.restore();
  }
});

test('summarizeMessages: LLM_PROVIDER=openai skips Bedrock entirely', async () => {
  await clearPin({});
  const f = stubFetch(() => resp(200, { choices: [{ message: { content: 'did stuff' } }] }));
  try {
    const out = await summarizeMessages(
      { BEDROCK_API_KEY: 'k', OPENAI_API_KEY: 'o', LLM_PROVIDER: 'openai' },
      'techmuns/tracker', '2026-08-01', ['fix login'],
    );
    assert.equal(out, '• did stuff');
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].url.includes('openai.com'));
  } finally {
    f.restore();
  }
});

test('summarizeMessages: no provider reachable still returns bullets', async () => {
  await clearPin({});
  const f = stubFetch(() => resp(500, { error: { message: 'nope' } }));
  try {
    const out = await summarizeMessages(
      { BEDROCK_API_KEY: 'k', OPENAI_API_KEY: 'o' },
      'techmuns/tracker', '2026-08-01', ['fix login', 'tidy up'],
    );
    assert.equal(out, '• fix login\n• tidy up');
  } finally {
    f.restore();
  }
});

test('errors never echo the key back to the caller', async () => {
  await clearPin({});
  const key = 'sk-bedrock-super-secret-value';
  const f = stubFetch(() => resp(401, { error: { message: `invalid key ${key}` } }));
  try {
    const r = await bedrockText({ BEDROCK_API_KEY: key }, { user: 'U' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'auth');
    // A bad key short-circuits the chain — no point trying other models.
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(r).includes(key), 'key must not appear anywhere in the result');
  } finally {
    f.restore();
  }
});
