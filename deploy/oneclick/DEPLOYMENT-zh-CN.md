# IFShare 私有部署与验收手册

适用对象：负责安装、组网和验收 IFShare 的服务器管理员。更新日期：2026-11-03。

本手册以两台 Linux 服务器为例，使用交付安装包完成节点、Apache、HTTPS 和 WebUI 部署，再验证节点互连、跨节点读取、文件副本和 Web 文件列表。程序名为 `ifshare`；`IPFS_PATH`、`swarm.key`、`/ipfs/` 和 `/api/v0/` 是沿用的配置及协议名称，操作时保持原样。

执行顺序：确认环境和端口 → 安装节点 A → 分发私网密钥 → 安装节点 B → 验证组网和数据 → 信任 HTTPS 证书 → 验收 WebUI。安装包已包含编译程序和静态页面，目标服务器不需要安装 Go、Node.js 或运行 `npm start`。

目录：

- [环境与部署规划](#1-环境与部署规划)
- [端口放行与网络映射](#2-端口放行与网络映射)
- [安装节点 A](#3-安装节点-a)
- [节点管理命令](#4-节点管理命令)
- [加入节点 B](#5-加入节点-b)
- [节点组网与数据验收](#6-节点组网与数据验收)
- [Web 文件列表与多节点文件共享](#7-web-文件列表与多节点文件共享)
- [WebUI 与 HTTPS 部署验收](#8-webui-与-https-部署验收)
- [运行维护与配置位置](#9-运行维护与配置位置)
- [备份升级与证书续签](#10-备份升级与证书续签)
- [常见故障定位](#11-常见故障定位)
- [交付验收记录](#12-交付验收记录)

## 1 环境与部署规划

### 1.1 服务器条件

| 项目 | 要求 |
| --- | --- |
| 系统和架构 | Linux x86_64/amd64，Debian 或 Ubuntu，使用 systemd；现有安装验证环境为 Ubuntu 22.04 amd64 |
| 安装权限 | root，或能够通过 sudo 执行安装脚本的管理员账号 |
| 系统依赖 | 首次安装通过 apt 安装 Python 3、Apache、OpenSSL、curl 等缺失依赖；目标服务器需能访问其系统软件源 |
| 存储目录 | 独立、可写的绝对路径，例如 `/data/ifshare`；服务账号需要有父目录的遍历权限 |
| 磁盘 | 根据计划存储的内容、数据库增长和备份预留空间；目录应位于预期的数据盘上 |
| 时间 | 服务器和访问设备的时间正确，以便验证 HTTPS 证书 |
| 实例数量 | 一键脚本在每台主机管理一套节点和 Web 服务；不同数据目录不会创建第二套实例 |

只有普通 SSH 权限、没有 sudo 的账号不能完成本脚本的系统服务和 Apache 安装，需要服务器管理员执行。当前包不适用于 ARM、Windows、macOS 或没有 systemd 的普通容器。

在各服务器执行环境检查：

```bash
uname -m
cat /etc/os-release
ps -p 1 -o comm=
sudo -l
df -h
sudo ss -lntp
```

预期架构为 `x86_64`，PID 1 为 `systemd`。安装脚本还会检查包校验和、目录、服务名称和端口；任一检查失败时，按错误提示处理后重试。

### 1.2 示例节点清单

下面的 IP 是示例，执行前替换为本环境实际地址。两台不同服务器可以使用相同端口和相同存储路径。

| 项目 | 节点 A | 节点 B |
| --- | --- | --- |
| 节点互连 IP | `10.20.0.11` | `10.20.0.12` |
| Web 访问地址 | `https://10.20.0.11:3000` | `https://10.20.0.12:3000` |
| 节点存储目录 | `/data/ifshare` | `/data/ifshare` |
| Web HTTPS 端口 | `3000/TCP` | `3000/TCP` |
| Swarm 组网端口 | `4001/TCP` | `4001/TCP` |
| 本机 RPC 端口 | `127.0.0.1:5001/TCP` | `127.0.0.1:5001/TCP` |
| 本机网关端口 | `127.0.0.1:8080/TCP` | `127.0.0.1:8080/TCP` |
| 私网密钥 | 首次生成 | 使用 A 的同一份 `swarm.key` |
| 节点身份 | 独立生成 | 独立生成，与 A 不同 |

## 2 端口放行与网络映射

### 2.1 默认端口清单

| 端口 | 协议和用途 | 入站放行范围 | 出站要求 |
| --- | --- | --- | --- |
| `3000` | TCP，Apache 提供 HTTPS 页面、登录、RPC 和文件访问 | 允许需要使用 WebUI 的客户端访问 | 客户端能够连接服务器此端口 |
| `4001` | TCP，IFShare Swarm 节点互连和文件传输 | 允许私网其他节点连接；可按对端 IP 限制来源 | 节点能够连接其他节点实际公布的 Swarm TCP 端口 |
| `5001` | TCP，本机 RPC 管理接口 | 保持监听 `127.0.0.1`，不向外部放行或映射 | 本机 Apache 和 CLI 使用 |
| `8080` | TCP，本机 HTTP Gateway | 保持监听 `127.0.0.1`，不向外部放行或映射 | 本机 Apache 使用 |
| 实际 SSH 端口 | TCP，远程安装与运维，常见为 `22` | 允许指定运维终端访问 | 运维终端能够连接该端口 |

当前一键安装将私网 Swarm 配置为 TCP，不启用 UDP/QUIC 或 WebSocket 监听，因此本方案无需为组网放行 `4001/UDP`。`3000`、`4001`、`5001`、`8080` 都是默认值；更换安装参数后，应按实际值调整网络规则。同一台主机的这四个端口必须互不相同。

节点组网使用 Swarm 端口，不使用 Web、RPC 或 SSH 端口。仅开放 Web 的 `3000`，不能让两台节点互连。RPC 和网关通过同一个 HTTPS 入口转发，正常部署不需要单独向客户端开放 `5001` 或 `8080`。

首次安装还需要服务器向其配置的软件源发起出站请求，通常涉及 DNS 和软件源使用的 HTTP/HTTPS 端口。这属于安装依赖下载，不是业务节点的入站端口。脚本不会自动修改主机防火墙、云安全组或路由器规则。

### 2.2 放行方向示例

| 来源 | 目标 | 目标端口 | 预期用途 |
| --- | --- | --- | --- |
| 使用者电脑或手机所在网络 | A、B 的 Web 地址 | TCP `3000` | 登录和访问页面 |
| 节点 A | 节点 B 的可达 Swarm 地址 | TCP `4001` 或 B 的映射端口 | A 主动连接 B |
| 节点 B | 节点 A 的可达 Swarm 地址 | TCP `4001` 或 A 的映射端口 | B 主动连接 A |
| 运维终端 | A、B 的 SSH 地址 | 实际 SSH TCP 端口 | 安装与管理 |

双方均允许主动连接有利于重连。只需一方能主动拨通对端时也能建立连接，但验收仍应记录实际可达方向；不要假设两个只有出站能力的 NAT 节点会自动发现并连接。

若现场已使用并启用 UFW，可在节点 A 上参考以下增量规则，替换示例网段和对端 IP：

```bash
sudo ufw allow from 10.20.0.0/24 to any port 3000 proto tcp
sudo ufw allow from 10.20.0.12 to any port 4001 proto tcp
sudo ufw status numbered
```

节点 B 的 Swarm 来源改为 `10.20.0.11`。公网环境应填写实际公网来源或 VPN 网段。保留现有 SSH 放行规则，不需要为了此部署重置防火墙。若使用默认拒绝出站的策略，还需按上表放行相应出站连接；安全组和边界防火墙也要同步核对。

### 2.3 公网和 NAT 场景

一键安装的 Web 端口参数同时决定 Apache 监听端口和页面来源地址，当前脚本不提供单独的“外部 Web 端口”参数。采用端口映射时，使用相同的内外 Web 端口，例如：

```text
公网 Web 地址:3000/TCP  →  节点内网 IP:3000/TCP
公网组网地址:14001/TCP →  节点内网 IP:4001/TCP
```

此例中安装使用 `3000 --host 公网IP或域名`，对端节点使用的引导地址则为：

```text
/ip4/公网IPv4/tcp/14001/p2p/该节点PeerID
```

使用域名时为 `/dns4/域名/tcp/14001/p2p/该节点PeerID`。安装结束打印的引导地址只是示例，必须按节点之间实际可达的地址和映射端口修改。Web 地址和节点互连地址可以不同。

如果采用标准 HTTPS `443`，安装时把第二个参数改为 `443`，并开放 TCP `443`；访问地址不再附加端口。单独开放 `80` 不会自动提供本方案的 HTTPS 服务。

早期手工 Apache 环境曾使用“外部 `3000` → 内部 `80`”。该环境应按原配置维护；不要把此映射照搬到本手册的一键安装。需要在现有反向代理后使用不同内外端口时，要单独协调 TLS、外部 Origin 和 Apache 配置。

## 3 安装节点 A

### 3.1 校验与解压安装包

将交付的 `.tar.gz` 和同名 `.sha256` 放在同一目录。以下 `RELEASE` 替换为收到的实际文件名中的版本部分，每次解压使用一个新的空目录：

```bash
sha256sum -c ifshare-linux-amd64-RELEASE.tar.gz.sha256
mkdir ifshare-release-RELEASE
tar -xzf ifshare-linux-amd64-RELEASE.tar.gz -C ifshare-release-RELEASE
cd ifshare-release-RELEASE/ifshare-linux-amd64
sha256sum -c SHA256SUMS
```

所有条目应为 `OK`。不要在安装包目录加入日志、修改脚本或调整模板后直接安装；安装器会拒绝被修改或未列入校验清单的文件。运行后需要自定义的 Apache 配置位于 `/etc/ifshare/apache/`。

安装包中的主要文件：

| 文件或目录 | 用途 |
| --- | --- |
| `bin/ifshare` | Linux amd64 节点可执行程序 |
| `web/` | 带服务端登录校验的静态 WebUI |
| `install.sh`、`installer.py` | 安装、校验、升级和服务启动 |
| `apache/` | 独立 Apache 主配置及站点模板 |
| `certificates.py`、`renew-certificate.sh` | HTTPS 证书生成与续签 |
| `verify-rpc.py` | 交互输入密码的 Web 登录、RPC 和网关验收工具 |
| `manifest.json`、`SHA256SUMS` | 发布版本、源代码提交和包内文件校验信息 |
| `README-zh-CN.md`、`DEPLOYMENT-zh-CN.md` | 快速安装说明及本手册 |

### 3.2 安装并启动

在 A 的解压目录执行：

```bash
sudo bash install.sh /data/ifshare 3000 --host 10.20.0.11
```

| 参数 | 行为 |
| --- | --- |
| 第一个必填参数 `/data/ifshare` | 作为节点的 `IPFS_PATH`，保存块数据、数据库、MFS、节点配置和私网密钥；不存在则创建；存在则检查目录和已有数据 |
| 第二个必填参数 `3000` | HTTPS Web 端口，必须在 1～65535 范围内且可用；检查 IPv4/IPv6 端口占用 |
| `--host 10.20.0.11` | 浏览器实际访问的 IPv4 或域名，不含协议、端口和路径；用于证书和来源校验 |
| `--api-port 5001` | 可选，本机 RPC 端口 |
| `--gateway-port 8080` | 可选，本机网关端口 |
| `--swarm-port 4001` | 可选，节点组网 TCP 端口 |

首次省略 `--host` 时使用服务器主 IPv4；公网访问时应明确指定访问地址。路径中有空格时用引号，例如 `"/data/ifshare files"`。

脚本会安装缺失依赖、创建 `ifshare` 服务账号、初始化私有节点、生成 `swarm.key` 和 HTTPS 证书、配置独立 Apache，并启用 `ifshare-node` 与 `ifshare-web` 两个 systemd 服务。

已有非本脚本管理的数据目录、程序目录、配置目录或同名服务会导致安装停止。已有安装不支持通过改第一个参数自动迁移存储目录，也不会通过重复安装覆盖旧节点密钥。

### 3.3 安装结果

成功输出应包含访问地址、存储目录、私网密钥文件路径、引导地址示例和 CA 证书路径。默认示例对应：

```text
WebUI: https://10.20.0.11:3000
文件和节点存储目录: /data/ifshare
私有网络密钥文件: /data/ifshare/swarm.key
客户端信任证书: /opt/ifshare/IFShare-CA.crt
```

**其他节点加入时需要的是同一份 `/data/ifshare/swarm.key`。** `IFShare-CA.crt` 用于浏览器信任 HTTPS，两者用途不同。不要分发节点 Identity 私钥或把整个节点仓库复制给另一台机器。

检查服务及端口：

```bash
sudo systemctl is-active ifshare-node ifshare-web
sudo systemctl is-enabled ifshare-node ifshare-web
sudo systemctl status ifshare-node ifshare-web --no-pager
sudo ss -lntp
sudo journalctl -u ifshare-node -u ifshare-web -n 100 --no-pager
```

两个服务应为 `active`、已启用开机启动。Swarm 应监听 `0.0.0.0:4001`，RPC 和网关应只监听环回地址。节点 A 尚未连接其他节点时，peer 列表为空属于正常情况。

## 4 节点管理命令

每次新开 SSH 终端，先按本机实际安装路径设置下面的变量和函数。以下函数只在当前 Bash 会话生效，不需要更改系统 PATH：

```bash
IFSHARE_REPO='/data/ifshare'
ifshare_cli() {
  sudo -u ifshare env IPFS_PATH="$IFSHARE_REPO" \
    /opt/ifshare/current/bin/ifshare "$@"
}

ifshare_cli version
ifshare_cli id -f '<id>\n'
ifshare_cli bootstrap list
ifshare_cli swarm peers
```

使用 `ifshare` 服务账号和正确的 `IPFS_PATH`，可避免命令误连其他仓库或创建 root 所有的业务文件。确认存储路径可查看 `sudo cat /etc/ifshare/install.json`。

安装器设置 `LIBP2P_FORCE_PNET=1`，关闭公网 AutoConf、AutoTLS、mDNS、自动端口映射和遥测，Swarm 使用 TCP。首次安装只有显式传入的私网引导地址；同一份密钥不会自动建立节点连接。

## 5 加入节点 B

### 5.1 准备共同密钥和 A 的地址

在 A 记录 Peer ID 和密钥摘要：

```bash
ifshare_cli id -f '<id>\n'
sudo sha256sum "$IFSHARE_REPO/swarm.key"
```

由管理员通过可信的 SSH/SFTP 或既有密钥交付通道，将 A 的 `swarm.key` 原样传到 B，例如保存为 `/secure/received/swarm.key`，权限设为仅管理员可读。不要将密钥放进 Web 目录、普通共享下载链接或提交到 Git。

在 B 核对收到文件的 SHA-256，应与 A 一致：

```bash
sudo chmod 600 /secure/received/swarm.key
sudo sha256sum /secure/received/swarm.key
```

### 5.2 新节点安装

在 B 校验、解压同一个安装包，然后执行下面的命令，将占位 Peer ID 替换为 A 的实际值：

```bash
NODE_A_ID='替换为节点A的PeerID'
NODE_A_ADDR="/ip4/10.20.0.11/tcp/4001/p2p/$NODE_A_ID"

sudo bash install.sh /data/ifshare 3000 \
  --host 10.20.0.12 \
  --swarm-key /secure/received/swarm.key \
  --bootstrap "$NODE_A_ADDR"
```

B 会生成自己的节点身份，并使用导入的私网密钥。已有网络的新节点必须传入 `--swarm-key`；省略会生成新的密钥，形成另一个私网。

安装完成后，在 B 按第 4 节定义 `ifshare_cli`，记录 B 的 Peer ID，并核对本机仓库中的密钥摘要。B 的 Peer ID 应与 A 不同；两个节点的 `swarm.key` 摘要应相同。妥善保管正式密钥和受控备份，清理交付过程中产生的不必要副本。

如需在 A 也记录 B 为引导节点，在 A 执行：

```bash
NODE_B_ID='替换为节点B的PeerID'
NODE_B_ADDR="/ip4/10.20.0.12/tcp/4001/p2p/$NODE_B_ID"
ifshare_cli bootstrap add "$NODE_B_ADDR"
ifshare_cli swarm connect "$NODE_B_ADDR" --timeout=30s
```

新增 C 等后续节点时重复 B 的流程。`--bootstrap` 可以传多次，填写多个可达私网入口。引导节点也是普通存储节点，不会因此自动持有全网文件。

### 5.3 两个节点已经启动

若两个节点的密钥摘要相同，不需要重装。在 B 定义 `NODE_A_ID`、`NODE_A_ADDR` 后执行：

```bash
ifshare_cli bootstrap add "$NODE_A_ADDR"
ifshare_cli swarm connect "$NODE_A_ADDR" --timeout=30s
ifshare_cli bootstrap list
ifshare_cli swarm peers
```

`bootstrap add` 保存后续发现用的地址，`swarm connect` 尝试立即建立连接。若密钥不同，两个独立创建的私网不能直接相连；应先安排停机和配置备份，再由管理员统一密钥并重新验收。安装脚本会拒绝覆盖已有的不同密钥。

## 6 节点组网与数据验收

### 6.1 连接验收

在 A、B 分别执行：

```bash
ifshare_cli id -f '<id>\n'
ifshare_cli bootstrap list
ifshare_cli swarm peers
ifshare_cli config Addresses.Swarm
ifshare_cli config Addresses.API
ifshare_cli config Addresses.Gateway
ifshare_cli config AutoConf.Enabled
```

确认对端 Peer ID 出现在连接列表中，Bootstrap 只包含本次私网地址，AutoConf 为 `false`，监听地址符合第 2 节。只看到端口可连接，不代表密钥握手和节点协议已经成功。

如果系统安装了 `nc`，可以在 B 先检查 A 的 TCP 可达性：

```bash
nc -vz -w 5 10.20.0.11 4001
```

此检查只验证 TCP 连接；最终以 `swarm connect`、peer 列表和下面的数据读取结果为准。有 NAT 时使用实际映射地址和端口。

### 6.2 跨节点内容校验

在 A 添加一段验收内容并记录 CID 和摘要。先执行 `sudo -v` 完成当前会话的 sudo 认证，再通过标准输入提供测试内容：

```bash
sudo -v
TEST_CID=$(printf 'IFShare private network acceptance\n' | ifshare_cli add -Q)
printf '%s\n' "$TEST_CID"
printf 'IFShare private network acceptance\n' | sha256sum
```

在 B 填入 A 返回的 CID，读取内容到当前运维账号的临时文件，并比较 SHA-256：

```bash
TEST_CID='替换为节点A返回的CID'
IFSHARE_RECEIVED=$(mktemp)
ifshare_cli cat --timeout=60s "$TEST_CID" > "$IFSHARE_RECEIVED"
sha256sum "$IFSHARE_RECEIVED"
```

读取命令应退出成功，摘要应与 A 一致。这一步验证实际的跨节点文件获取。

### 6.3 持久副本与重启验收

需要 B 长期保存该文件时，在 B 执行：

```bash
ifshare_cli pin add --timeout=120s "$TEST_CID"
ifshare_cli pin ls "$TEST_CID"
```

大目录或慢链路应按数据规模延长超时。`cat` 能读取表示内容可获取，并不等于该节点已承担持久副本；只配置 Bootstrap 也不会自动复制数据。

在维护或验收窗口内，重启 B 的节点服务：

```bash
sudo systemctl restart ifshare-node
sudo systemctl is-active ifshare-node
ifshare_cli id -f '<id>\n'
ifshare_cli pin ls "$TEST_CID"
ifshare_cli cat --timeout=60s "$TEST_CID" > "$IFSHARE_RECEIVED"
sha256sum "$IFSHARE_RECEIVED"
```

等待节点就绪后再执行 CLI，确认 Peer ID、密钥和内容摘要保持一致，连接能够恢复。需要进一步证明 B 可独立提供文件时，可在约定的验收窗口暂时停止 A，再从 B 读取已经 pin 完成的内容，随后恢复 A 并检查连接。

## 7 Web 文件列表与多节点文件共享

Web 文件列表展示的是所连接节点自己的 MFS（可变文件系统）目录。节点互连、按 CID 读取和本节点文件列表是不同的操作：

| 操作 | 结果 |
| --- | --- |
| A 的 WebUI 上传文件 | 文件进入 A 的 MFS，显示在 A 的列表 |
| B 按相同 CID 获取文件 | B 能从持有内容的节点读取；不会自动添加 B 的目录项 |
| B 执行 `pin add` | B 获取并固定副本；不会自动添加 MFS 文件名 |
| B 执行 `files cp` | B 的 MFS 增加该 CID 的文件或目录引用，Web 列表可见 |

### 7.1 让 B 的 Web 列表显示 A 的文件

先在 A 的 WebUI 复制文件 CID，或在 A 根据实际 MFS 路径查询：

```bash
ifshare_cli files stat /实际文件名
```

在 B 执行，目标路径使用尚未存在的文件名：

```bash
SHARED_CID='替换为A上文件的CID'
ifshare_cli pin add --timeout=120s "$SHARED_CID"
ifshare_cli files cp "/ipfs/$SHARED_CID" /来自A的文件.txt
ifshare_cli files ls -l /
```

刷新 B 的 Web 文件列表，应该能看到并打开该文件。先 pin 可验证完整副本已获取；MFS 引用也参与节点的数据保留，但创建目录引用不等于预取完整目录内容。

### 7.2 文件夹只需处理根 CID

在 B 使用 A 的文件夹根 CID：

```bash
DIRECTORY_CID='替换为文件夹根CID'
ifshare_cli pin add --timeout=10m "$DIRECTORY_CID"
ifshare_cli files cp "/ipfs/$DIRECTORY_CID" /来自A的文件夹
ifshare_cli files ls /来自A的文件夹
```

不需要为每个子文件执行一次 `files cp`。根 CID 对应的是当时的目录内容；A 后续修改文件夹会产生新的根 CID，B 的既有引用不会自动更新。

CLI 中单独执行 `ifshare add -r -Q ./目录` 会返回 CID，但不会自动建立 MFS 路径；需要使用返回的根 CID 执行 `files cp` 才能按文件名显示在列表中。整个集群自动同步文件列表和副本不属于当前两个节点互连的功能范围。

### 7.3 通过 B 的地址下载

只要 B 能取得相同 CID，访问 `https://B的Web地址:端口/ipfs/文件CID` 就可以由 B 提供内容；B 已 pin 完整内容时，可以减少对 A 在线的依赖。文件夹内的文件使用 `/ipfs/目录CID/文件相对路径`。

使用 Apache 部署时，该下载也受登录保护。应先在 B 的 WebUI 登录；A 地址上的登录会话不会自动成为 B 地址的会话。单纯替换下载链接的主机名，还需要满足 B 的网络连通、证书信任、登录和 CID 可获取条件。

## 8 WebUI 与 HTTPS 部署验收

### 8.1 Apache 提供页面和接口

一键安装已经发布 WebUI，不需要再启动前端开发服务器。默认访问入口为 `https://节点Web地址:3000/?lng=zh-CN#/login`。

| 请求路径 | Apache 处理方式 |
| --- | --- |
| `/`、`/static/` | 从 `/opt/ifshare/current/web` 提供静态页面和资源 |
| `/auth/login`、`/auth/logout` | 服务端登录、退出及会话处理 |
| `/api/v0/` | 登录校验后转发本机 `127.0.0.1:5001` |
| `/ipfs/`、`/ipns/` | 登录校验后转发本机 `127.0.0.1:8080`，支持 GET、HEAD 和字节范围读取 |

生产包使用 `npm run build:server` 生成，RPC 地址自动使用页面所在的 HTTPS 来源。客户端浏览器不应把服务器 RPC 配置成它自己的 `127.0.0.1:5001`。

Apache 会校验外部 Origin，并将发给节点 RPC 的 Origin 设置为本机 RPC 地址，同时移除外部 Referer；安装器同步配置相应的节点允许来源。按本方案部署时，不需要另行增加浏览器直连 `5001` 的跨域设置。

### 8.2 证书分发与信任

每台新安装服务器会生成自己的私有 CA 和服务器证书。共同的 `swarm.key` 不会让 A、B 自动共用 HTTPS CA；访问两个独立生成证书的站点时，需要分别信任其 CA。

| 文件 | 用途及保管方式 |
| --- | --- |
| `/opt/ifshare/IFShare-CA.crt` | 可分发给访问设备的 CA 公钥证书 |
| `/etc/ifshare/tls/server.crt` | 服务器证书，默认有效期一年 |
| `/etc/ifshare/tls/server.key` | 服务器证书私钥，留在服务器 |
| `/etc/ifshare/tls/ca.key` | CA 私钥，留在受控服务器或备份中，不分发给客户端 |

管理员通过可信通道交付 CA 公钥证书，在访问设备的系统及浏览器使用的信任库中安装并信任。用安装时 `--host` 指定的 IP 或域名访问，确认浏览器正常显示安全连接。仅略过证书错误提示不能替代证书信任验收，也可能影响在线解压使用的浏览器存储能力。

### 8.3 登录与接口验证

初始账号为 `admin`，初始密码为 `123456`；重装保留已设置的密码。管理员可在服务器交互修改密码：

```bash
sudo htpasswd -B /etc/ifshare/apache/users admin
```

在服务器验证 Apache 配置、HTTPS 和未登录请求。`--resolve` 在本机验证实际 Host/SNI，避免把 NAT 回流能力混入本机服务检查：

```bash
sudo /usr/sbin/apache2 -f /etc/ifshare/apache/httpd.conf -t

curl --noproxy '*' --cacert /opt/ifshare/IFShare-CA.crt \
  --resolve 10.20.0.11:3000:127.0.0.1 \
  -I https://10.20.0.11:3000/

curl --noproxy '*' --cacert /opt/ifshare/IFShare-CA.crt \
  --resolve 10.20.0.11:3000:127.0.0.1 \
  -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://10.20.0.11:3000/api/v0/version
```

配置检查应返回 `Syntax OK`，页面应返回 `200`，未登录 RPC 应返回 `401`。B 的命令替换对应 IP；自定义端口也要一并替换。

再从实际客户端网络访问 Web 地址，验证外部防火墙和映射。可使用安装包附带的 Web 验收工具，运行时交互输入 Web 登录密码：

```bash
python3 verify-rpc.py https://10.20.0.11:3000 \
  --ca-file /本机收到的/IFShare-CA.crt
```

需要验证视频范围读取和 CID 检查通路时，提供一个该节点可获取、至少 16 字节的普通文件 CID：

```bash
python3 verify-rpc.py https://10.20.0.11:3000 \
  --ca-file /本机收到的/IFShare-CA.crt \
  --content-cid 实际文件CID --content-name acceptance.txt
```

该工具检查未登录拦截、错误密码、登录和退出、RPC、上传请求转发、Origin 校验，以及可选的网关范围读取和原始块读取。上传检查使用 `only-hash`，不会向节点新增文件或 pin。

### 8.4 页面功能验收

| 功能 | 预期结果 |
| --- | --- |
| 登录和刷新 | 登录后进入主页，刷新先显示连接状态，节点可用时不闪现错误页 |
| 文件管理 | 上传、进入目录、下载均可完成；页面无横向溢出 |
| CID 浏览和检查 | 有效 CID 可以加载；目录、文件及原始块请求可经服务器转发 |
| 图片与视频 | 正常预览，视频可拖动播放位置 |
| 文本与代码 | 文本可预览并按识别类型高亮；二进制内容提示下载 |
| ZIP、7z、RAR、TAR.GZ、TAR | 点击后显示读取及解压进度，完成后列出包内文件并可单独下载 |
| 多文件下载得到的 TAR | 再上传并打开时可以正常识别和解压 |
| 离开压缩包预览 | 取消未完成操作并释放会话资源；重新打开可重新解压 |
| 手机或小屏设备 | 控件和列表可自适应，只需上下滚动 |
| 退出登录 | 服务器 RPC 和网关不再接受该会话访问 |

生产页面中的文件预览先尝试当前访问设备的本地网关，默认 `http://127.0.0.1:8080`；本地不可用、无该内容或浏览器限制本地访问时，回退服务器。这里的 `127.0.0.1` 指使用者的设备，和服务器内部的环回网关不是同一台机器。预览页的连接节点标识可用于检查实际来源。

服务器文件列表和 RPC 仍由服务器节点处理。本地网关优先不代表自动切换文件管理节点，也不要求另外开放服务器 `8080`。

在线解压在浏览器中完成，使用 Worker 和浏览器临时磁盘空间，不会解压到服务器的业务目录。浏览器不支持所需 API、存储不足或压缩内容无法处理时，降级为下载原压缩包。屏幕短边不超过 820 CSS 像素且主要输入为触控的小屏设备，限制压缩包及解压总大小为 100 MiB、文件数为 10,000；桌面不设置应用层文件大小、文件数和总解压时间上限，仍受浏览器配额、解码器和实际可用资源约束。

## 9 运行维护与配置位置

### 9.1 服务命令

```bash
sudo systemctl status ifshare-node ifshare-web --no-pager
sudo systemctl restart ifshare-node
sudo systemctl restart ifshare-web
sudo journalctl -u ifshare-node -n 100 --no-pager
sudo journalctl -u ifshare-web -n 100 --no-pager
sudo tail -n 100 /var/log/ifshare/apache-error.log
```

临时停止或恢复这套服务：

```bash
sudo systemctl stop ifshare-web ifshare-node
sudo systemctl start ifshare-node ifshare-web
```

需要同时取消开机启动时使用 `sudo systemctl disable --now ifshare-web ifshare-node`，数据目录仍保留。系统服务已启动时，不要再对同一个仓库手工运行第二个 daemon。

### 9.2 配置和数据目录

| 路径 | 用途 |
| --- | --- |
| `/data/ifshare` | 本示例的节点仓库；实际由第一个安装参数决定 |
| `/data/ifshare/swarm.key` | 加入同一私网必须使用的密钥文件 |
| `/opt/ifshare/releases/<版本>/` | 各版本程序、静态页面、脚本与手册 |
| `/opt/ifshare/current` | 当前版本链接 |
| `/etc/ifshare/install.json` | 已安装的地址、端口、存储路径和状态 |
| `/etc/ifshare/node.env` | 节点仓库路径及强制私网、遥测开关环境变量 |
| `/etc/ifshare/apache/httpd.conf` | 独立 Apache 主配置 |
| `/etc/ifshare/apache/site.conf` | 站点、认证、RPC 和网关转发配置 |
| `/etc/ifshare/apache/runtime.conf` | 根据安装参数生成的地址和端口 |
| `/etc/ifshare/apache/users`、`session.key` | 登录密码哈希和会话密钥 |
| `/etc/ifshare/tls/` | HTTPS CA、服务器证书和私钥 |
| `/opt/ifshare/backups/` | 安装器升级前的配置备份，不包含完整业务数据 |

安装器保留已经存在的 `httpd.conf` 和 `site.conf`，新模板有变化时写入对应 `.package-new` 文件供管理员比较。运行参数、节点环境和 systemd 服务由脚本维护。更换地址或端口应重新运行安装脚本，避免只修改其中一处造成证书或 Origin 不匹配。

手工修改 Apache 配置后，先检查再重载：

```bash
sudo /usr/sbin/apache2 -f /etc/ifshare/apache/httpd.conf -t
sudo systemctl reload ifshare-web
```

这里管理的是独立服务 `ifshare-web`，并非发行版默认的 `apache2` 站点服务。

## 10 备份升级与证书续签

### 10.1 业务数据备份

升级前安排维护窗口，备份实际节点仓库、部署配置和服务定义。下面示例需使用第 4 节设置的 `IFSHARE_REPO`，并将 `/backup` 替换为有足够空间的备份位置：

```bash
IFSHARE_BACKUP_DIR="/backup/ifshare/$(date +%Y%m%d-%H%M%S)"
sudo install -d -m 700 "$IFSHARE_BACKUP_DIR"
sudo systemctl stop ifshare-web ifshare-node
sudo tar -czpf "$IFSHARE_BACKUP_DIR/repository.tar.gz" -C "$IFSHARE_REPO" .
sudo tar -czpf "$IFSHARE_BACKUP_DIR/configuration.tar.gz" -C / \
  etc/ifshare \
  etc/systemd/system/ifshare-node.service \
  etc/systemd/system/ifshare-web.service
sudo systemctl start ifshare-node ifshare-web
```

确认备份命令成功并记录当前程序版本和包校验和，再开始升级。仓库及配置备份含节点身份、私网密钥、CA 私钥等敏感材料，应按密钥材料保管。安装器自己的自动配置备份不能替代业务数据备份。

### 10.2 更新程序与页面

校验新包并解压到新的空目录，在该目录运行安装命令，存储路径沿用原值：

```bash
sudo bash install.sh /data/ifshare 3000 --host 10.20.0.11
```

这会更新节点和 WebUI，保存原有节点身份、密钥、文件数据、登录配置及受保留的 Apache 配置，并重启受管服务。省略可选 API、Gateway、Swarm 端口时保留旧值；第二个必填 Web 端口应明确填写原端口。升级既有同一私网节点时无需再次传入 `--swarm-key`。

失败时安装器会尝试恢复旧版本和配置，结果以最终输出和服务检查为准。仓库启动使用 `--migrate=false`，不会自动迁移数据版本；涉及仓库格式升级或人工数据迁移时，应使用对应版本的迁移与恢复流程，不能仅切换旧二进制就视为完成回滚。

页面发布后重新验证登录、RPC、图片视频、压缩包解压及文件下载。静态资源有版本化路径，刷新页面以加载新 HTML 和脚本。

### 10.3 证书续签和地址变更

```bash
sudo bash /opt/ifshare/current/renew-certificate.sh
```

该命令保留原 CA，重新签发一年期服务器证书，检查 Apache 并重载 Web 服务。CA 默认有效期为十年；服务器证书需要在到期前续签，可由现场管理员纳入既有定时运维流程。脚本不会自动创建续签定时任务。

更换访问域名或 IP 时，重新运行安装器并传入新 `--host`；仅续签证书不会同步修改访问来源规则。重复安装在地址改变或服务器证书不足 30 天时会重新签发服务器证书。

## 11 常见故障定位

| 现象 | 检查顺序 |
| --- | --- |
| 无法 sudo 或提示需要 root | 确认管理员权限；由有权限的管理员执行安装 |
| 存储目录被拒绝 | 使用专用绝对路径，检查是否已有非受管数据及父目录权限；不要删除业务数据来绕过检查 |
| 端口占用 | 用 `sudo ss -lntp` 确认占用者，为本实例选择其他空闲端口并同步网络规则 |
| Web 外部无法连接，本机正常 | 检查实际访问 IP、Web 端口、主机防火墙、安全组、NAT 映射和 DNS |
| 证书不可信或名称不匹配 | 检查客户端信任的 CA、访问地址与 `--host` 是否一致、证书日期和设备时间 |
| Web 可打开，RPC 返回 401 | 检查是否已登录对应站点、会话是否过期以及浏览器是否接受安全 Cookie |
| 登录成功但 RPC 返回 403 | 核对 `runtime.conf` 的 Origin、浏览器实际地址和 `site.conf` 的 Origin/Referer 转发规则 |
| RPC 或网关返回 502、503 | 检查节点服务、环回监听地址及 Apache 使用的 API/Gateway 端口 |
| peer 列表为空 | 核对共同密钥、对端实际 Swarm TCP 端口、IP、Peer ID、Bootstrap 和网络放行；执行一次 `swarm connect` |
| TCP 可达但握手失败 | 比较 `swarm.key` 摘要，确认身份独立及私网启动环境；查看双方节点日志 |
| 内网地址连接被过滤 | 检查旧仓库的 `Swarm.AddrFilters` 及是否套用了阻止私有地址的 `server` 配置档 |
| 能互连但 CID 无法获取 | 确认至少一个可达节点持有完整内容；先用小文件直接连接测试，再检查路由和提供者情况 |
| B 能下载却看不到文件列表项 | 在 B 的 MFS 中添加文件或目录引用，参见第 7 节 |
| 删除 A 后 B 无法继续提供内容 | 确认 B 已完成需要的完整 pin；读取过部分内容不代表完整持久副本 |
| 在线解压不可用 | 检查 HTTPS 信任、浏览器存储能力、磁盘配额和小屏限制；必要时下载原包 |
| 本地开发页面对 TAR 仍报格式错误 | 确认已更新解压脚本和构建配置；构建配置变动后重启开发服务；生产部署应更新完整静态资源 |
| 刷新仍出现旧页面 | 检查实际发布目录、`current` 链接和加载资源版本，刷新页面后再验收 |

排障时只操作本次部署的仓库和服务。不要为了测试不同私网密钥而修改运行中的业务节点；隔离测试应使用独立仓库和非默认端口。

## 12 交付验收记录

交付时填写实际信息，密钥只记录位置和摘要，不把内容写入本记录。

| 验收项 | 合格标准 | 实际记录 |
| --- | --- | --- |
| 发布包 | 文件名、SHA-256、manifest 中的节点和 WebUI 提交明确 | 待填写 |
| 服务器条件 | 系统架构、systemd、权限、磁盘满足要求 | 待填写 |
| 访问地址 | A、B 的 Web、SSH、Swarm 地址及内外端口已记录 | 待填写 |
| 网络规则 | 客户端到 Web、节点到 Swarm 可达；RPC/Gateway 保持环回 | 待填写 |
| 私网身份 | 两节点 Peer ID 不同，`swarm.key` 摘要相同 | 待填写 |
| 密钥保管 | 正式路径、备份路径、责任人明确 | 待填写 |
| 服务启动 | 两服务 active，按计划启用开机启动 | 待填写 |
| 连接和重启 | peer 列表包含对端，重启后身份和连接正常 | 待填写 |
| 跨节点数据 | 验收 CID、SHA-256、负责副本的节点和 pin 状态明确 | 待填写 |
| Web 文件可见性 | B 添加 MFS 引用后列表可见，文件夹只处理根 CID | 待填写 |
| HTTPS 和登录 | 证书可信，登录退出和未授权请求拦截正常 | 待填写 |
| 页面功能 | 图片视频、代码、5 种压缩包及包内下载正常 | 待填写 |
| 运维安排 | 备份、恢复、升级、密钥和证书续签责任人明确 | 待填写 |

