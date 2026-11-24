# CS2 赛程中转

维护者在一个固定出口 IP 上运行现有 `EsportsService`, 统一读取 Liquipedia 的 CS2 赛程, 赛事级别, 官方直播登记和队标. 客户端只读取缓存接口. 数据保存在 `/data`, 容器重启后继续复用. 直播标题仍由客户端直接从 YouTube / Twitch 获取, VPS 不需要访问这两个平台.

## 接口

- `GET /v1/cs2/schedule`: schema 1 的赛程 JSON, 支持 `HEAD`, 强 ETag, `If-None-Match` 和 gzip, 缓存 15 秒. 压缩和未压缩响应各有自己的 ETag; 轮询没有读到新内容时不重建响应. 未取得赛程时返回 `503`, `Retry-After: 30` 和 `{"error":"not-ready"}`.
- `GET /v1/cs2/logos/<key>`: 已缓存的队标, 支持 `HEAD`. 不带版本时使用 `no-cache`; 带 `?v=<sha256>` 且哈希一致时缓存 7 天并标记 `immutable`. 非法 key, 不存在的文件或版本不一致返回 `404`.
- `GET /healthz`: `{ ok, fetchedAt, ageSeconds, matches, cooldownUntil }`, 禁止缓存. 未就绪或超过 30 分钟没有成功读取赛程时返回 `503`, 否则返回 `200`.

其他方法返回 `405`, 其他路径返回 `404`. 请求头上限 8 KiB, URL 上限 2 KiB, 最多 64 个请求头. 请求头超时 10 秒, 请求及空闲连接超时 15 秒, keep-alive 超时 5 秒. 不读取请求体. 查询参数不能触发上游请求, 没有刷新, 搜索或管理接口.

不兼容接口修改必须新增 `/v2`, 保持 `/v1` 不变. `/v1` 可以增加旧客户端忽略的字段.
YouTube 的 `channel` 可为普通频道名, `@handle`, 或限定的 `channel/`, `c/`, `user/` 加频道名; 不传完整直播地址.

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RELAY_HOST` | `127.0.0.1` | 监听地址. 容器内设置为 `0.0.0.0`, 主机只发布到回环地址 |
| `RELAY_PORT` | `5081` | 监听端口, 测试可设为 `0` |
| `RELAY_DATA_DIR` | `./data` | 持久缓存目录, 相对于启动目录 |
| `RELAY_OFFLINE` | 未设置 | 只要存在就完全禁止上游请求, 只读取已有磁盘数据 |
| `RELAY_TAG` | `latest` | Compose 使用的 `fy1sync-schedule-relay:<标签>` |
| `NODE_IMAGE` | `node:24-bookworm-slim` | Docker 构建参数, 不是运行时环境变量 |

Node 进程每 20 秒调用一次服务的普通读取, 服务自己的时效, 2 秒 HTTP 间隔, 30 秒 parse 间隔和 429 冷却决定是否请求上游. 每次读取后对所有仍在查找频道的赛事逐一设置焦点, 发起或重试频道查询; 已缓存或进行中的查询由服务跳过, 请求由共享的 2 秒请求槽排开. 随后将焦点轮转到一个活跃赛事, 无论是否有活跃赛事, 赛程均按 5 分钟节奏刷新. 活跃赛事指有进行中的比赛, 或有状态仍为 upcoming 且开赛时间在当前时间前 30 分钟到后 15 分钟内的比赛; 没有活跃赛事时清空焦点. 遇到 429 继续提供旧数据并退避, 不自动处理验证码或更换出口 IP.

## 本地构建和验证

在仓库根目录执行, 使用已经安装的依赖和 Node 24:

```powershell
npm run build:relay
$env:CARGO_NET_OFFLINE = 'true'
npx vitest run --project server relay
npm run typecheck
```

单文件输出为 `dist/relay/relay.cjs`, 无 Electron 和第三方运行时安装步骤. 本机冒烟测试必须离线:

```powershell
$env:RELAY_OFFLINE = '1'
$env:RELAY_DATA_DIR = '.runtime-cache/relay-smoke'
node dist/relay/relay.cjs
```

另一个终端访问 `http://127.0.0.1:5081/healthz`, 无缓存时应返回 `503`. 按 `Ctrl+C` 关闭自己启动的进程. 信号处理会停止监听, 清理轮询和服务任务后退出.

