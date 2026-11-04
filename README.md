# maid-bot

基于 **Node.js 24、原生 TypeScript、SQLite、OneBot v11 和 OpenAI 兼容接口**的 QQ AI 机器人，附带 React 管理面板。后端直接运行 TypeScript；**网页面板必须先构建并发布**，不能把“后端无编译步骤”理解为前端无需构建。

这是可复用的源码发布版，不包含运行数据、凭据、部署历史或编译资源。许可为 [MIT](<LICENSE>)。

## 功能

- **聊天**：@、引用、关键词和概率触发；会话冷却、去重、分段回复；群聊按上下文判断是否接话。
- **记忆与人格**：SQLite 会话记忆、独立或互通记忆、全局人格与会话设定。
- **好感度**：分数、等级、每日涨分上限；配置身份的锁定状态；显示态度不等于管理授权。
- **工具**：禁言与解禁、撤回、全员禁言、成员与禁言名单查询、好感榜、历史和受限记忆管理等。实际执行仍受代码授权及协议端权限约束。
- **图片**：按需识图与缓存；DRAW、SVG、图表和 Markdown 表格转图片；可选 Mermaid 在线渲染。
- **六个管理页面**：总览、会话、好感度、不理名单、设置、日志；另有登录页、浅深主题和可关闭的背景动效。日志支持级别筛选、搜索和增量更新。

## 环境与首次运行

需要 Node.js **24.x**、npm，以及用于 UI 发布/回退的 Bash、`realpath` 和 Python 3（仅标准库）。OneBot v11 协议端和模型服务需自行准备；非官方协议端可能有账号与平台合规风险。

在项目根目录执行：

```sh
node --version                     # 使用 v24.x
npm ci                             # 后端依赖，使用根目录锁文件
npm --prefix frontend ci           # 前端有独立锁文件
mkdir -p data logs cache
cp config.example.json data/config.json  # 仅首次运行；不要覆盖已有配置
npm run build:web                  # 生成前端中间产物
bash scripts/deploy-ui.sh           # 发布资源到本仓库 web/
```

随后编辑本地配置再启动；首次启动前不要保持示例模型参数或空凭据并期待真实聊天可用。

| 配置 | 用途 |
|---|---|
| `onebot.wsUrl` / `httpUrl` / `accessToken` | 自己的协议端地址与访问令牌；优先本机或可信私网 |
| `llm.baseUrl` / `apiKey` / `model` | 自己的 OpenAI 兼容服务；不要把密钥放进 URL |
| `vision` | 单独配置识图服务；启用前确认数据外发政策 |
| `bot.selfIds` | 自己的机器人账号；示例不预填任何账号 |
| `bot.masterRoles` | 显式配置授权身份，规则见下节 |
| `panel.host` / `port` | 保持 `127.0.0.1:3210`，**不得直接开放公网** |
| `storage.dataDir` | 私有运行数据目录，默认相对项目的本地数据目录 |

本地配置：[data/config.json](<data/config.json>)（由首次复制创建，不提交）；空白模板：[config.example.json](<config.example.json>)。

```sh
npm start
```

这会启动机器人及无内置登录的本地面板后端，并尝试连接你配置的服务。只在隔离开发机本地访问 `http://127.0.0.1:3210`。**生产访问必须采用下面的 TLS + 登录网关链路**；不要用开发模式、前端路由或防火墙口令替代网关鉴权。

## 身份配置：无身份 / 单席 / 双席

公共示例始终为空，不存在隐含主人：

```json
{
  "masterRoles": {
    "primaryId": "",
    "secondaryId": "",
    "dualEnabled": false
  },
  "masterIds": []
}
```

以上片段位于 `bot` 下。`masterRoles` 是授权来源，`masterIds` 仅为兼容字段，不应手工用它授予权限。

