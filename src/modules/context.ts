// 工具执行上下文：工具函数拿到它就够干活了。
import type { Config, NormalizedMessage, Session, ToolDef, ToolResult } from '../core/types.ts';
import type { DB } from '../core/db.ts';
import type { OneBotClient } from '../onebot/client.ts';

export interface ToolContext {
  config: Config;
  db: DB;
  client: OneBotClient;
  /** 当前这条触发消息 */
  msg: NormalizedMessage;
  session: Session;
  /** 回复行为提示：发送者是否为任一启用的老大；敏感权限必须用 masterRole(msg.senderId, config.bot) 实时判定。 */
  isMaster: boolean;
  /** 追加一条日志到面板 */
  note: (text: string) => void;
}

export interface ToolHandler {
  def: ToolDef;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}
