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

/** 被内容审核拦下时，网关会把这段说明当成正文吐回来 */
const BLOCKED_MARK = /PROHIBITED_CONTENT|blockReason(M?:)?\s*:|blocked by Gemini|blocked by Google|This output contains sensitive words|could not be generated|sensitive words that violate/i;
/** 连续被拦两次时给她说的话（固定，不再重试） */
export const BLOCKED_REPLY = '这个内容被拦截了，不是我不想回答，换个表达方式吧';

function isBlocked(text: string, finishReason?: string): boolean {
  const f = String(finishReason ?? '');
  if (/PROHIBITED_CONTENT/i.test(f)) return true;
  return BLOCKED_MARK.test(String(text ?? ''));
}

export interface ChatOptions {
  tools?: ToolDef[];
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 中转站偶尔会把模型的内部函数调用当正文吐出来，形如：
 * `emit_complete_response_<hash>(content="真正要说的话")`
 * 这种残留绝不能发进群：能取出 content 就用它，取不到就整段删掉。
 */
const EMIT_CALL = /emit_complete_response_[0-9a-f]{6,}\s*\(\s*content\s*=\s*"([\s\S]*?)"\s*\)\s*$/i;

export function cleanArtifacts(text: string): string {
  let t = String(text ?? '');

  if (/emit_complete_response_/i.test(t)) {
    const m = EMIT_CALL.exec(t.trim());
    if (m) {
      const outside = t.replace(EMIT_CALL, '').trim();
      t = outside || m[1];
    } else {
      t = t.replace(/emit_complete_response_[0-9a-f]{6,}\s*\(\s*content\s*=\s*"/gi, '')
        .replace(/emit_complete_response_[0-9a-f]{6,}\s*\(/gi, '');
    }
  }

  // 有些残留会把代码块整体转义成字面量 \n，还带一截 JSON 尾巴（"}) ）。
  // 只在这种"被转义的代码块"出现时才整理解包，别误伤正常文字。
  if (/```(draw|svg|mermaid)\\n/.test(t)) {
    t = t.replace(/\\n/g, '\n');
    t = t.replace(/["'\s]*[)}\]]+\s*$/, '').trimEnd();
    // 同一个代码块被吐了两遍：只留一份
    const blocks = t.match(/```[\s\S]*?```/g);
    if (blocks && blocks.length > 1) {
      for (const b of blocks.slice(1)) {
        t = t.replace(b, '');
      }
      t = t.replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  return t;
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

  const rawContent = (msg?.content ?? '').trim();
  const text = cleanArtifacts(rawContent);

  // 内容审核拦截：这段说明不是她的话，绝不能发进群
  if (isBlocked(text, choice?.finish_reason)) {
    throw new Error(`BLOCKED:${text.slice(0, 80) || 'PROHIBITED_CONTENT'}`);
  }

  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;

  // ---- 防「假响应」----
  // 2026-10-29 04:31 出过一次：中转站返回 content="ok"，用量是 prompt 1 / completion -1000000。
  // 一眼就是假的，但当时直接当正文发进群里了，老大连着收到六个 ok。
  // 判断标准都是「客观自相矛盾」，不是猜：
  //   1. 输出 token 是负数 —— 不可能
  //   2. 我们发过去几千 token，它说只处理了 1 个 —— 不可能
  // 命中就当这次调用失败，自动走备用模型，绝不把垃圾发出去。
  const sentTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
  if (completionTokens < 0) {
    throw new Error(`接口返回异常：输出 token 为 ${completionTokens}，判定为无效响应`);
  }
  if (sentTokens > 500 && promptTokens > 0 && promptTokens < sentTokens * 0.05) {
    throw new Error(`接口返回异常：只认了 ${promptTokens} 个输入 token（实际发了约 ${sentTokens} 个），判定为无效响应`);
  }

  return {
    text,
    toolCalls,
    usage: { promptTokens, completionTokens },
    model: data.model ?? model,
  };
}

function mockReply(messages: LLMMessage[], tools: ToolDef[]): LLMReply {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  let t = last.includes('[工具结果]')
    ? '【假回复模式】动作收到啦，等接上模型我就能正常汇报了。'
    : '【假回复模式】老大，我在呢。现在还没有接模型，回复的都是固定话术；到面板「设置」里填好接口和 Key，再关掉 mock，我就能真的说话了。';
  // 真模型每条回复都会带好感度标签，假回复也照规矩来，测试才能跑到这条路
  const speaker = /\| QQ:(\d{5,12})/.exec(last)?.[1];
  if (speaker && !last.includes('[工具结果]')) t += `[增加好感 ${speaker} 1]`;
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

  /**
   * 调一次；被内容审核拦下就原样再试一次，还拦就返回固定话术。
   * 其它错误照常往外抛，交给主备切换处理。
   */
  const callWithRetry = async (
    model: string, baseUrl: string, apiKey: string,
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage: { promptTokens: number; completionTokens: number }; model: string }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callOnce(cfg, model, baseUrl, apiKey, messages, opts, timeoutMs);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (!msg.startsWith('BLOCKED:')) throw err;
        if (attempt === 0) {
          log.warn('内容被审核拦截，同一请求重试一次');
          continue;
        }
        log.warn('连续两次被审核拦截，改用固定话术');
        return {
          text: BLOCKED_REPLY,
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0 },
          model: 'blocked',
        };
      }
    }
    // 理论上到不了这里
    return {
      text: BLOCKED_REPLY, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'blocked',
    };
  };

  try {
    const r = await callWithRetry(cfg.model, cfg.baseUrl, cfg.apiKey);
    return { ...r, usedFallback: false };
  } catch (err) {
    const firstErr = String((err as Error)?.message ?? err);
    log.warn(`主接口失败：${firstErr}`);
    const fb = cfg.fallback;
    if (fb.baseUrl && fb.apiKey && fb.model) {
      log.info(`切换备用接口 ${fb.model}`);
      const r = await callWithRetry(fb.model, fb.baseUrl, fb.apiKey);
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

/** 这几种话说明模型根本没收到图，不是真的在描述 */
function looksLikeImageSeen(text: string): boolean {
  if (/没有看到.{0,6}图片|没看到您上传|未上传图片|看不到图|请您上传一下图片|请将图片上传/i.test(text)) return false;
  return true;
}

/** 清掉视觉模型爱加的 **加粗**、「描述：」前缀和换行，别污染主模型的上下文 */
function cleanVisionText(raw: string): string {
  return raw
    .replace(/\*\*/g, '')
    .replace(/^\s*(描述|图片描述|内容|回答)[:：]\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

/** 把图片下载下来转成 data: URL，避免中转站不去取外链 */
async function fetchImageAsDataUrl(url: string, timeoutMs: number): Promise<string | null> {
  if (/^data:image\//i.test(url)) return url;    // 已经是 data URL 就直接用
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(8000, timeoutMs));
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    if (!/^image\//i.test(type)) return null;     // 拿回来的不是图片（多半是错误页）
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || buf.length > 8 * 1024 * 1024) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askVision(
  baseUrl: string,
  apiKey: string,
  vcfg: Config['vision'],
  url: string,
  prompt: string,
): Promise<string> {
  // 先把图下回来转成 base64 再发。
  // 2026-10-31 实测：直接把 QQ 的图片链接丢给中转站，对方根本不去取，
  // 模型会回「没有看到您上传的图片」，然后瞎编；同一段提示词还被对方缓存，于是每张图都是同一句。
  const img = await fetchImageAsDataUrl(url, vcfg.timeoutMs);
  if (!img) throw new Error('图片下载失败');

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
            { type: 'image_url', image_url: { url: img } },
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
      // 审核拦截的说明、以及"没看到图"的敷衍，都不算识别结果，绝不写缓存
      if (!text || looksRefusal(text) || !looksLikeImageSeen(text) || isBlocked(text)) {
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
