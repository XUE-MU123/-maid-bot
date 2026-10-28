// 模型接口：OpenAI 兼容（中转站/官方都行），支持 function calling、主备切换、超时、mock 兜底。
import { makeLogger } from '../core/logger.ts';
import { estimateTokens, sleep } from '../core/util.ts';
import type { Config, LLMConfig, LLMMessage, LLMReply, ToolCall, ToolDef } from '../core/types.ts';

const log = makeLogger('llm');

interface ChatResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string };
}

export interface ChatOptions {
  tools?: ToolDef[];
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

function endpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

function toolSchema(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function callOnce(
  cfg: LLMConfig,
  model: string,
  baseUrl: string,
  apiKey: string,
  messages: LLMMessage[],
  opts: ChatOptions,
  signalTimeoutMs: number,
): Promise<{ text: string; toolCalls: ToolCall[]; usage: { promptTokens: number; completionTokens: number }; model: string }> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => (m.name ? { role: m.role, content: m.content, name: m.name } : { role: m.role, content: m.content })),
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: false,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = toolSchema(opts.tools);
    body.tool_choice = 'auto';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), signalTimeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetch(endpoint(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  let data: ChatResponse;
  try { data = JSON.parse(rawText) as ChatResponse; }
  catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${rawText.slice(0, 160)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`接口错误 HTTP ${res.status}：${data.error?.message ?? rawText.slice(0, 160)}`);
  }

  const choice = data.choices?.[0];
  const msg = choice?.message;
  const toolCalls: ToolCall[] = [];
  for (const tc of msg?.tool_calls ?? []) {
    const name = tc.function?.name ?? '';
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>; }
    catch { args = {}; }
    toolCalls.push({ id: tc.id ?? `call_${toolCalls.length}`, name, args });
  }

  return {
    text: (msg?.content ?? '').trim(),
    toolCalls,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
    model: data.model ?? model,
  };
}

function mockReply(messages: LLMMessage[], tools: ToolDef[]): LLMReply {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const t = last.includes('[工具结果]')
    ? '【假回复模式】动作收到啦，等接上模型我就能正常汇报了。'
    : '【假回复模式】老大，我在呢。现在还没有接模型，回复的都是固定话术；到面板「设置」里填好接口和 Key，再关掉 mock，我就能真的说话了。';
  return {
    text: t,
    toolCalls: [],
    usage: { promptTokens: estimateTokens(JSON.stringify(messages)), completionTokens: estimateTokens(t) },
    model: 'mock',
    usedFallback: false,
  };
}

export async function chat(
  config: Config,
  messages: LLMMessage[],
  opts: ChatOptions = {},
): Promise<LLMReply> {
  const cfg = config.llm;
  if (cfg.mock || !cfg.apiKey) {
    log.debug('mock 模式回复（未配置 apiKey）');
    await sleep(120);
    return mockReply(messages, opts.tools ?? []);
  }

  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  try {
    const r = await callOnce(cfg, cfg.model, cfg.baseUrl, cfg.apiKey, messages, opts, timeoutMs);
    return { ...r, usedFallback: false };
  } catch (err) {
    const firstErr = String((err as Error)?.message ?? err);
    log.warn(`主接口失败：${firstErr}`);
    const fb = cfg.fallback;
    if (fb.baseUrl && fb.apiKey && fb.model) {
      log.info(`切换备用接口 ${fb.model}`);
      const r = await callOnce(cfg, fb.model, fb.baseUrl, fb.apiKey, messages, opts, timeoutMs);
      return { ...r, usedFallback: true };
    }
    throw new Error(firstErr);
  }
}

/**
 * 识图：把图片交给视觉模型，只换回一段客观描述。
 * 为什么要两段式——主模型（deepseek）不一定吃图，但人格和工具都在它那儿；
 * 让视觉模型只管「看到什么」，主模型只管「怎么回」，两边都不别扭。
 */
export interface ImageDesc {
  url: string;
  text: string;
  ok: boolean;
}

const VISION_PROMPT = '这张图片里有什么？用中文一句话说清楚（60 字以内），有文字就照抄出来。';
const VISION_PROMPT_2 = '请描述这张图片的内容，中文，一句话。';

/** 模型被安全策略挡回来时常常只吐一句短话，换个问法再试一次 */
function looksRefusal(t: string): boolean {
  return /无法|不能|抱歉|拒绝|cannot|unable|sorry/i.test(t) && t.length <= 30;
}

/** 清掉视觉模型爱加的 **加粗**、「描述：」前缀和换行，别污染主模型的上下文 */
function cleanVisionText(raw: string): string {
  return raw
    .replace(/\*\*/g, '')
    .replace(/^\s*(描述|图片描述|内容|回答)[:：]\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

async function askVision(
  baseUrl: string,
  apiKey: string,
  vcfg: Config['vision'],
  url: string,
  prompt: string,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), vcfg.timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(endpoint(baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: vcfg.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url } },
          ],
        }],
        max_tokens: 150,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const rawBody = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${rawBody.slice(0, 120)}`);
    const data = JSON.parse(rawBody) as ChatResponse;
    return (data.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function describeOne(vcfg: Config['vision'], cfg: LLMConfig, url: string): Promise<ImageDesc> {
  const baseUrl = (vcfg.baseUrl || cfg.baseUrl || '').replace(/\/+$/, '');
  const apiKey = vcfg.apiKey || cfg.apiKey || '';
  if (!baseUrl || !apiKey) return { url, text: '', ok: false };

  // 同一个问法被拒或被限流时，换个朴素问法再试，别一次失败就放弃
  for (const prompt of [VISION_PROMPT, VISION_PROMPT_2]) {
    try {
      const raw = await askVision(baseUrl, apiKey, vcfg, url, prompt);
      if (!raw) continue;
      const text = cleanVisionText(raw);
      if (!text || looksRefusal(text)) {
        log.warn(`识图被挡回来：${text.slice(0, 40)}`);
        continue;
      }
      const cut = vcfg.maxChars > 0 ? text.slice(0, vcfg.maxChars) : text;
      return { url, text: cut, ok: true };
    } catch (err) {
      log.warn(`识图失败：${String((err as Error)?.message ?? err)}`);
    }
  }
  return { url, text: '', ok: false };
}

/** 批量识图：一张失败不影响其他，最多处理前 4 张，避免一条消息把接口打爆 */
export async function describeImages(config: Config, urls: string[]): Promise<ImageDesc[]> {
  const vcfg = config.vision;
  const list = urls.filter((u) => /^https?:\/\//.test(u)).slice(0, 4);
  if (!list.length || !vcfg.enabled) return [];
  const out: ImageDesc[] = [];
  for (const url of list) out.push(await describeOne(vcfg, config.llm, url));
  return out;
}

/** 面板「测试连通性」用 */
export async function pingLLM(config: Config): Promise<{ ok: boolean; ms: number; model: string; reply?: string; error?: string }> {
  const t0 = Date.now();
  try {
    const r = await chat(config, [
      { role: 'system', content: '只回复两个字：在的' },
      { role: 'user', content: '测试一下' },
    ], { maxTokens: 64, tools: [] });
    return { ok: true, ms: Date.now() - t0, model: r.model, reply: r.text.slice(0, 40) };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, model: config.llm.model, error: String((err as Error)?.message ?? err) };
  }
}