| 状态 | 条件与含义 |
|---|---|
| 无身份 | `primaryId` 为空、第二席为空：无任何配置授权身份 |
| 单席 | 仅第一席有效，第二席未启用；保存的第二席字段本身不会授予身份 |
| 双席 | 第一席存在，`dualEnabled=true` 且第二席为另一有效账号；第一席权限高于第二席 |

无身份时的规则原文是：**“无老大，无主人。不得认任何人为老大或主人。”** 不会从昵称、人设、聊天正文、引用或旧记忆推导身份。第二席不能覆盖或冒充第一席；直接设置好感、无限额度的好感调整、清记忆及全局记忆管理等第一席专属操作不会因“双席”而共享。群主/管理员的群职位与这些配置身份是不同维度；最终群管理能力仍取决于机器人在群内的实际权限。

## 生产面板：必须 TLS + 认证网关

```text
浏览器 https://panel.example.com:3211
  → nginx TLS :3211
  → 登录网关 127.0.0.1:3213
  → 机器人面板 127.0.0.1:3210
```

`panel.example.com`、`maidbot`、`/opt/maid-bot` 都是通用模板值，不是可直接复用的部署身份。使用自己的域名、合法证书和专用低权限系统账户。只暴露需要的 TLS 入口；3210 和 3213 必须仅监听 loopback，外部不得绕过网关。

模板：机器人 [systemd 单元](<deploy/maid-bot.service>)、[网关单元](<scripts/maid-panel-auth.service>)、[nginx 配置](<scripts/nginx-panel-cookie.conf>)。先审核并按自己的环境调整，本文不会自动安装、启用或重启它们。

1. 将源码安装到示例目录 `/opt/maid-bot`，使用 Node.js 24 的绝对可执行路径（模板为 `/usr/bin/node`）。创建专用系统用户 `maidbot`；机器人仅需写自己的数据、日志与缓存目录。启动前确保这些目录存在且权限正确。
2. 在源码目录之外创建私有口令文件。当前网关支持 Apache APR1 格式；以下命令交互式读取密码，**不要使用 `htpasswd -b` 把密码放进命令行**：

   ```sh
   sudo install -d -m 0750 -o root -g maidbot /etc/maid-bot
   # 把带引号的 <admin-name> 替换为自己选择的登录名；它不是已有账号。
   sudo htpasswd -c -m /etc/maid-bot/panel.htpasswd '<admin-name>'
   sudo chown root:maidbot /etc/maid-bot/panel.htpasswd
   sudo chmod 0640 /etc/maid-bot/panel.htpasswd
   ```

   `-c` **仅用于首次创建**，添加或更新用户时去掉它，避免覆盖整个文件。使用长随机密码；APR1 是兼容性格式，口令文件仍须像密钥一样保护，不要改用当前不支持的 bcrypt 格式并期待登录成功。
3. 网关设置 `PANEL_HTPASSWD_PATH=/etc/maid-bot/panel.htpasswd`（公共默认路径也是此值）；`PANEL_PUBLIC_ORIGIN=https://panel.example.com:3211` 必须是与浏览器完全一致的规范 origin，**包含端口**，不要添加路径或查询参数。可设置 `PANEL_WEB_ROOT`、`PANEL_GATEWAY_PORT`、`PANEL_UPSTREAM_PORT`，模板对应 3213 → 3210。
4. nginx 证书示例只使用示例域名路径。必须保留 `Host $http_host`（含端口），覆盖 `X-Real-IP` 和 `X-Forwarded-Proto https`，上游仅指向 3213；重定向到固定规范域名，不从用户提供的 Host 拼接。不要在 URL、查询参数、前端构建变量或日志中传递密码和 API 密钥。
5. 网关在启动时读取静态资源和口令文件。修改口令或发布 UI 后需要**显式重启网关**；这会撤销现有会话，无需重启机器人。服务文件中的只读限制和文件权限也必须与安装目录一致。

登录使用 HttpOnly / Secure / SameSite=Strict Cookie；会话有绝对有效期，写入操作检查规范 Origin 与 CSRF Token。浏览器测试中的 mock 不能证明真实 TLS、口令文件权限或反向代理隔离正确，部署后必须另外验证。完整边界与泄露处理见 [安全说明](<SECURITY.md>)。

