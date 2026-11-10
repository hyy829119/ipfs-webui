# IFShare WebUI API

Node 服务为 WebUI 提供用户管理、加密登录、服务端会话和文件操作日志。数据库可配置为 SQLite、MySQL、MariaDB 或 PostgreSQL，默认 SQLite。服务同时托管构建后的页面，并在检查登录状态后代理 IFShare RPC 和文件网关。账号数据库与 IFShare 节点的数据仓库相互独立。

## 本地启动

使用仓库 `.tool-versions` 指定的 Node 24.11.0，或 Node 22.13 及以上版本。默认使用 Node 内置 SQLite，不需要安装额外 npm 依赖。使用外部数据库时，先运行 `npm ci --prefix ipfs-webuiapi --registry=https://registry.npmjs.org --omit=dev` 安装锁定的驱动。Node 22 的 SQLite 仍可能输出实验性 API 提示，不影响启动。

在项目根目录安装前端依赖后运行：

```bash
cd /Users/huayao/opensource_project/ipfs-webui
npm run dev
```

该命令同时启动 WebUI 开发服务和 API。默认页面地址 `http://localhost:3000`，API 监听 `127.0.0.1:3001`。浏览器使用页面的同源路径 `/webui-api/v1/` 访问 API，开发服务器负责代理。开发环境不要配置公网 `WEBUI_API_PUBLIC_ORIGIN`。

也可以在两个终端分别运行：

```bash
npm run start:api
```

```bash
HOST=127.0.0.1 PORT=3000 BROWSER=none npm start
```

默认管理员：`admin`，初始密码：`password`。管理员创建的用户和重置密码后的用户也使用 `password`。首次启动才创建管理员，后续重启保留数据库里的用户和状态。旧版浏览器本地登录记录及 Apache `htpasswd` 用户不会自动导入。

### 安装依赖时连接超时

如果安装日志显示 `kubo@0.39.0` 的安装脚本访问 `https://dist.ipfs.tech/kubo/versions` 后报 `ETIMEDOUT`，这是原有端到端测试依赖下载节点二进制失败。WebUI 和新的 API 服务使用已有的 IFShare 节点，不需要这个下载。该版本的 `KUBO_BINARY` 仅控制运行时路径，不能跳过安装下载。

在项目根目录使用锁定版本恢复依赖，并单独执行页面所需的安装步骤：

```bash
npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund
npm rebuild esbuild @swc/core --foreground-scripts
npm run postinstall
npm run dev
```

`--ignore-scripts` 只作用于这次安装；后续两步恢复编译工具并应用项目补丁。此流程不下载测试用的 Kubo 或 Playwright 浏览器。若运行原有端到端测试，需另行准备其节点二进制与浏览器。使用 `npm` 和仓库的 `package-lock.json`，避免中途切换到 `cnpm` 形成不完整的依赖目录。

## 功能和权限

- 管理员：用户查询、分页、新增、编辑、删除、启用、停用和重置密码。
- 普通用户：可登录使用现有 WebUI 功能，不显示用户管理；直接调用用户管理接口也会收到 `403`。
- 日志：记录 WebUI 发起的上传、下载和预览操作，支持分页、操作类型及文件名/路径/CID/用户名搜索。管理员查看全部日志，普通用户仅能查询自己的记录，权限由服务端检查。
- 批量上传/下载按一次操作记录，并保存首个文件信息和文件数量；压缩包内下载记录成员路径。日志表示操作发起，不代表上传成功或下载已保存完成。自动缩略图、后台探测和媒体分段请求不产生操作记录。直接调用节点 CLI、RPC 或网关的操作不在此日志范围内。
- 日志保存用户名快照及服务端时间；删除用户不删除历史日志，同名新用户不能查看旧账号记录。日志上报失败不阻塞文件操作，无离线补报或跨会话重试。当前不自动清理历史日志，请按部署方保留策略管理数据库容量与备份。
- 内置 `admin` 不能删除、停用、改用户名或降级，避免管理员锁定。可修改显示名称、重置密码。
- 停用、删除或重置密码会撤销该用户已有会话；恢复启用后需要重新登录。
- 本版区分的是“能否管理用户”，不包含按用户隔离 MFS 文件或节点资源。登录用户共享连接节点的文件视图及现有节点操作。

