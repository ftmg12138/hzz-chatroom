# HZZ 聊天室 · chatroom.xyzhzz.com

纯 Cloudflare 实现：Worker（静态页面 + API）+ Durable Objects（SQLite 存储）。

## 结构
- `src/worker.js` — 入口：`/api/*` 接口、WebSocket 转发、静态资源（页面访问写入访客日志，附加 CSP 等安全头）
- `src/directory.js` — `Directory` DO（单实例）：账号、会话、房间登记与权限、访问日志、限流
- `src/room.js` — `ChatRoom` DO（每房间一个）：WebSocket Hibernation、消息历史、在线成员、管理操作
- `src/crypto.js` — PBKDF2-SHA256（每用户随机盐，100000 次迭代 = Workers 上限）
- `public/` — 前端（`index.html` 聊天室，`admin.html` 管理后台 `/admin`）
- `test/e2e.mjs` — 端到端测试

## 安全
- 会话：随机 256 位令牌，库里只存 SHA-256；Cookie `hzz_sid`：HttpOnly、Secure、SameSite=Lax、Domain=xyzhzz.com（子站可共享登录）
- 非 GET 请求与 WebSocket 校验 Origin（`ALLOWED_ORIGINS`）
- 限流：登录 每 IP 20 次/10 分钟、每用户名 10 次/10 分钟；注册 每 IP 5 次/小时；进房 每 IP 30 次/10 分钟、每人每房间 8 次/10 分钟；消息 每人 15 条/10 秒
- 房间密码同样 PBKDF2 哈希；用户凭密码进入一次后记入 `room_access`，之后免密进入（大厅"移除"后需重新输入）

## 管理员
- 账号 `xyzhzzmaster`；初始密码来自 Worker secret `ADMIN_INIT_PASSWORD`（部署脚本从 `/workspace/.secrets/chatroom-admin-init` 写入，**不进仓库**）
- 首次登录强制改密（至少 10 位）；之后可在后台"改密码"
- 忘记密码 / 需要恢复初始密码：`scripts/reset-admin.sh`（更新 secret `ADMIN_SEED_VERSION`，约 1 分钟后生效）

## 部署 / 测试 / 备份
```bash
scripts/deploy.sh                                    # 需要 CLOUDFLARE_API_TOKEN
BASE=https://chatroom.xyzhzz.com ADMIN_PW_FILE=/workspace/.secrets/chatroom-admin-init node test/e2e.mjs
scripts/reset-admin.sh                               # e2e 会把管理员改回初始密码但清除"需改密"，跑完后执行它
scripts/push.sh "提交说明"                            # 需要 CHATROOM_GITHUB_TOKEN → ftmg12138/hzz-chatroom
```

## 给 videochatroom.xyzhzz.com 复用
- 账号与会话：同一 Cookie（Domain=xyzhzz.com）。视频站 Worker 在 wrangler.toml 绑定
  `[[durable_objects.bindings]] name="DIRECTORY" class_name="Directory" script_name="chatroom"`，
  然后 `env.DIRECTORY.get(env.DIRECTORY.idFromName("main")).getSession(token)` 校验登录。
- 房间：`createRoom(token, number, password, name, "video", ctx)`、`joinRoom(...)`、`checkRoomAccess(token, number)` 已支持 `kind` 字段。
- `ALLOWED_ORIGINS` 已包含 https://videochatroom.xyzhzz.com。

## 与 videochatroom 的联动（已上线）
- videochatroom Worker 绑定本 Worker 的 `Directory`；本 Worker 通过 `VROOMS`（script_name="videochatroom"）管理视频房间
- 后台：日志可按「文字 / 视频」筛选，房间列表显示类型；封禁/删除用户会同时把他踢出文字和视频房间

## 说明
Cloudflare API 令牌目前没有 D1 权限，所以账号库用 SQLite Durable Object 代替 D1（功能等价，数据同样持久化）。