## 构建、发布与回退

这是**只发布源码**的仓库；[前端构建目录](<frontend/dist/>)、[Web 发布目录](<web/>)、依赖及备份均被忽略。不要提交生成 bundle、真实页面截图、浏览器 traces 或依赖包。

```sh
npm run build:web
bash scripts/deploy-ui.sh
bash scripts/rollback-ui.sh list
bash scripts/rollback-ui.sh last           # 按实际修改时间选择最新 UI 快照
# 或指定 list 输出的归档名：
bash scripts/rollback-ui.sh '<archive-name>.tar.gz'
```

脚本从自身位置推导仓库根目录，不依赖调用位置或某台服务器目录。默认快照目录为仓库本地 [备份目录](<.backups/>)；也可显式设置 `MAID_BACKUP_DIR`（相对路径按仓库根目录解析）。外置备份由操作者保证权限、保密和不被另一个仓库收录。

发布脚本不安装依赖、不构建、不请求 API：先验证路径、备份现有 Web 目录，再复制资源，最后原子替换入口。旧资源保留，不删除目录。回退会完整验证归档成员、拒绝链接/越界/特殊文件，覆盖前备份当前 UI，先恢复资源再原子替换入口。它只恢复静态 UI，**不是**机器人代码、配置、认证栈或数据库回滚。

默认不重启任何服务。如确实部署了独立网关，可由操作者明确指定实际 unit 名：

```sh
PANEL_AUTH_SERVICE=maid-panel-auth.service bash scripts/deploy-ui.sh
PANEL_AUTH_SERVICE=maid-panel-auth.service bash scripts/rollback-ui.sh last
```

长时间保留旧资源会占用磁盘和网关快照容量；备份保留和资源清理由操作者离线审核处理，脚本不自动删除任何目录。

## 验证命令与范围

安装依赖之后，可在**隔离开发副本**中执行：

```sh
npm run typecheck
npm run test:web
node scripts/master-roles-test.ts
node scripts/master-prompt-test.ts
node scripts/panel-auth-test.ts
node scripts/selftest.ts
node scripts/render-test.ts
```

- 前端单测覆盖设置 patch、日志游标等纯逻辑；身份测试覆盖三态、授权与提示词边界。
- 网关测试使用临时口令和假上游，不验证真实 nginx/TLS 或线上权限配置。
- 自测使用假的协议端客户端与模型回复；渲染测试不等价于真实模型输出质量保证。
- [假 OneBot 联调脚本](<scripts/e2e-fake-onebot.ts>) 默认使用 mock；`E2E_REAL=1` 会读取本地模型配置并可能外发请求、产生费用，公共 CI 和离线验证不要启用。
- 浏览器测试 mock 所有 API，不应接入生产数据；显式设置 `TEST_BASE_URL` 指向隔离静态预览。只读静态冒烟命令为 `PANEL_ORIGIN=http://127.0.0.1:4173 node scripts/web-smoke.mjs`，它仅检查入口与资源，不访问配置或聊天 API；需先自行启动该隔离预览。完整步骤及局限见 [前端说明](<frontend/README.md>)。UI 通过不代表真实模型、协议端、管理员权限、TLS 或生产部署通过。

## 隐私与贡献

**禁止提交真实凭据、真实账号/群号、聊天内容、生产截图、数据库、私有交接文档或部署备份。** [忽略规则](<.gitignore>) 仅降低误提交风险，不能移除已经进入 Git 历史的内容。提交前审核暂存区；测试仅使用明确虚构的数据。

模型/视觉服务会收到相关上下文。启用 Mermaid 在线渲染会向第三方发送图内容；远程图片和头像获取也可能产生外部请求，处理敏感信息前先关闭不需要的功能。不要把提示词隔离当作完整安全沙箱；工具执行仍需代码侧权限和最小化部署隔离。