登录使用浏览器 Web Crypto 的 RSA-OAEP/SHA-256 加密密码，每次请求绑定一次性短期挑战和用户名；服务端用带随机盐的 scrypt 哈希保存密码。会话使用 HttpOnly、SameSite=Strict Cookie，公网 HTTPS 环境再设置 Secure。不要把密码、密文、Cookie 或数据库提交到 Git。

公网必须通过 HTTPS；RSA 密文不能替代 HTTPS 的服务器身份验证。浏览器不支持 Web Crypto 或页面不是安全上下文时，登录应显示错误，不降级成明文。`localhost` HTTP 可用于本地开发。

## 配置

配置通过环境变量传入；`.env.example` 仅为模板，不会自动加载。开发时可执行：

```bash
node --env-file=ipfs-webuiapi/.env ipfs-webuiapi/server.mjs
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEBUI_API_HOST` | `127.0.0.1` | API 监听地址；生产保持回环地址，由 Apache 暴露 HTTPS |
| `WEBUI_API_PORT` | `3001` | Node 服务监听端口 |
| `WEBUI_API_PROXY_TARGET` | `http://127.0.0.1:3001` | 仅开发页面使用的代理目标；更改 API 端口时同步设置此项 |
| `WEBUI_API_DB_TYPE` | `sqlite` | `sqlite`、`mysql`、`mariadb`、`postgresql`；兼容 `postgres` / `postsql` 别名 |
| `WEBUI_API_DB_HOST` | `127.0.0.1` | 外部数据库主机 |
| `WEBUI_API_DB_PORT` | `3306` / `5432` | MySQL、MariaDB / PostgreSQL 端口 |
| `WEBUI_API_DB_NAME` | `ifshare` | 数据库名，仅字母、数字、下划线；首字符非数字，最多 63 字符 |
| `WEBUI_API_DB_USER` | `ifshare` | 数据库账号，需事先在数据库服务中创建 |
| `WEBUI_API_DB_PASSWORD` | 空 | 数据库连接密码，仅服务端使用 |
| `WEBUI_API_DB_CREATE` | `true` | 缺库时自动创建；`false` 要求数据库已存在 |
| `WEBUI_API_DB_POOL_SIZE` | `10` | 外部连接池上限，范围 1–100 |
| `WEBUI_API_DB_QUERY_TIMEOUT_MS` | `15000` | 单条数据库查询最长时间；超时中断该连接，不重试写入 |
| `WEBUI_API_DB_ACQUIRE_TIMEOUT_MS` | `10000` | 排队/建立连接等待期限；过期请求从队列移除 |
| `WEBUI_API_DB_QUEUE_LIMIT` | `100` | 等待中的数据库请求上限；超过上限返回 503 |
| `WEBUI_API_BODY_TIMEOUT_MS` | `15000` | 小型 API JSON 请求体的总接收期限；不限制文件上传流 |
| `WEBUI_API_LOG_LEVEL` | `info` | 运行日志级别：`info` / `warn` / `error` / `silent`；不影响数据库里的操作记录 |
| `WEBUI_API_DB_SSL` | `false` | `true` 启用 TLS 并校验证书；不提供跳过证书验证模式 |
| `WEBUI_API_DB_CA` | 空 | 自定义 CA PEM 文件路径，需同时开启 SSL |
| `WEBUI_API_DB` | 服务目录下 `data/ifshare.sqlite` | SQLite 文件路径；生产放在发布目录之外 |
| `WEBUI_STATIC_DIR` | 项目 `build` 目录 | 构建后的 WebUI 静态资源目录 |
| `WEBUI_API_PUBLIC_ORIGIN` | 空 | 生产入口，例如 `https://files.example.com:3000`；需包含实际端口，无路径 |
| `KUBO_RPC_URL` | `http://127.0.0.1:5001` | 固定 RPC 上游地址，不带 `/api/v0` |
| `KUBO_GATEWAY_URL` | `http://127.0.0.1:8080` | 固定文件网关上游地址，不带 `/ipfs` |

