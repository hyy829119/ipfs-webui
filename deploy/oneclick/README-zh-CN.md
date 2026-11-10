# IFShare 一键私有部署

完整的环境准备、端口放行、节点组网、跨节点文件验收、HTTPS 和 WebUI 部署流程见 [IFShare 私有部署与验收手册](DEPLOYMENT-zh-CN.md)。

安装包包含已编译的 Linux amd64 `ifshare`、带服务端登录校验的 WebUI、独立 Apache 配置、安装脚本和 HTTPS 证书脚本。服务器不需要安装 Go、Node.js，也不需要现场编译程序。

## 环境

- Linux x86_64，使用 systemd；按客户的 Ubuntu 22.04 环境验证。
- 执行安装需要 root 或 sudo 权限。仅有普通 SSH 账号且无 sudo 权限时，请让管理员执行。
- 首次安装需要能访问系统 apt 软件源，安装 Apache、OpenSSL、Python 3 等依赖。已安装依赖时不重复下载。
- 可写的独立存储目录；Web、RPC、Gateway、Swarm 四个端口不能冲突。

## 安装并启动

先解压，在解压目录执行：

```bash
tar -xzf ifshare-linux-amd64-*.tar.gz
cd ifshare-linux-amd64
sudo bash install.sh /data/ifshare 3000 --host 183.230.227.10
```

两个必填入参：

| 参数 | 示例 | 含义及检查 |
| --- | --- | --- |
| 第一个：存储目录 | `/data/ifshare` | 绝对路径；不存在则创建；存在则检查目录类型、权限和已有数据。作为服务的 `IPFS_PATH`，包括文件块、数据库和节点配置。非本脚本管理的已有仓库不会被覆盖。 |
| 第二个：Web 端口 | `3000` | 1～65535；检查 IPv4/IPv6 端口占用。被其他程序占用就停止；重装时可以复用本程序正在监听的端口。 |

`--host` 是浏览器实际访问的 IPv4 或域名，不带 `https://`、端口、路径。首次省略时使用服务器主 IPv4；重装省略则保留原值。访问公网地址时应明确传入公网 IP/域名，证书 SAN 和 Apache 来源校验都会使用它。

该示例的访问地址是 `https://183.230.227.10:3000`。公网映射需由环境管理员配置到这台服务器的 TCP 3000，且保持外部端口同为 3000。脚本不会更改防火墙、路由器或现有 Nginx 站点。页面已有的本地网关探测与服务端兜底策略保留；服务器 RPC 和 Gateway 只监听环回地址，由 Apache 统一转发。

初始登录账号 `admin`，密码 `123456`。后续安装保留已有用户文件。如需修改密码：

```bash
sudo htpasswd -B /etc/ifshare/apache/users admin
```

## 私有网络密钥与其他节点加入

新安装会生成 `<存储目录>/swarm.key`，以 `LIBP2P_FORCE_PNET=1` 启动。安装完成的最后输出会展示完整密钥路径、Peer ID 所在的引导地址示例和证书路径。重复运行保留原密钥与节点身份。

其他节点必须使用**同一份 `swarm.key`**，并能访问现有节点的 Swarm TCP 端口，默认 `4001`。应通过可信渠道传递此文件；安装包不携带任何实际私网密钥或证书私钥。每个节点独立初始化，不要复制整个仓库或节点的 Identity 私钥。

在另一台服务器解压相同安装包后：

```bash
sudo bash install.sh /data/ifshare 3000 \
  --host 10.10.1.126 \
  --swarm-key /secure/received/swarm.key \
  --bootstrap /ip4/10.10.1.125/tcp/4001/p2p/实际PeerID
```

把示例 IP/PeerID 改成安装结束时打印且对新节点可达的地址。有 NAT 时使用实际映射的 Swarm TCP 端口。相同密钥不会自动建立网络连接，仍需可达的引导地址。脚本关闭公网 AutoConf、自动 TLS、mDNS、自动端口映射和遥测；首次初始化不配置公共引导节点，只使用传入的私网节点。

