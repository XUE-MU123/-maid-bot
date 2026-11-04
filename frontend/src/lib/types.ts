import type { Config, Session, FavorState, StoredMessage } from '../../../src/core/types';
export type { Config, StoredMessage };
export type Tab = 'overview' | 'sessions' | 'favors' | 'ignores' | 'settings' | 'logs';
export interface Overview {
  status: { onebotConnected: boolean; selfId: string; reconnects: number; lastError: string };
  stats: { messages: number; sessions: number };
  usage: { totalPrompt: number; totalCompletion: number };
  favorCount: number; uptimeSec: number; version: string;
  masterStatus?: {
    mode: 'none' | 'single' | 'dual';
    primary: { qq: string; nickname: string; avatar: string } | null;
    secondary: { qq: string; nickname: string; avatar: string } | null;
  };
}
export interface PanelSession extends Session { avatar: string; nickname: string }
export interface SessionsData { sessions: PanelSession[]; counts: Record<string, number> }
export interface PanelFavor extends FavorState { avatar: string; nickname: string }
export interface IgnoreItem { qq: string; nickname: string; avatar: string; sessionKey: string; sessionName: string; remainText: string; untilText: string; times: number }
export interface LogsData { lines: string[]; fileSize: number; nextOffset?: number; file: string | null }
export interface ConfigResult { config: Config; note?: string; notes?: string[]; changed?: string[] }
export interface ModelTest { ok: boolean; model?: string; ms: number; reply?: string; error?: string }
export type Notify = (message: string, kind?: 'success' | 'error') => void;