生产入口配置为 HTTPS 时，Cookie 启用 Secure；非回环监听必须配置公网入口。服务不向浏览器开放跨域 CORS，所有页面/API/网关通过同一个入口访问。转发 RPC 时把 Origin 设置为节点 RPC 地址，以兼容节点 CORS；节点相应允许 `http://127.0.0.1:5001`，不要使用 `*`。RPC 和网关均建议仅监听服务器回环地址，避免绕过 WebUI 登录。

## 切换数据库

四种数据库共用同一套用户、会话与日志接口。启动时自动创建缺失的 `users`、`sessions`、`operation_logs` 表及索引，重复启动保留数据。不会清空现有 SQLite，也不会自动将旧数据库的数据迁移到另一种引擎；切换配置将连接所选的数据库，空库会初始化 `admin/password`。

MySQL / MariaDB 示例（在服务的环境文件中配置）：

```dotenv
WEBUI_API_DB_TYPE=mariadb
WEBUI_API_DB_HOST=127.0.0.1
WEBUI_API_DB_PORT=3306
WEBUI_API_DB_NAME=ifshare
WEBUI_API_DB_USER=ifshare
WEBUI_API_DB_PASSWORD=replace-with-database-password
WEBUI_API_DB_CREATE=true
WEBUI_API_DB_POOL_SIZE=10
```

MySQL 将类型改为 `mysql`；PostgreSQL 将类型改为 `postgresql`、端口改为 `5432`。SQLite 使用 `WEBUI_API_DB_TYPE=sqlite` 和 `WEBUI_API_DB=/持久化目录/ifshare.sqlite`。远程数据库启用 `WEBUI_API_DB_SSL=true`；私有 CA 配合 `WEBUI_API_DB_CA=/etc/ifshare/database-ca.pem`。配置文件不应放入静态页面目录或 Git，生产由 systemd 的 `EnvironmentFile` 读取；`npm run dev` 不会自动加载子目录 `.env`，可在运行前导出环境变量，或按上面的 `node --env-file` 命令单独启动 API。

自动建库的前提是数据库服务已安装且可连接、账号已存在并有创建数据库权限（MySQL/MariaDB 的 `CREATE`，PostgreSQL 的 `CREATEDB`）。数据库已经存在时不要求建库权限，仍需目标库的读写、建表和索引权限。PostgreSQL 建库还需要连接系统库 `postgres`。应用不会安装数据库服务器、创建数据库账号或提升其权限；权限不足、连接失败会阻止 API 启动，不会悄悄回退到 SQLite。

可由 DBA 预建数据库并设置 `WEBUI_API_DB_CREATE=false`。后续支持更多数据库时，在 `database.mjs` 增加适配器即可，业务接口无需绑定驱动的查询格式。

## Apache HTTPS 部署

新版需要运行 Node 服务，不能仅替换静态 `build` 文件。此前一键包使用 Apache 表单认证，其认证配置不能与新服务同时启用。这里提供独立模板，不自动修改旧的一键安装器、线上配置或证书。

1. 构建前端：在项目根目录运行 `npm run build:server`。
2. 复制 `build/` 到 `/opt/ifshare/current/web`；复制整个 `ipfs-webuiapi/` 源码目录到 `/opt/ifshare/current/ipfs-webuiapi`，排除 `data/`、`.env`、测试文件。服务器准备 Node 22.13 及以上版本；SQLite 无额外驱动依赖，外部数据库需在 API 目录执行 `npm ci --omit=dev --registry=https://registry.npmjs.org`。
3. 在服务器创建 `/etc/ifshare/webuiapi.env`。以下示例请替换公网入口；配置文件权限建议 `0600`：

```dotenv
WEBUI_API_HOST=127.0.0.1
WEBUI_API_PORT=3001
WEBUI_API_DB=/var/lib/ifshare-webuiapi/ifshare.sqlite
WEBUI_STATIC_DIR=/opt/ifshare/current/web
WEBUI_API_PUBLIC_ORIGIN=https://files.example.com
KUBO_RPC_URL=http://127.0.0.1:5001
KUBO_GATEWAY_URL=http://127.0.0.1:8080
```

