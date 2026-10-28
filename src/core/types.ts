// 全局类型契约：所有模块共享的数据结构都定义在这里。
// 改动这里等于改契约，三个模块（记忆、好感、面板）都依赖它，请先看这里再动手。

export type SessionType = 'group' | 'private';
export type MsgRole = 'user' | 'assistant' | 'system';

/** 模型接口（OpenAI 兼容中转站 / 官方均可） */
export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 主接口失败时的备用接口 */
  fallback: { baseUrl: string; apiKey: string; model: string };
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** 没有 Key 时用的本地假回复，方便先跑通链路 */
  mock: boolean;
}

export interface BotConfig {
  /** 机器人自己的 QQ 号，用于防自回复 */
  selfIds: string[];
  /** 老大（主人）QQ 号：好感度锁定、群管指令放行 */
  masterIds: string[];
  globalAutoReply: boolean;
  /** 长回复自动切段 */
  splitReply: boolean;
  maxSegmentChars: number;
  sendIntervalMs: number;
  /** 送进模型的最近对话条数 */
  historyLimit: number;
  /** 上下文 token 预算（粗估） */
  maxContextTokens: number;
  /** 同一会话两次回复的最小间隔 */
  cooldownMs: number;
  /** 防刷屏：相同内容在窗口内只回一次 */
  dedupeWindowMs: number;
  /** 是否让模型自动打好感分 */
  autoFavor: boolean;
  /** 每人每天最多涨多少分 */
  dailyGainCap: number;
  /** 没被 @ 时，出现这些词也当作在叫机器人 */
  triggerKeywords: string[];
}

export interface PersonaConfig {
  systemPrompt: string;
  groupProactive: string;
  privateProactive: string;
  /** 把好感度写进系统提示词 */
  favorHint: boolean;
}

export interface VisionConfig {
  enabled: boolean;
  model: string;
  /** 留空则复用 llm.baseUrl */
  baseUrl: string;
  /** 留空则复用 llm.apiKey */
  apiKey: string;
  timeoutMs: number;
  /** 每张图的描述最多保留多少字 */
  maxChars: number;
}

export interface RenderConfig {
  enabled: boolean;
  /** Markdown 表格转图片 */
  tables: boolean;
  /** ```svg 代码块 */
  svg: boolean;
  /** ```mermaid 代码块（走 mermaid.ink，内容会发给第三方） */
  mermaid: boolean;
  /** 单条消息最多出几张图 */
  maxImages: number;
  /** 单张渲染超时（毫秒） */
  timeoutMs: number;
  /** 表格配色预设 */
  tablePreset: string;
}

export interface Config {
  onebot: {
    wsUrl: string;
    httpUrl: string;
    accessToken: string;
    reconnectMs: number;
  };
  llm: LLMConfig;
  /** 识图：单独走一个视觉模型，只产出文字描述，再交给主模型回话 */
  vision: VisionConfig;
  /** 出图：把回复里的代码块/表格画成图片 */
  render: RenderConfig;
  bot: BotConfig;
  persona: PersonaConfig;
  defaults: { atProb: number; keywordProb: number; randomProb: number };
  panel: { host: string; port: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; keepDays: number };
  storage: { dataDir: string };
}

/** 会话（群或私聊） */
export interface Session {
  key: string;
  type: SessionType;
  targetId: string;
  name: string;
  enabled: boolean;
  /** 专属提示词，空字符串表示跟随全局 */
  prompt: string;
  memoryShared: boolean;
  atProb: number;
  keywordProb: number;
  /** 本会话专用触发关键词，逗号分隔；空字符串表示用全局配置 */
  keywords: string;
  randomProb: number;
  proactiveEnabled: boolean;
  proactiveMinMinutes: number;
  proactiveMaxMinutes: number;
  proactiveMaxRounds: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: number;
  sessionKey: string;
  role: MsgRole;
  content: string;
  senderId: string | null;
  senderName: string | null;
  msgId: string | null;
  createdAt: number;
}

export interface FavorState {
  qq: string;
  score: number;
  levelIndex: number;
  levelName: string;
  isMaster: boolean;
  dailyGain: number;
  updatedAt: number;
}

export interface FavorLevel {
  index: number;
  name: string;
  min: number;
  max: number;
}

export interface FavorChange {
  qq: string;
  before: number;
  after: number;
  delta: number;
  levelName: string;
  capped: boolean;
}

/** OneBot v11 消息段 */
export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

export interface SenderInfo {
  user_id?: number | string;
  nickname?: string;
  card?: string;
  role?: string;
}

export interface OneBotEvent {
  time?: number;
  self_id?: number | string;
  post_type?: string;
  message_type?: 'group' | 'private' | 'guild';
  sub_type?: string;
  message_id?: number | string;
  group_id?: number | string;
  user_id?: number | string;
  message?: string | Segment[];
  raw_message?: string;
  font?: number;
  sender?: SenderInfo;
  message_sender?: SenderInfo;
  notice_type?: string;
  request_type?: string;
  meta_event_type?: string;
  [k: string]: unknown;
}

export interface NormalizedMessage {
  sessionKey: string;
  type: SessionType;
  targetId: string;
  sessionName: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  messageId: string;
  text: string;
  images: string[];
  /** 与 images 一一对应的原始文件名，用来认出"同一张图" */
  imageFiles: string[];
  atSelf: boolean;
  atOthers: string[];
  replyTo: string | null;
  quotedText: string | null;
  raw: OneBotEvent;
  time: number;
}

/** 模型侧工具定义 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

export interface LLMMessage {
  role: MsgRole;
  content: string;
  name?: string;
}

export interface LLMReply {
  text: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
  usedFallback: boolean;
}

export interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
}
