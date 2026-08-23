import { ModelConfig } from './modelConfig.js';

export class ModelError extends Error {}

export class ModelNotConfigured extends ModelError {}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelResponse {
  content: string;
  tool_calls: ToolCall[];
  reasoning_content: string;
  usage: Record<string, number> | null;
}

export interface ModelStreamEvent {
  content: string;
  response: ModelResponse | null;
}

const DSML_PREFIX = String.raw`<\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+`;
const DSML_CLOSE = String.raw`</\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+`;
const DSML_BLOCK_RE = new RegExp(`${DSML_PREFIX}tool_calls\\s*>(.*?)${DSML_CLOSE}tool_calls\\s*>`, 'gisu');
const DSML_INVOKE_RE = new RegExp(
  `${DSML_PREFIX}invoke\\s+name\\s*=\\s*["']([^"']+)["']`
  + `(?:\\s+arguments\\s*=\\s*["']([^"']*)["'])?\\s*>(.*?)${DSML_CLOSE}invoke\\s*>`,
  'gisu',
);
const DSML_FRAGMENT_RE = new RegExp(String.raw`</?\s*(?:[|｜]\s*)+DSML\b.*?>`, 'gisu');

function modelMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const clean = { ...message };
    delete clean.attachment;
    delete clean.display_content;
    return clean;
  });
}

export class OpenAICompatibleClient {
  readonly config: ModelConfig;

  constructor(config?: ModelConfig) {
    this.config = config ?? ModelConfig.fromEnv();
  }