4. 使用 `deploy/ifshare-webuiapi.service` 安装 systemd 服务；确认已有 `ifshare` 用户以及 Node 的实际安装路径。模板使用 `/usr/bin/node`。systemd 创建并授权 `/var/lib/ifshare-webuiapi`；更换目录时同步修改 `ReadWritePaths`。随后执行：

```bash
sudo cp ipfs-webuiapi/deploy/ifshare-webuiapi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ifshare-webuiapi
sudo systemctl status ifshare-webuiapi
```

5. 备份旧 Apache 虚拟主机配置，以 `deploy/apache.conf` 替换该站点的配置，保留现有证书文件。按实际环境修改监听端口、`ServerName`、证书路径及日志目录。Apache 将整个站点代理到 Node，不再使用旧的 `AuthType form`、`AuthUserFile`、`SessionCookieName` 和 `/auth/*` 处理器，也不要保留直接指向 Kubo 的旧 `ProxyPass`，否则会绕过新会话校验。部署 API 和新页面应在同一次维护窗口完成。
6. 确认启用 `ssl`、`proxy`、`proxy_http`、`headers` 模块；运行 Apache 配置检查后重载。例如 Debian/Ubuntu 默认 Apache：

```bash
sudo apachectl configtest
sudo systemctl reload apache2
```

原一键包使用独立 Apache 进程/服务时，应使用其实际配置检查命令和 `ifshare-web` 服务名；不要启动第二个进程占用相同端口。

公网仅开放实际 Web HTTPS 端口；Node 3001、RPC 5001、网关 8080 不需向公网开放。节点组网的 Swarm 端口沿用原节点部署配置，与本服务无关。

## 接口

