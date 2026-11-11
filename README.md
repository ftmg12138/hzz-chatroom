# HZZ 聊天室 · chatroom.xyzhzz.com

纯 Cloudflare 实现：Worker（静态页面 + API）+ Durable Objects（SQLite 存储）。

## 结构
- `src/worker.js` — 入口：`/api/*` 接口、WebSocket 转发、静态资源（页面访问写入访客日志，附加 CSP 等安全头）
- `src/directory.js` — `Directory` DO（单实例）：账号、会话、房间登记与权限、访问日志、限流
- `src/room.js` — `ChatRoom` DO（每房间一个）：WebSocket Hibernation、消息历史、在线成员、管理操作
- `src/crypto.js` — PBKDF2-SHA256（每用户随机盐，100000 次迭代 = Workers 上限）
- `public/` — 前端（`index.html` 聊天室，`admin.html` 管理后台 `/admin`）
- `public/avatars/` — 预设虚拟形象（`manifest.json` + 图片），两个站点各放一份同源静态资源
- `test/e2e.mjs` 基础流程 · `test/features.mjs` 注册口令 + 语音 · `test/rooms.mjs` 命名空间/公开房间/申请/监控/解散/头像 · `test/ui-avatar.mjs` 浏览器 UI

## 安全
- 会话：随机 256 位令牌，库里只存 SHA-256；Cookie `hzz_sid`：HttpOnly、Secure、SameSite=Lax、Domain=xyzhzz.com（子站可共享登录）
- 非 GET 请求与 WebSocket 校验 Origin（`ALLOWED_ORIGINS`）
- 限流：登录 每 IP 20 次/10 分钟、每用户名 10 次/10 分钟；注册 每 IP 5 次/小时；进房 每 IP 30 次/10 分钟、每人每房间 8 次/10 分钟；消息 每人 15 条/10 秒
- 房间密码同样 PBKDF2 哈希；用户凭密码进入一次后记入 `room_access`，之后免密进入（大厅"移除"后需重新输入）

## 管理员
- 账号 `xyzhzzmaster`；初始密码来自 Worker secret `ADMIN_INIT_PASSWORD`（部署脚本从 `/workspace/.secrets/chatroom-admin-init` 写入，**不进仓库**）
- 首次登录强制改密（至少 10 位）；之后可在后台"改密码"
- 忘记密码 / 需要恢复初始密码：`scripts/reset-admin.sh`（更新 secret `ADMIN_SEED_VERSION`，约 1 分钟后生效）

## 功能
- **注册口令**：后台「注册设置」开关。开启后两个站点注册都必须填管理员设置的口令；口令只存 PBKDF2 哈希，不写日志；公开接口 `/api/reg-config` 只返回开/关。
  口令错误每 IP 每小时 10 次，超出返回 429；错误和限流都记录日志（带 IP）。后台显示「新注册用户」角标和列表。
  **本站没有邮件服务**，不会给管理员发邮件，新注册请在后台查看。
- **语音频道**（文字房间内）：纯音频 WebRTC mesh，上限 `VOICE_MAX`=8（`src/room.js`），信令走房间 WebSocket；成员列表、静音、说话指示；满员时提示。
  进出语音记日志（带 IP），封禁/移出/解散会把人踢出语音。NAT 穿透与视频站共用 `src/ice.js`（STUN；配置 TURN secret 后自动签发 TURN）。
- **房间号命名空间**：文字房间和视频房间各自独立，同一个号可以同时存在（库里按 kind + number 区分）。后台和日志都显示类型。
- **公开 / 私密房间**：私密 = 房间号 + 密码；公开 = 显示在大厅（名称、类型、在线人数、房主），别人点「申请加入」，房主在房间里实时收到通知并同意/拒绝（📨 角标 + 列表）。
  公开房间可以不设密码（只能申请），设了密码则密码也能直接进。后台「申请」页可代为处理，房间页可切换可见性。申请/同意/拒绝均记日志（带 IP）。