## 镜像构建

程序在开发机上用已安装的依赖构建, 镜像在 VPS 上构建, 所以开发机不需要 Docker. 在仓库根目录执行:

```powershell
npm run build:relay
```

得到 `dist/relay/relay.cjs`, 将它和 `relay/Dockerfile`, `relay/compose.yaml` 传到 VPS 的 `/opt/fy1sync-schedule-relay/`. 保持以下布局, 其中 Compose 文件放在顶层:

```text
/opt/fy1sync-schedule-relay/
  dist/relay/relay.cjs
  relay/Dockerfile
  compose.yaml
```

Dockerfile 的构建上下文是 `/opt/fy1sync-schedule-relay/`, 不能是其下的 `relay/`. 容器只含打包程序, 以基础镜像的 `node` 用户运行, 不运行 npm 安装依赖. `/data` 预建并归 `node` 所有, 新命名卷继承这个目录的权限. 根文件系统只读, 数据卷可写, 内存上限 384 MiB.

VPS 无法访问 Docker Hub. 先在能直接访问 Docker Hub 的机器上查询官方镜像:

```sh
docker buildx imagetools inspect docker.io/library/node:24-bookworm-slim
```

记录平台为 `linux/amd64` 的镜像摘要 `sha256:<摘要>`, 使用该平台的 manifest 摘要, 而不是多平台索引或其他架构的摘要. 摘要必须来自官方 Docker Hub 的查询结果, 不采信镜像站提供的标签或摘要. 再在 VPS 上通过可达镜像站按这个摘要拉取并打上本地标签, 具体命令见下一节. 按摘要拉取是内容寻址的, Docker 校验内容哈希, 镜像站无法替换该摘要对应的内容.

备选方式是由可访问 Docker Hub 的构建机导出完整的 linux/amd64 中转镜像, 经 `docker save` / `docker load` 传入 VPS.

## VPS 部署

先为 `schedule.fy1ng.cn` 添加指向 VPS 的 DNS 记录. 在 VPS 创建目录, 再按上一节的布局传入三个文件:

```sh
sudo mkdir -p /opt/fy1sync-schedule-relay/dist/relay /opt/fy1sync-schedule-relay/relay
```

将下面的镜像站主机名和摘要占位符替换为实际值. 摘要使用上一节从官方 Docker Hub 查到的 linux/amd64 摘要, 镜像站选择 VPS 可达且支持该仓库及摘要拉取的站点. 在 VPS 执行:

```sh
cd /opt/fy1sync-schedule-relay
NODE_MIRROR='<可达镜像站主机名>'
NODE_AMD64_DIGEST='sha256:<官方 linux/amd64 摘要>'
sudo docker pull "${NODE_MIRROR}/library/node@${NODE_AMD64_DIGEST}"
sudo docker tag "${NODE_MIRROR}/library/node@${NODE_AMD64_DIGEST}" node:24-bookworm-slim
sudo docker build -f relay/Dockerfile -t fy1sync-schedule-relay:0.5.1 .
printf 'RELAY_TAG=0.5.1\n' | sudo tee .env
sudo docker compose -p fy1sync-schedule-relay up -d --pull never
```

示例使用标签 `0.5.1`, 部署时按实际产物选择标签. 基础镜像已存在于本地, 构建时不加 `--pull`, Compose 启动使用 `--pull never`.

更新时先在本机运行 `npm run build:relay`, 将新的 `dist/relay/relay.cjs` 传到相同路径, 然后在 VPS 重新构建镜像, 换标签并重建容器. 以下以 `0.5.1-relay-r1` 为新标签示例:

```sh
cd /opt/fy1sync-schedule-relay
sudo docker build -f relay/Dockerfile -t fy1sync-schedule-relay:0.5.1-relay-r1 .
printf 'RELAY_TAG=0.5.1-relay-r1\n' | sudo tee .env
sudo docker compose -p fy1sync-schedule-relay up -d --pull never
```