所有路径前缀为 `/webui-api/v1`。登录后浏览器自动携带会话 Cookie。写操作需 `Content-Type: application/json`（存在请求体时）及 `X-IFShare-Request: 1`，并接受同源校验。错误格式为 `{ "error": { "code": "...", "message": "..." } }`。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/auth/challenge` | 获取一次性 `challengeId` 和 RSA `publicKey`（JWK） |
| POST | `/auth/login` | `{username, challengeId, password}`；`password` 是 RSA-OAEP 密文的 Base64，OAEP label 为 UTF-8 `${challengeId}:${username}`；成功返回 `{user}` |
| GET | `/auth/session` | 获取当前 `{user}`；未登录或会话失效返回 `401` |
| POST | `/auth/logout` | 注销当前会话 |
| GET | `/users?q=&page=1&pageSize=20` | 管理员分页查询 `{users,total,page,pageSize}` |
| GET | `/users/:id` | 管理员查询单个用户 |
| POST | `/users` | 管理员新增 `{username,displayName,enabled}`；默认密码 `password` |
| PATCH | `/users/:id` | 管理员修改用户名、显示名称、启停状态 |
| DELETE | `/users/:id` | 管理员删除用户 |
| POST | `/users/:id/reset-password` | 管理员将密码重置为 `password` 并撤销旧会话 |
| GET | `/logs?page=1&pageSize=20&q=&action=` | 查询 `{logs,total,page,pageSize}`；每页最大 100，`action` 为 `upload` / `download` / `preview` |
| POST | `/logs` | 写入 `{eventId,action,fileName,filePath,cid,fileCount}`；`eventId` 为 UUID，同用户同事件只写一次；用户和时间取当前服务端会话 |

普通用户的角色固定为 `user`，接口不接受通过提交 `role` 或 `password` 来提升角色或另设密码。管理权限在后端检查，不依赖导航是否隐藏。

## 性能与故障边界

- 数据库请求有并发、排队和时间上限。队列已满或等待/查询超时返回 503，不会无限占用连接；单个事务最长为查询时限的 4 倍。MySQL/MariaDB 同时设置服务端执行/锁等待限制，PostgreSQL 设置 `statement_timeout`。MySQL 的执行时限只适用于只读 SELECT，写入和 COMMIT 在连接中断时可能已经完成，因此失败写入不会自动重试。
- 操作日志保存的是用户发起动作，不保证文件上传/下载成功。相同事件 ID 幂等；日志服务不可用时可能漏记，当前没有持久化客户端补报队列。
- 分页最多 100 条，只加载当前页。按用户范围和操作类型过滤有对应索引；文件元信息的包含匹配需要扫描，深分页的 OFFSET 也会随历史数据增加而变慢。当前没有自动删除日志的策略，应按部署方要求定期备份、归档。
- SQLite 适合单机部署；改为外部数据库不会自动迁移数据。连接池可控制并发，增加池大小不能代替查询优化。变更数据库超时后，应把 systemd 的 `TimeoutStopSec` 设为大于事务最长时间和连接等待时间；模板设为 120 秒，适配默认配置。

可在项目根目录运行 `node ipfs-webuiapi/bench/sqlite-logs.mjs`，用临时十万条日志和 8 并发查询对比旧主线程查询路径与当前实现。测试结束自动删除临时库，结果仅代表本机合成负载；输出的 `parentRssMiB` 不包含 SQLite 子进程，不能当作总内存。

## 数据备份和故障定位

SQLite 模式采用 WAL，用户、会话、操作日志都保存在同一个数据库。查询在独立 Node 子进程中执行，避免锁等待或大表搜索阻塞 HTTP 服务；单条查询超时会结束该子进程，下一次请求重新打开文件库，未提交事务由 SQLite 恢复。请完整部署 API 目录中的 `.mjs` 文件（包含 `database-runtime.mjs`、`sqlite-process.mjs`）。内存数据库被中断后明确报错，不会重建一个空库来掩盖数据丢失。最简单的完整备份方式是停止 `ifshare-webuiapi` 后备份整个数据库目录，再恢复服务；不要在运行时只复制 `.sqlite` 而遗漏 `-wal` 中的写入。升级时保留数据库目录；删除它会丢失全部用户并在下次启动重新生成默认管理员。

外部数据库使用对应数据库的备份/恢复工具；数据不在 API 发布目录中。切换引擎或连接不同实例前，先备份并单独计划迁移，应用不会自动复制历史账号或日志。

服务运行日志默认向 stderr 输出 JSON，可用 `journalctl -u ifshare-webuiapi` 查看；包含时间、级别、事件、错误代码，以及必要的用户 ID / 耗时。数据库连接、查询超时、队列满、网关异常、会话清理和服务启停均可定位。重复事件每分钟最多直接输出 10 条，后续汇总被抑制数量；输出端阻塞时丢弃多余运行日志，不在内存中无限排队。服务运行日志不输出密码、Cookie、文件 CID 和访问的文件路径。文件元信息仅存储在这里配置的操作日志数据库中，页面按用户权限查询。浏览器上报操作日志失败时，控制台每 30 秒最多提示一次固定错误类别和 HTTP 状态，不输出文件名、CID、用户名或服务端响应正文；不会阻止文件操作，也不会离线补报。不要开启包含查询参数、凭据或 CID 的代理访问日志。

- 页面可加载但无法登录：检查 Node 服务、`/webui-api/v1/auth/session`、浏览器 HTTPS 证书信任、实际 Origin 与配置是否一致。
- 登录后 RPC 返回 `502`：检查 IFShare 是否运行，RPC 上游及节点 CORS 是否正确。
- 原页面的旧 Cookie 不生效：新版需要重新使用账号数据库中的账号登录。
- 静态资源 `404`：检查前端是否构建、`WEBUI_STATIC_DIR` 是否正确以及运行用户是否有读取权限。

运行后端测试：`npm --prefix ipfs-webuiapi test`。默认测试使用临时 SQLite/目录和随机回环端口，不触碰真实节点仓库。外部数据库测试通过 `IFSHARE_TEST_DATABASES` 传入 JSON 配置数组，每项使用 `databaseType/databaseHost/databasePort/databaseUser/databasePassword` 字段；测试创建随机测试库并在结束后删除，仅应连接隔离的测试实例。
