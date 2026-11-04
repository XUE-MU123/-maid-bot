# maid-bot React 控制台

Vite、React 19、TypeScript、Tailwind CSS 4。源码构建为静态页面，交由机器人后端或生产登录网关提供。六个业务页面为**总览、会话、好感度、不理名单、设置、日志**，登录页独立于业务页面。

## 结构

- [基础 UI 组件](<src/components/ui/index.tsx>)：集中封装对话框、图标等组件。
- [页面入口](<src/App.tsx>)：业务路由、主题及整体布局。
- [API 客户端](<src/lib/api.ts>)：同源请求与认证交互；密码不存入前端持久存储。
- [设置逻辑](<src/lib/settings.ts>)：构造配置 patch、保留未修改的配置与密钥。
- [日志逻辑](<src/lib/logs.ts>)：增量游标、筛选及缓存管理。
- [轮询 hook](<src/hooks/usePolling.ts>)：结束后轮询，取消过期请求。
- [主题样式](<src/styles/theme.css>)：浅深色语义变量与组件样式。
- [Playwright 配置](<playwright.config.ts>)：浏览器回归测试入口；具体静态站点配置以当前文件为准。

## 构建与静态发布

使用 Node.js **24.x**。在仓库根目录安装两个独立项目的依赖：

```sh
npm ci
npm --prefix frontend ci
npm run typecheck
npm run test:web
npm run build:web
bash scripts/deploy-ui.sh
```

[构建目录](<dist/>) 是中间产物；[Web 目录](<../web/>) 是本地静态发布目录。二者及所有依赖均不提交；从源码克隆后必须执行构建和发布，不能期待仓库自带 bundle。

[发布脚本](<../scripts/deploy-ui.sh>) 不安装、不构建、不连接 API，也不默认操作任何服务。脚本根据自身位置识别仓库根目录，验证实际目标、拒绝链接重定向，先备份，再发布资源，最后在同目录原子替换入口。已有哈希资源保留，以降低旧页面资源失效的风险。默认备份在仓库 [.backups 目录](<../.backups/>)，也可设置 `MAID_BACKUP_DIR`；外部目录需自行保证保密、不进入版本库。

```sh
bash scripts/rollback-ui.sh list
bash scripts/rollback-ui.sh last
bash scripts/rollback-ui.sh '<archive-name>.tar.gz'
```

[回退脚本](<../scripts/rollback-ui.sh>) 的 `last` 实际枚举最新修改的 UI 快照，不指向固定历史版本；指定归档会在写入前验证全部成员，拒绝链接、越界、重复路径和特殊文件。回退前备份当前 UI，先资源后入口，不删除目录，也不回退数据库、机器人代码或认证基础设施。两种脚本都默认不重启；仅在操作者显式指定时执行 `PANEL_AUTH_SERVICE=maid-panel-auth.service` 对应的网关重启。网关启动时快照静态资源，重启才会载入新的 UI，并撤销旧登录会话。

## 隔离开发与测试

```sh
# 仓库根目录：纯逻辑单测
npm run test:web

# 可选浏览器依赖（首次需要下载，离线环境应预先准备）
npm --prefix frontend exec -- playwright install chromium --only-shell

# 终端 A：仅在隔离开发副本中显式启动静态预览，不启动机器人
npm run build:web
npm --prefix frontend exec -- vite preview --host 127.0.0.1 --port 4173 --strictPort

# 终端 B：明确指定上面的隔离预览，所有 API 都由浏览器 fixture mock
TEST_BASE_URL=http://127.0.0.1:4173 npm --prefix frontend run test:browser
PANEL_ORIGIN=http://127.0.0.1:4173 node scripts/web-smoke.mjs
```

浏览器测试必须使用**隔离开发静态站点和虚构 fixture**；运行前检查 [Playwright 配置](<playwright.config.ts>) 中目标地址及服务设置，不要指向生产。它不会自动启动服务器；务必显式设置 `TEST_BASE_URL`，不要依赖本机默认端口。API 使用 mock 并应对未知请求 fail closed；测试页面或 fixture 中的账户、群与日志不是实际运行数据。[静态冒烟脚本](<../scripts/web-smoke.mjs>) 要求显式 `PANEL_ORIGIN`，只请求页面和资源，不读取配置或聊天 API。测试报告、截图、trace、录屏和浏览器缓存均是本地产物，禁止提交。

mock 测试覆盖草稿保持、确认交互、设置补丁、身份三态展示、日志筛选和认证 UI 等回归行为；**不证明**真实 OneBot 连接、模型质量、群管理权限、真实登录密码、TLS 或 nginx 转发正确。独立网关回归命令为：

```sh
node scripts/panel-auth-test.ts
```

此命令从仓库根目录运行，使用临时口令与假上游，不请求真实聊天和运行配置。不要把静态资源冒烟测试升级成未经授权读取生产配置的探针。

开发模式可显式使用 `npm --prefix frontend run dev`；[Vite 配置](<vite.config.ts>) 的 API 代理可能连接本机面板，因此只允许连接自己控制的测试后端。开发 HTTP 页面不是生产认证边界。

## 身份与交互约束

- `bot.masterRoles` 为唯一配置授权来源，示例的第一席、第二席为空且双席关闭。支持无身份、单席、双席；第二席权限低于第一席。
- 无身份规则原文：**“无老大，无主人。不得认任何人为老大或主人。”** 昵称、人格、旧聊天或兼容字段不能补出隐藏身份；群职位另行显示，不与配置身份混淆。
- 设置输入是受控草稿，不应被轮询覆盖；切换模型档案仅改接口相关字段，不清除其他草稿。
- 空白或打码密钥不当作新密钥提交；模型列表查询不把新密钥拼进 URL。
- 清记忆、删除或解除状态等破坏性操作要求确认；互通记忆的影响需明确提示。
- 背景动效可关闭，遵守减少动画偏好；深浅主题使用统一业务组件。

## 生产认证

生产必须采用 `https://panel.example.com:3211` → nginx → `127.0.0.1:3213` 网关 → `127.0.0.1:3210` 后端。域名是示例；两个内部端口不得公开。

网关 `PANEL_PUBLIC_ORIGIN` 必须与浏览器 HTTPS origin（含 `:3211`）完全一致。口令由 `PANEL_HTPASSWD_PATH` 指定，公共默认 `/etc/maid-bot/panel.htpasswd`；用户名和密码由部署者自行创建，绝不是仓库内置账号。模板与交互式口令创建步骤见 [项目 README](<../README.md>)。nginx 保留 `Host $http_host` 并覆盖真实来源和 HTTPS 转发头，不能直连 3210 来绕过认证。

Cookie 为 HttpOnly / Secure / SameSite=Strict；写请求要求 Origin 和 CSRF Token。密码、真实聊天、生产截图、运行配置、私有交接资料均不属于源码或测试 fixture。更多限制和历史泄露处置见 [安全说明](<../SECURITY.md>)。