可选 `--api-port 5001`、`--gateway-port 8080`、`--swarm-port 4001`。重复安装省略时保留旧端口；`--bootstrap` 可传多次。已有节点的私网引导列表保留，新传入的地址追加。已有 `swarm.key` 与传入密钥不一致时停止，不自动替换。

## HTTPS 证书

首次安装自动生成本部署独有的私有 CA（10 年）和服务器证书（1 年）。重复安装保留 CA；地址改变或服务器证书不足 30 天时重新签发。证书与 Apache 配置同步检查后启动服务。

- 客户端导入信任的 CA 公钥证书：`/opt/ifshare/IFShare-CA.crt`。
- 服务器证书和私钥：`/etc/ifshare/tls/server.crt`、`server.key`。
- CA 私钥：`/etc/ifshare/tls/ca.key`，仅留在服务器 root 可读目录，不向客户端分发。
- 私有 CA 需要通过可信渠道分发并在浏览器/操作系统信任。自签证书不会自动获得所有设备的信任；信任并以 HTTPS 访问后，浏览器才能正常使用 OPFS 等安全上下文能力。

一键续签服务器证书并重载 Apache，CA 保持不变：

```bash
sudo bash /opt/ifshare/current/renew-certificate.sh
```

建议在到期前运行，也可由管理员纳入自己的定时任务。更换域名/IP 时重新执行 `install.sh`，通过 `--host` 传入新地址，以同步证书和来源校验。

## 服务、配置及重复安装

```bash
sudo systemctl status ifshare-node ifshare-web
sudo systemctl restart ifshare-node ifshare-web
sudo journalctl -u ifshare-node -u ifshare-web -n 100 --no-pager
sudo systemctl disable --now ifshare-web ifshare-node
```

最后一条可停止服务并关闭开机启动，文件数据仍保留。

| 路径 | 用途 |
| --- | --- |
| `/opt/ifshare/releases/<版本>/` | 程序、页面、脚本 |
| `/opt/ifshare/current` | 当前运行版本的符号链接 |
| `/etc/ifshare/apache/httpd.conf`、`site.conf` | Apache 主配置与站点配置；重复安装保留，包内新模板写入 `.package-new` 供比较 |
| `/etc/ifshare/apache/runtime.conf` | 由安装参数生成的地址和端口；调整请重新执行安装脚本 |
| `/etc/ifshare/apache/users`、`session.key` | 登录密码哈希与会话密钥，重装保留 |
| `/etc/ifshare/node.env` | 节点的 `IPFS_PATH` 和强制私网运行环境 |
| `/etc/ifshare/install.json` | 已安装参数；不包含密码或密钥内容 |
| `/opt/ifshare/backups/` | 升级前配置备份，包含敏感配置，仅管理员可读 |
| `/var/log/ifshare/apache-error.log` | Apache 错误日志 |

更新时解压新包，用相同存储目录运行安装脚本。安装脚本先校验包、路径和端口，再备份配置，停止这两个受管服务，切换版本并验证启动；升级失败会尝试恢复原版本和配置。节点数据不打包复制，也不删除。旧版本和配置备份不会自动清理。

已有存储目录不可直接改参数切换；迁移数据请先停机备份，由管理员完成迁移。脚本不自动迁移已有仓库的数据版本（daemon 使用 `--migrate=false`）；未来升级若需要仓库迁移，应另行按该版本说明执行。

独立 Apache 使用 `apache2-bin`，不会启用发行版默认 80 端口站点。自定义配置修改后校验、重载：

```bash
sudo /usr/sbin/apache2 -f /etc/ifshare/apache/httpd.conf -t
sudo systemctl reload ifshare-web
```

## 构建者重新打包

Kubo 仓库根目录执行 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 make build`，WebUI 根目录执行 `npm run build:server`。然后在 WebUI 根目录执行：

```bash
python3 deploy/oneclick/build-package.py \
  --binary /path/to/kubo/cmd/ipfs/ifshare \
  --kubo-root /path/to/kubo \
  --output-dir /path/to/output
```

输出 `.tar.gz` 和外层 `.sha256`；包内 `SHA256SUMS` 覆盖全部部署文件，安装前自动校验。校验和用于发现传输损坏；请从可信渠道接收整个安装包。