- **后台房间管理**：实时监控（每个房间在线成员 + IP、谁在语音/视频、消息数、最近活跃，5 秒自动刷新）、只读实时监看文字房间消息、把某人移出房间、「解散」（踢出所有人含语音/视频，删除房间和全部记录）。
- **头像**：账号字段 `avatar`：`p:avNN`（预设虚拟形象）或 `c:#rrggbb`（用户名首字 + 背景色，可用调色板或自定义取色）。注册后弹出选择（可跳过），之后点大厅左上角头像或「头像」按钮修改；
  消息、成员列表、大厅、语音、视频格子、后台都会显示。前端通过 `/api/avatars?names=` 批量查询（需登录）。预设图片清单读 `/avatars/manifest.json`，
  换图只需运行 `scripts/sync-avatars.sh`（从 `/workspace/chatroom-avatars/` 复制 webp + manifest 到两个站点）再部署，无需改代码。
- **界面**：柔和浅色主题（可切深色，记在 localStorage），系统中文字体，无外部 CDN/字体，严格 CSP（无内联脚本/样式）。

## 维护令牌（自动化测试用）
管理员改密后，线上测试用临时 Worker secret `MAINT_TOKEN`（≥32 位，请求头 `X-Maint-Token`，常量时间比较）代替管理员登录：
`openssl rand -hex 32 > /workspace/.secrets/chatroom-maint && npx wrangler secret put MAINT_TOKEN < /workspace/.secrets/chatroom-maint`，
测完 `npx wrangler secret delete MAINT_TOKEN` 并删除本地文件。secret 不存在时该请求头无效。

## 部署 / 测试 / 备份
```bash
scripts/deploy.sh                                    # 需要 CLOUDFLARE_API_TOKEN
BASE=https://chatroom.xyzhzz.com MAINT_TOKEN_FILE=/workspace/.secrets/chatroom-maint node test/e2e.mjs   # 也可用 features / rooms / ui-avatar
BASE=https://chatroom.xyzhzz.com ADMIN_PW_FILE=/workspace/.secrets/chatroom-admin-init node test/e2e.mjs   # 仅在管理员还是初始密码时
scripts/reset-admin.sh                               # e2e 会把管理员改回初始密码但清除"需改密"，跑完后执行它
scripts/push.sh "提交说明"                            # 需要 CHATROOM_GITHUB_TOKEN → ftmg12138/hzz-chatroom
```

## 给 videochatroom.xyzhzz.com 复用
- 账号与会话：同一 Cookie（Domain=xyzhzz.com）。视频站 Worker 在 wrangler.toml 绑定
  `[[durable_objects.bindings]] name="DIRECTORY" class_name="Directory" script_name="chatroom"`，
  然后 `env.DIRECTORY.get(env.DIRECTORY.idFromName("main")).getSession(token)` 校验登录。
- 房间：`createRoom(token, number, password, name, "video", ctx, visibility)`、`joinRoom(..., "video")`、`checkRoomAccess(token, number, "video")`，按 kind 区分。
- `ALLOWED_ORIGINS` 已包含 https://videochatroom.xyzhzz.com。

## 与 videochatroom 的联动（已上线）
- videochatroom Worker 绑定本 Worker 的 `Directory`；本 Worker 通过 `VROOMS`（script_name="videochatroom"）管理视频房间
- 后台：日志可按「文字 / 视频」筛选，房间列表显示类型；封禁/删除用户会同时把他踢出文字和视频房间

## 说明
- 区域开启了 Cloudflare Web Analytics 自动注入时，它的 beacon 脚本会被本站严格 CSP 拦截（不影响功能）；需要统计的话可在 CSP 里放行 static.cloudflareinsights.com，或在 Cloudflare 后台关闭自动注入。
- Cloudflare API 令牌目前没有 D1 权限，所以账号库用 SQLite Durable Object 代替 D1（功能等价，数据同样持久化）。