Dockerfile 或 Compose 文件有变更时也传入对应的新文件. 固定 Compose 项目名可以保持命名卷身份. 保留命名卷, 不执行 `down -v`. 数据目录包含服务现有的赛程, 级别, 限流记录和队标, 不涉及桌面端账号数据.

向已有 Caddyfile 加入:

```caddyfile
schedule.fy1ng.cn {
    reverse_proxy 127.0.0.1:5081 {
        transport http {
            compression off
        }
    }
}
```

站点不写 `log` 指令时 Caddy 不产生访问日志. 反代传递客户端的压缩协商, 不自行请求 gzip 并解压, 避免改变强 ETag 所对应的响应. 按实际 Caddyfile 路径验证并重载:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 运行检查与日志

```sh
cd /opt/fy1sync-schedule-relay
sudo docker compose -p fy1sync-schedule-relay ps
sudo docker compose -p fy1sync-schedule-relay logs --tail=50 relay
curl -i http://127.0.0.1:5081/healthz
curl -I https://schedule.fy1ng.cn/v1/cs2/schedule
```

首次读取可能需要等待上游请求. 健康检查不是赛程刷新请求, 不访问上游. 冷却期间 `/healthz` 会显示到期时间, 数据超过 30 分钟后容器标记 unhealthy; Compose 不会因 unhealthy 自动重启容器, 外部监控应处理告警. 进程退出则由 `restart: unless-stopped` 重启.

标准输出记录启动, 实际赛程上游刷新的成功或失败结果, 线上格式过滤计数的变化和关闭. `started` 的 `autoSelectFamilyAttemptTimeoutMs` 记录中转进程实际生效的地址建连尝试时限 (毫秒). 不记录访问日志, 客户端 IP, 请求 URL, 响应正文或上游页面. 部署者应保持其他入口和基础设施的日志策略与此约定一致.

失败的 `upstream-result` 用 `errorKind` 区分请求超时 (`timeout`), 网络故障 (`network`, 看 `code`), 上游非 200 (`http`, 看 `status`), 上游 API 错误 (`api`, 有可用的错误码时看 `code`), 赛程格式变化 (`format`, 看 `selector`) 和其他异常 (`other`, 看 `name`; 请求被安全请求层拒绝或中断时另有 `detail`). `reason` 为固定标识, `cooldownUntil` 表示限流冷却到期时间. `parse-skipped` 仅在成功解析的赛程之间跳过的选择器集合变化时记录, 每行最多列出 8 个; `[]` 表示不再跳过比赛.

## 被 Liquipedia 限流时

中转收到 429 后自动进入冷却 (15 分钟起, 逐次加倍, 最长 6 小时), 期间继续提供上一次的赛程, `/healthz` 的 `cooldownUntil` 给出到期时间. 多数情况等冷却结束即可.

Liquipedia 的临时封禁可以由被封的 IP 自己完成人机验证来解除. 服务器上没有浏览器, 需要时在自己的电脑上经 SSH 让浏览器从 VPS 的出口访问:

```sh
ssh -D 1080 -N <VPS>
```

把浏览器的 SOCKS5 代理设为 `127.0.0.1:1080`, 打开 <https://liquipedia.net/counterstrike/Liquipedia:Matches> 完成验证, 然后断开这条连接. 中转不会自动处理验证. 不要为绕过限流更换出口 IP: 条款要求同一时间只用一个 IP, 反复触发临时封禁可能变成永久封禁.

## 数据来源

赛程数据来自 [Liquipedia](https://liquipedia.net/counterstrike/), 遵守 [API 使用条款](https://liquipedia.net/api-terms-of-use), 数据署名保持现有 `ATTRIBUTION`, 许可为 [CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). 队标和图标的权利归相应权利人, 以来源说明为准. 所有请求复用连接, 支持 gzip, 固定一个出口 IP 并尽量长时间复用缓存.

上游 User-Agent 为 `Fy1Sync-schedule-relay/<版本> (https://github.com/Fy1ng/Fy1Sync; sync@fy1ng.cn)`. 联系邮箱沿用应用的 `CONTACT_EMAIL` 常量.
