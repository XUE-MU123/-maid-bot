// OneBot v11 WebSocket 客户端：连 SnowLuma，收发事件，带 echo 请求/响应与自动重连。
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { makeLogger } from '../core/logger.ts';
import type { Config, OneBotEvent, Segment } from '../core/types.ts';

const log = makeLogger('onebot');

export interface OneBotStatus {
  connected: boolean;
  selfId: string;
  connectedAt: number | null;
  lastError: string;
  reconnects: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class OneBotClient extends EventEmitter {
  private cfg: Config;
  private ws: WebSocket | null = null;
  private echo = 0;
  private pending = new Map<string, Pending>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private status: OneBotStatus = {
    connected: false, selfId: '', connectedAt: null, lastError: '', reconnects: 0,
  };

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
  }

  getStatus(): OneBotStatus { return { ...this.status }; }
  isConnected(): boolean { return this.status.connected; }

  connect(): void {
    if (this.closed) return;
    const { wsUrl, accessToken } = this.cfg.onebot;
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    log.info(`连接 ${wsUrl}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 10000 });
    } catch (err) {
      this.status.lastError = String(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.status.connected = true;
      this.status.connectedAt = Date.now();
      this.status.lastError = '';
      log.info('OneBot 已连接');
      this.emit('connected');
      // 握手后问一下自己是谁
      void this.call('get_login_info', {}).then((info) => {
        const data = info as { user_id?: number | string; nickname?: string } | null;
        if (data?.user_id) {
          this.status.selfId = String(data.user_id);
          const nick = String(data.nickname ?? '');
          log.info(`登录账号 ${this.status.selfId} ${nick}`);
          this.emit('login', this.status.selfId, nick);
        }
      }).catch(() => { /* 忽略 */ });
    });

    ws.on('message', (buf) => this.onMessage(buf.toString()));

    ws.on('close', (code, reason) => {
      const wasConnected = this.status.connected;
      this.status.connected = false;
      this.status.connectedAt = null;
      this.rejectAll(new Error('连接已关闭'));
      if (wasConnected) log.warn(`OneBot 断开 code=${code} ${reason?.toString() ?? ''}`);
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.status.lastError = String(err?.message ?? err);
      log.warn(`OneBot 连接错误：${this.status.lastError}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const wait = Math.max(1000, this.cfg.onebot.reconnectMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.status.reconnects++;
      this.connect();
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private onMessage(raw: string): void {
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw) as Record<string, unknown>; }
    catch { return; }

    // API 响应
    if (typeof data.echo === 'string' && this.pending.has(data.echo)) {
      const p = this.pending.get(data.echo);
      if (!p) return;
      this.pending.delete(data.echo);
      clearTimeout(p.timer);
      const retcode = Number(data.retcode ?? 0);
      if (retcode !== 0 && data.status === 'failed') {
        p.reject(new Error(`${String(data.wording ?? data.message ?? 'API 调用失败')} (retcode=${retcode})`));
      } else {
        p.resolve(data.data ?? null);
      }
      return;
    }
    if (typeof data.echo === 'number' && this.pending.has(String(data.echo))) {
      return; // 数字 echo 不处理
    }

    // 事件
    this.emit('event', data as OneBotEvent);
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`未连接到 OneBot（${action}）`));
        return;
      }
      const echo = `m${++this.echo}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 接口超时：${action}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new Error(`发送失败：${String(err)}`));
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }

  // ---------- 常用 API 封装 ----------

  async sendGroupMsg(groupId: string, message: string | Segment[]): Promise<string> {
    const r = await this.call<{ message_id?: number | string }>('send_group_msg', { group_id: Number(groupId), message });
    return String(r?.message_id ?? '');
  }

  async sendPrivateMsg(userId: string, message: string | Segment[]): Promise<string> {
    const r = await this.call<{ message_id?: number | string }>('send_private_msg', { user_id: Number(userId), message });
    return String(r?.message_id ?? '');
  }

  async sendGroupForward(groupId: string, messages: unknown[]): Promise<string> {
    const r = await this.call<{ message_id?: number | string }>('send_group_forward_msg', {
      group_id: Number(groupId),
      messages,
    });
    return String(r?.message_id ?? '');
  }

  async setGroupBan(groupId: string, userId: string, durationSec: number): Promise<void> {
    await this.call('set_group_ban', { group_id: Number(groupId), user_id: Number(userId), duration: durationSec });
  }

  async setGroupWholeBan(groupId: string, enable: boolean): Promise<void> {
    await this.call('set_group_whole_ban', { group_id: Number(groupId), enable });
  }

  async kickGroupMember(groupId: string, userId: string, rejectAddRequest = false): Promise<void> {
    await this.call('set_group_kick', {
      group_id: Number(groupId), user_id: Number(userId), reject_add_request: rejectAddRequest,
    });
  }

  async deleteMsg(messageId: string): Promise<void> {
    await this.call('delete_msg', { message_id: Number(messageId) });
  }

  async getGroupMemberList(groupId: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.call<Array<Record<string, unknown>>>('get_group_member_list', { group_id: Number(groupId) });
    return r ?? [];
  }

  /** 单个群成员资料：用来把 @123456 翻译成「@昵称」 */
  async getGroupMemberInfo(groupId: string, userId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.call<Record<string, unknown> | null>('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: false,
      });
    } catch {
      return null;
    }
  }

  async getGroupInfo(groupId: string): Promise<Record<string, unknown> | null> {
    return await this.call<Record<string, unknown> | null>('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupList(): Promise<Array<Record<string, unknown>>> {
    return (await this.call<Array<Record<string, unknown>>>('get_group_list', {})) ?? [];
  }

  async getFriendList(): Promise<Array<Record<string, unknown>>> {
    return (await this.call<Array<Record<string, unknown>>>('get_friend_list', {})) ?? [];
  }

  async getMsg(messageId: string): Promise<Record<string, unknown> | null> {
    return await this.call<Record<string, unknown> | null>('get_msg', { message_id: Number(messageId) });
  }

  /** 群禁言名单（OneBot 没有直接接口，用成员列表里禁言截止时间推算） */
  async getMutedList(groupId: string): Promise<Array<{ userId: string; name: string; until: number }>> {
    const members = await this.getGroupMemberList(groupId);
    const now = Math.floor(Date.now() / 1000);
    const out: Array<{ userId: string; name: string; until: number }> = [];
    for (const m of members) {
      const shut = Number((m as Record<string, unknown>).shut_up_timestamp ?? 0);
      if (shut > now) {
        out.push({
          userId: String(m.user_id ?? ''),
          name: String(m.card ?? m.nickname ?? ''),
          until: shut,
        });
      }
    }
    return out;
  }
}