  async complete(
    messages: Array<Record<string, unknown>>,
    tools?: Array<Record<string, unknown>>,
  ): Promise<ModelResponse> {
    if (!this.config.configured) {
      throw new ModelNotConfigured('模型尚未配置，请设置 MEIMEI_MODEL_API_KEY 和 MEIMEI_MODEL_NAME');
    }
    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: modelMessages(messages),
      temperature: this.config.temperature,
    };
    /* thinking 是非标准扩展字段，只有显式启用才发送，保证严格 OpenAI 兼容端点可接入。 */
    if (this.config.thinking === 'enabled') {
      payload['thinking'] = { type: 'enabled' };
    }
    if (tools && tools.length > 0) {
      payload['tools'] = tools;
      payload['tool_choice'] = 'auto';
    }
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.api_key}`,
      'Content-Type': 'application/json',
    };
    const url = `${this.config.base_url}/chat/completions`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.max(1, Math.round(this.config.timeout_seconds * 1000))),
        });
      } catch (error) {
        if (attempt === 0) {
          await sleep(350);
          continue;
        }
        throw new ModelError(`模型网络请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status >= 400) {
        const message = `模型接口返回 HTTP ${response.status}: ${await errorText(response)}`;
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          if (attempt === 0) {
            await sleep(350);
            continue;
          }
        }
        throw new ModelError(message);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        if (attempt === 0) {
          await sleep(150);
          continue;
        }
        throw new ModelError('模型接口返回了无效 JSON');
      }
      return parseResponse(data as Record<string, unknown>);
    }
    throw new ModelError('模型请求失败');
  }

  async *iter_complete(
    messages: Array<Record<string, unknown>>,
    tools?: Array<Record<string, unknown>>,
  ): AsyncGenerator<ModelStreamEvent> {
    if (!this.config.configured) {
      throw new ModelNotConfigured('模型尚未配置，请设置 MEIMEI_MODEL_API_KEY 和 MEIMEI_MODEL_NAME');
    }
    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: modelMessages(messages),
      temperature: this.config.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.config.thinking === 'enabled') {
      payload['thinking'] = { type: 'enabled' };
    }
    if (tools && tools.length > 0) {
      payload['tools'] = tools;
      payload['tool_choice'] = 'auto';
    }
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.api_key}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    const url = `${this.config.base_url}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, Math.round(this.config.timeout_seconds * 1000))),
      });
    } catch (error) {
      throw new ModelError(`模型网络请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 400) {
      const message = `模型接口返回 HTTP ${response.status}: ${await errorText(response)}`;
      throw new ModelError(message);
    }
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: Record<string, number> = {};
    let finished = false;
    const handleLine = (line: string): string | null => {
      if (!line.startsWith('data:')) return null;
      const raw = line.slice(5).trim();
      if (!raw) return null;
      if (raw === '[DONE]') {
        finished = true;
        return null;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (typeof data['usage'] === 'object' && data['usage'] !== null) {
        usage = filterUsage(data['usage']) ?? {};
      }
      const choices = (Array.isArray(data['choices']) ? data['choices'] : []) as Array<Record<string, unknown>>;
      const delta = (choices.length > 0 && typeof choices[0]?.['delta'] === 'object' && choices[0]['delta'] !== null
        ? choices[0]['delta'] : {}) as Record<string, unknown>;
      const content = String(delta['content'] ?? '');
      if (content) {
        contentParts.push(content);
        if (!looksLikeDsml(contentParts.join(''))) {
          return content;
        }
      }
      const reasoning = String(delta['reasoning_content'] ?? '');
      if (reasoning) {
        reasoningParts.push(reasoning);
      }
      const deltaCalls = (Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) as Array<Record<string, unknown>>;
      for (const item of deltaCalls) {
        const index = item['index'] === undefined ? toolCalls.size : Number(item['index']);
        let call = toolCalls.get(index);
        if (!call) {
          call = { id: '', name: '', arguments: '' };
          toolCalls.set(index, call);
        }
        call.id += String(item['id'] ?? '');
        const fn = (typeof item['function'] === 'object' && item['function'] !== null
          ? item['function'] : {}) as Record<string, unknown>;
        call.name += String(fn['name'] ?? '');
        call.arguments += String(fn['arguments'] ?? '');
      }
      return null;
    };
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const chunk = handleLine(line);
            if (chunk) {
              yield { content: chunk, response: null };
            }
            if (finished) break;
            newlineIndex = buffer.indexOf('\n');
          }
          if (finished) break;
        }
        if (buffer) {
          const chunk = handleLine(buffer);
          if (chunk) {
            yield { content: chunk, response: null };
          }
        }
      } catch (error) {
        if (error instanceof ModelError) throw error;
        throw new ModelError(`模型网络请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const [parsedContent, dsmlCalls] = parseDsmlToolCalls(contentParts.join(''));
    const orderedCalls: ToolCall[] = [];
    for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
      const call = toolCalls.get(index)!;
      orderedCalls.push({ id: call.id, name: call.name, arguments: call.arguments });
    }
    yield {
      content: '',
      response: {
        content: parsedContent,
        tool_calls: [...orderedCalls, ...dsmlCalls],
        reasoning_content: reasoningParts.join(''),
        usage: Object.keys(usage).length > 0 ? usage : null,
      },
    };
  }
}

function parseResponse(data: Record<string, unknown>): ModelResponse {
  let message: Record<string, unknown>;
  try {
    const choices = (Array.isArray(data['choices']) ? data['choices'] : []) as Array<Record<string, unknown>>;
    if (choices.length === 0 || typeof choices[0]?.['message'] !== 'object' || choices[0]['message'] === null) {
      throw new Error();
    }
    message = choices[0]['message'] as Record<string, unknown>;
  } catch {
    throw new ModelError('模型响应缺少 choices[0].message');
  }
  const calls: ToolCall[] = [];
  for (const item of (Array.isArray(message['tool_calls']) ? message['tool_calls'] : []) as Array<Record<string, unknown>>) {
    const fn = (typeof item['function'] === 'object' && item['function'] !== null
      ? item['function'] : {}) as Record<string, unknown>;
    calls.push({
      id: String(item['id'] ?? ''),
      name: String(fn['name'] ?? ''),
      arguments: String(fn['arguments'] ?? '{}'),
    });
  }
  const [content, dsmlCalls] = parseDsmlToolCalls(String(message['content'] ?? ''));
  return {
    content,
    tool_calls: [...calls, ...dsmlCalls],
    reasoning_content: String(message['reasoning_content'] ?? ''),
    usage: filterUsage(data['usage']),
  };
}

function filterUsage(usage: unknown): Record<string, number> | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const result: Record<string, number> = {};
  const raw = usage as Record<string, unknown>;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (key in raw) {
      const value = Number(raw[key]);
      result[key] = Number.isFinite(value) ? Math.trunc(value) : 0;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function errorText(response: Response): Promise<string> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return '';
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body.slice(0, 500);
  }
  const value = (data as Record<string, unknown>)?.['error'] ?? data;
  if (typeof value === 'string') return value.slice(0, 500);
  return JSON.stringify(value).slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeDsml(content: string): boolean {
  const head = String(content ?? '').trimStart().slice(0, 160);
  return head.includes('<') && head.toUpperCase().includes('DSML');
}

function parseDsmlToolCalls(content: string): [string, ToolCall[]] {
  const text = String(content ?? '');
  const calls: ToolCall[] = [];
  const blocks = [...text.matchAll(DSML_BLOCK_RE)];
  for (const block of blocks) {
    const body = block[1] ?? '';
    const invokes = [...body.matchAll(DSML_INVOKE_RE)];
    for (const invoke of invokes) {
      const argumentsText = invoke[2] || (invoke[3] ?? '').trim() || '{}';
      calls.push({
        id: `dsml-call-${calls.length + 1}`,
        name: (invoke[1] ?? '').trim(),
        arguments: argumentsText,
      });
    }
  }
  let rest = text;
  for (const block of [...blocks].reverse()) {
    const start = block.index ?? 0;
    rest = rest.slice(0, start) + rest.slice(start + block[0].length);
  }
  if (calls.length === 0) {
    const invokes = [...rest.matchAll(DSML_INVOKE_RE)];
    for (let index = 0; index < invokes.length; index++) {
      const invoke = invokes[index];
      const argumentsText = invoke[2] || (invoke[3] ?? '').trim() || '{}';
      calls.push({
        id: `dsml-call-${index + 1}`,
        name: (invoke[1] ?? '').trim(),
        arguments: argumentsText,
      });
    }
    rest = rest.replaceAll(DSML_INVOKE_RE, '');
  }
  rest = rest.replaceAll(DSML_FRAGMENT_RE, '').trim();
  return [rest, calls];
}
