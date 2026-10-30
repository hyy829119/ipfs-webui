#!/usr/bin/env python3
"""Install the prebuilt IFShare private node and its authenticated HTTPS WebUI."""
import argparse
import datetime
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import time

from certificates import ensure_certificate, validate_host

PACKAGE = Path(__file__).resolve().parent
ROOT = Path('/opt/ifshare')
CONFIG = Path('/etc/ifshare')
SETTINGS = CONFIG / 'install.json'
UNITS = ('ifshare-node.service', 'ifshare-web.service')


def run(command, *, env=None, input=None, quiet=False, check=True, timeout=120):
    result = subprocess.run([str(arg) for arg in command], env=env, input=input,
                            text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        # Do not echo argv: authentication tools may receive secrets on stdin.
        raise RuntimeError(f'{Path(command[0]).name} 执行失败: {result.stderr.strip() or result.stdout.strip()}')
    if not quiet and result.stdout.strip():
        print(result.stdout.strip(), flush=True)
    return result


def write(path, content, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.install-tmp')
    temporary.write_text(content)
    temporary.chmod(mode)
    os.replace(temporary, path)


def port_number(value):
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('端口必须是 1～65535 的整数。')
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError('端口必须是 1～65535 的整数。')
    return port


def storage_path(value):
    path = Path(value)
    if not path.is_absolute() or any(ord(c) < 32 for c in value):
        raise ValueError('存储目录必须是绝对路径，且不能包含控制字符。')
    path = path.resolve()
    forbidden = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys',
                 '/dev', '/run', '/boot', '/opt/ifshare', '/var/log', '/var/www']
    if path in {Path(p).resolve() for p in ['/', '/var', '/var/lib', '/opt', '/home', '/root', '/tmp']}:
        raise ValueError('请指定专用于 IFShare 的子目录，例如 /data/ifshare。')
    if any(path == Path(p).resolve() or Path(p).resolve() in path.parents for p in forbidden):
        raise ValueError('存储目录不能位于系统目录或 IFShare 程序/配置目录内。')
    return path


def validate_swarm_key(content):
    if not re.fullmatch(rb'/key/swarm/psk/1\.0\.0/\r?\n/base16/\r?\n[0-9a-fA-F]{64}\r?\n?', content):
        raise ValueError('swarm.key 格式无效；需要 /key/swarm/psk/1.0.0/、/base16/ 和 64 位十六进制密钥。')
    return content.replace(b'\r\n', b'\n').strip().lower()


def default_host():
    # No external IP discovery service: use the host's configured IPv4 address.
    addresses = run(['hostname', '-I'], quiet=True).stdout.split()
    for address in addresses:
        try:
            if ipaddress.ip_address(address).version == 4:
                return address
        except ValueError:
            pass
    return '127.0.0.1'


def verify_payload(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('platform') != 'linux-amd64' or not re.fullmatch(r'[a-zA-Z0-9_.-]+', manifest.get('release', '')):
        raise ValueError('安装包平台或版本标识无效。')
    checksums = {}
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        digest, filename = line.split('  ', 1)
        relative = Path(filename)
        if relative.is_absolute() or '..' in relative.parts or relative.as_posix() in checksums:
            raise ValueError('安装包校验清单路径无效。')
        file = directory / relative
        if file.is_symlink() or not file.is_file():
            raise ValueError('安装包文件缺失或包含符号链接: ' + filename)
        actual = sha256(file)
        if actual != digest:
            raise ValueError('安装包校验失败: ' + filename)
        checksums[relative.as_posix()] = digest
    required = ['manifest.json', 'installer.py', 'certificates.py', 'install.sh',
                'renew-certificate.sh', 'bin/ifshare', 'web/index.html', 'web/auth/session.json',
                'apache/httpd.conf', 'apache/site.conf']
    if any(name not in checksums for name in required):
        raise ValueError('安装包缺少必要的校验项。')
    # Reject unlisted payload files as well as missing files.
    files = {file.relative_to(directory).as_posix() for file in directory.rglob('*')
             if file.is_file() and '__pycache__' not in file.parts and file != directory / 'SHA256SUMS'}
    if files != set(checksums):
        raise ValueError('安装包中存在未校验的文件。请重新解压原始安装包。')
    with (directory / 'bin/ifshare').open('rb') as binary:
        header = binary.read(20)
    if header[:5] != b'\x7fELF\x02' or header[18:20] != b'\x3e\x00':
        raise ValueError('ifshare 不是 Linux x86_64 可执行程序。')
    return manifest


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def is_active(unit):
    return run(['systemctl', 'is-active', '--quiet', unit], quiet=True, check=False).returncode == 0


def check_ports(ports, old):
    for name, port in ports.items():
        unit = UNITS[1] if name == 'web_port' else UNITS[0]
        if old and old.get(name) == port and is_active(unit):
            continue
        for family, address in [(socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')]:
            if family == socket.AF_INET6 and not socket.has_ipv6:
                continue
            try:
                listener = socket.socket(family, socket.SOCK_STREAM)
            except OSError:
                if family == socket.AF_INET6:
                    continue
                raise
            with listener:
                if family == socket.AF_INET6:
                    listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                try:
                    listener.bind((address, port))
                    listener.listen(1)
                except OSError as error:
                    if error.errno in (97, 99) and family == socket.AF_INET6:
                        continue
                    raise ValueError(f'{name}={port} 已被占用或无法绑定，请选择空闲端口。') from error


def install_dependencies():
    packages = ['python3', 'apache2-bin', 'apache2-utils', 'openssl', 'ca-certificates', 'curl', 'media-types']
    missing = []
    for package in packages:
        status = run(['dpkg-query', '-W', '-f=${Status}', package], quiet=True, check=False)
        if status.returncode or status.stdout.strip() != 'install ok installed':
            missing.append(package)
    if missing:
        print('安装系统依赖: ' + ', '.join(missing), flush=True)
        env = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
        run(['apt-get', 'update'], env=env, quiet=True, timeout=900)
        # apache2-bin contains the executable/modules without enabling a default port-80 site.
        run(['apt-get', 'install', '-y', '--no-install-recommends', *missing], env=env, quiet=True, timeout=900)


def node_command(binary, storage, *args):
    env = dict(os.environ, IPFS_PATH=str(storage), LIBP2P_FORCE_PNET='1', IPFS_TELEMETRY='off', DO_NOT_TRACK='1')
    return run(['runuser', '-u', 'ifshare', '--', binary, *args], env=env, quiet=True)


def configure_node(binary, settings, bootstrap, fresh):
    storage = Path(settings['storage'])
    if fresh:
        node_command(binary, storage, 'init', '--empty-repo', '--profile=autoconf-off')
    config = {
        'Addresses.Swarm': [f'/ip4/0.0.0.0/tcp/{settings["swarm_port"]}'],
        'Addresses.API': f'/ip4/127.0.0.1/tcp/{settings["api_port"]}',
        'Addresses.Gateway': f'/ip4/127.0.0.1/tcp/{settings["gateway_port"]}',
        'Swarm.Transports.Network.Websocket': False,
        'Swarm.DisableNatPortMap': True,
        'AutoTLS.Enabled': False,
        'Discovery.MDNS.Enabled': False,
        'Routing.Type': 'dht',
        'AutoConf.Enabled': False,
        'Plugins.Plugins.telemetry.Config.Mode': 'off',
        'API.HTTPHeaders.Access-Control-Allow-Origin': [f'http://127.0.0.1:{settings["api_port"]}'],
        'API.HTTPHeaders.Access-Control-Allow-Methods': ['PUT', 'POST'],
    }
    for key, value in config.items():
        node_command(binary, storage, 'config', '--json', key, json.dumps(value))
    for address in bootstrap:
        node_command(binary, storage, 'bootstrap', 'add', address)


def environment_value(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def install_configs(settings):
    apache = CONFIG / 'apache'
    apache.mkdir(exist_ok=True, mode=0o750)
    shutil.chown(apache, user='root', group='www-data')
    for name in ['httpd.conf', 'site.conf']:
        content = (PACKAGE / 'apache' / name).read_text()
        destination = apache / name
        if not destination.exists():
            write(destination, content)
        elif destination.read_text() != content:
            write(destination.with_suffix(destination.suffix + '.package-new'), content)
            print('保留已有配置；新版参考文件: ' + str(destination) + '.package-new', flush=True)
    write(apache / 'runtime.conf', '\n'.join([
        '# Generated by install.sh; host and ports are set by installer arguments.',
        f'Define IFSHARE_HOST {settings["host"]}',
        f'Define IFSHARE_WEB_PORT {settings["web_port"]}',
        f'Define IFSHARE_API_PORT {settings["api_port"]}',
        f'Define IFSHARE_GATEWAY_PORT {settings["gateway_port"]}',
        f'Define IFSHARE_ORIGIN {settings["origin"]}', '',
    ]))
    users = apache / 'users'
    if not users.exists():
        run(['htpasswd', '-i', '-B', '-c', users, 'admin'], input='123456\n', quiet=True)
    secret = apache / 'session.key'
    if not secret.exists():
        write(secret, secrets.token_hex(48) + '\n', 0o640)
    for file in [users, secret]:
        file.chmod(0o640)
        shutil.chown(file, user='root', group='www-data')
    ca = ensure_certificate(CONFIG / 'tls', settings['host'])
    shutil.copyfile(ca, ROOT / 'IFShare-CA.crt')
    (ROOT / 'IFShare-CA.crt').chmod(0o644)
    write(CONFIG / 'node.env', 'IPFS_PATH=' + environment_value(settings['storage']) + '\n'
          'LIBP2P_FORCE_PNET=1\nIPFS_TELEMETRY=off\nDO_NOT_TRACK=1\n', 0o600)
    write('/etc/systemd/system/ifshare-node.service', '''[Unit]
Description=IFShare private storage node
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=ifshare
Group=ifshare
EnvironmentFile=/etc/ifshare/node.env
ExecStart=/opt/ifshare/current/bin/ifshare daemon --migrate=false
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
KillSignal=SIGINT
UMask=0077
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
''')
    write('/etc/systemd/system/ifshare-web.service', '''[Unit]
Description=IFShare HTTPS WebUI (standalone Apache)
Wants=network-online.target ifshare-node.service
After=network-online.target ifshare-node.service
[Service]
Type=simple
RuntimeDirectory=ifshare-web
ExecStartPre=/usr/sbin/apache2 -f /etc/ifshare/apache/httpd.conf -t
ExecStart=/usr/sbin/apache2 -f /etc/ifshare/apache/httpd.conf -DFOREGROUND
ExecReload=/usr/sbin/apache2 -f /etc/ifshare/apache/httpd.conf -k graceful
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
PrivateTmp=true
[Install]
WantedBy=multi-user.target
''')
    Path('/var/log/ifshare').mkdir(exist_ok=True, mode=0o750)
    Path('/run/ifshare-web').mkdir(exist_ok=True)


def wait_ready(settings):
    api = f'http://127.0.0.1:{settings["api_port"]}/api/v0/version'
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        result = run(['curl', '--silent', '--show-error', '--fail', '--max-time', '2', '-X', 'POST', api],
                     quiet=True, check=False, timeout=5)
        if result.returncode == 0:
            json.loads(result.stdout)
            break
        time.sleep(1)
    else:
        raise RuntimeError('节点启动超时；请查看 journalctl -u ifshare-node.service。')
    # Verify TLS with the generated CA and the real public Host/SNI, without relying on NAT hairpin routing.
    base = ['curl', '--silent', '--show-error', '--fail', '--noproxy', '*', '--max-time', '10',
            '--cacert', str(ROOT / 'IFShare-CA.crt'),
            '--resolve', f'{settings["host"]}:{settings["web_port"]}:127.0.0.1']
    run([*base, settings['origin'] + '/'], quiet=True)
    result = run([*base, '--write-out', '%{http_code}', '--output', '/dev/null',
                  '-X', 'POST', settings['origin'] + '/api/v0/version'], quiet=True, check=False)
    if result.stdout != '401':
        raise RuntimeError('Web RPC 匿名访问保护检查失败。')
    for unit in UNITS:
        if not is_active(unit):
            raise RuntimeError(unit + ' 未正常运行。')


def symlink_release(target):
    temporary = ROOT / '.current-install'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, ROOT / 'current')


def copy_owned(source, destination):
    result = shutil.copy2(source, destination)
    metadata = Path(source).stat()
    os.chown(result, metadata.st_uid, metadata.st_gid)
    return result


def copy_config_tree(source, destination):
    # copy2 preserves permissions, but not uid/gid. Apache's worker must retain
    # group access to its password and session files after rollback.
    shutil.copytree(source, destination, copy_function=copy_owned)
    for directory in [source, *(path for path in source.rglob('*') if path.is_dir())]:
        metadata = directory.stat()
        os.chown(destination / directory.relative_to(source), metadata.st_uid, metadata.st_gid)


def snapshot(storage):
    destination = ROOT / 'backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination.mkdir(parents=True, mode=0o700)
    copy_config_tree(CONFIG, destination / 'etc')
    shutil.copy2(storage / 'config', destination / 'node-config')
    for unit in UNITS:
        shutil.copy2(Path('/etc/systemd/system') / unit, destination / unit)
    return destination


def finish(settings, binary):
    identity = json.loads((Path(settings['storage']) / 'config').read_text())['Identity']['PeerID']
    host = settings['host']
    kind = 'ip4' if re.fullmatch(r'\d+\.\d+\.\d+\.\d+', host) else 'dns4'
    print('\n安装和启动完成。', flush=True)
    print('WebUI: ' + settings['origin'])
    print('首次安装账号: admin，密码: 123456（重装保留已有密码）')
    print('文件/节点存储目录: ' + settings['storage'])
    print('私有网络密钥文件: ' + str(Path(settings['storage']) / 'swarm.key'))
    print('其他节点加入此私网时，必须安全复制并使用同一份 swarm.key；各节点需独立初始化，不能复制 Identity 私钥。')
    print(f'引导地址示例: /{kind}/{host}/tcp/{settings["swarm_port"]}/p2p/{identity}')
    print('引导地址必须使用其他节点可达的 IP/域名和 Swarm TCP 端口；有 NAT 时按实际映射修改。')
    print('客户端需信任的 CA 证书: /opt/ifshare/IFShare-CA.crt（请通过可信渠道分发）')
    print('证书续签: sudo bash /opt/ifshare/current/renew-certificate.sh')
    print('Apache 配置: /etc/ifshare/apache/httpd.conf 和 /etc/ifshare/apache/site.conf')
    print('服务状态: systemctl status ifshare-node ifshare-web')
    print('后台 CLI: ' + shlex.join(['sudo', '-u', 'ifshare', 'env', 'IPFS_PATH=' + settings['storage'], str(binary), 'id']))
    print('请在防火墙/端口映射中开放 Web TCP ' + str(settings['web_port']) + '；节点互连还需开放 Swarm TCP ' + str(settings['swarm_port']) + '。')


def install(args):
    if os.geteuid() != 0:
        raise ValueError('需要 root 权限安装 Apache 和系统服务。请由管理员运行 sudo bash install.sh <存储目录> <Web端口>。')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise ValueError('此安装包仅支持 Linux x86_64/amd64。')
    if not Path('/run/systemd/system').is_dir():
        raise ValueError('需要使用 systemd 启动的 Linux 系统；普通容器请使用提供的 systemd 测试环境。')
    os_release = Path('/etc/os-release').read_text()
    if not re.search(r'^ID=(?:"?)(ubuntu|debian)(?:"?)$', os_release, re.M):
        raise ValueError('此脚本支持 Debian/Ubuntu；客户 Ubuntu 22.04 环境适用。')
    manifest = verify_payload(PACKAGE)
    old = json.loads(SETTINGS.read_text()) if SETTINGS.exists() else None
    storage = storage_path(args.storage)
    if storage.exists() and not storage.is_dir():
        raise ValueError('存储路径已存在，但不是目录: ' + str(storage))
    ancestor = storage
    while not ancestor.exists():
        ancestor = ancestor.parent
    if not ancestor.is_dir() or not os.access(ancestor, os.W_OK | os.X_OK):
        raise ValueError('存储目录或其上级目录不可写: ' + str(ancestor))
    if old and old['storage'] != str(storage):
        raise ValueError('已有安装使用 ' + old['storage'] + '；脚本不会自动迁移或切换数据目录。请先停机备份并迁移。')
    if not old:
        for directory in [ROOT, CONFIG, storage]:
            if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
                raise ValueError('目录已有数据但不是本脚本管理的安装，已停止以避免覆盖: ' + str(directory))
        for unit in UNITS:
            state = run(['systemctl', 'show', '-p', 'LoadState', '--value', unit], quiet=True, check=False).stdout.strip()
            if state != 'not-found':
                raise ValueError('检测到已有同名系统服务，已停止: ' + unit)
    settings = {'storage': str(storage), 'web_port': args.web_port, 'release': manifest['release']}
    settings['host'] = validate_host(args.host or (old or {}).get('host') or default_host())
    for key in ['api_port', 'gateway_port', 'swarm_port']:
        settings[key] = getattr(args, key) or (old or {}).get(key) or {'api_port': 5001, 'gateway_port': 8080, 'swarm_port': 4001}[key]
    ports = {key: value for key, value in settings.items() if key.endswith('_port')}
    if len(set(ports.values())) != len(ports):
        raise ValueError('Web、RPC、Gateway、Swarm 四个端口必须不同。')
    settings['origin'] = f'https://{settings["host"]}' + (f':{args.web_port}' if args.web_port != 443 else '')
    check_ports(ports, old)
    print('目录检查: ' + str(storage) + ('（已存在，将校验访问权限）' if storage.exists() else '（不存在，将自动创建）'), flush=True)
    print('端口检查通过: ' + ', '.join(f'{name}={port}' for name, port in ports.items()), flush=True)
    key = storage / 'swarm.key'
    imported = Path(args.swarm_key).read_bytes() if args.swarm_key else None
    if imported is not None:
        validate_swarm_key(imported)
    if key.exists():
        current = validate_swarm_key(key.read_bytes())
        if imported is not None and current != validate_swarm_key(imported):
            raise ValueError('现有 swarm.key 与传入密钥不一致，已停止；不会替换已有私网密钥。')
    elif old and (storage / 'config').exists():
        raise ValueError('已有节点缺少 swarm.key。请恢复原密钥后重试；不会自动创建另一私网。')
    for address in args.bootstrap:
        if not re.fullmatch(r'/(ip4|dns4)/[^/\s]+/tcp/[0-9]+/p2p/[A-Za-z0-9]+', address):
            raise ValueError('--bootstrap 需要 /ip4/IP/tcp/端口/p2p/PeerID 或 /dns4/域名/tcp/端口/p2p/PeerID。')
    print('校验通过；准备部署 ' + settings['origin'] + '，数据目录 ' + str(storage), flush=True)
    install_dependencies()
    try:
        account = pwd.getpwnam('ifshare')
        if account.pw_uid == 0 or account.pw_shell not in ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false']:
            raise ValueError('已有 ifshare 用户不是预期的服务账号，已停止。')
    except KeyError:
        run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'ifshare'], quiet=True)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o755)
    for directory in [ROOT, CONFIG]:
        directory.chmod(0o755)
        shutil.chown(directory, user='root', group='root')
    storage.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.chown(storage, user='ifshare', group='ifshare')
    storage.chmod(0o700)
    if run(['runuser', '-u', 'ifshare', '--', 'test', '-w', storage], quiet=True, check=False).returncode:
        raise ValueError('ifshare 服务用户无法访问存储目录，请检查父目录的执行/遍历权限: ' + str(storage))
    release = ROOT / 'releases' / manifest['release']
    release.parent.mkdir(exist_ok=True)
    if release.exists():
        if sha256(release / 'SHA256SUMS') != sha256(PACKAGE / 'SHA256SUMS'):
            raise ValueError('同名版本的文件校验清单不同，请使用新的安装包版本标识。')
    else:
        temporary = release.with_name(release.name + '.staging')
        if temporary.exists():
            shutil.rmtree(temporary)
        shutil.copytree(PACKAGE, temporary, ignore=shutil.ignore_patterns('__pycache__'))
        # Archives may have been extracted with a restrictive caller umask.
        for entry in temporary.rglob('*'):
            entry.chmod(0o755 if entry.is_dir() else 0o644)
        temporary.chmod(0o755)
        (temporary / 'bin/ifshare').chmod(0o755)
        for script in temporary.glob('*.sh'):
            script.chmod(0o755)
        os.replace(temporary, release)
    binary = release / 'bin/ifshare'
    backup = snapshot(storage) if old and old.get('status') == 'ready' and (storage / 'config').exists() and (ROOT / 'current').is_symlink() else None
    previous = (ROOT / 'current').resolve() if (ROOT / 'current').is_symlink() else None
    active = {unit: is_active(unit) for unit in UNITS}
    enabled = {unit: run(['systemctl', 'is-enabled', '--quiet', unit], quiet=True, check=False).returncode == 0 for unit in UNITS}
    if old:
        run(['systemctl', 'stop', *reversed(UNITS)], quiet=True)
    try:
        if not key.exists():
            value = imported or ('/key/swarm/psk/1.0.0/\n/base16/\n' + secrets.token_hex(32) + '\n').encode()
            key.write_bytes(value)
            key.chmod(0o600)
            shutil.chown(key, user='ifshare', group='ifshare')
        # Record a recoverable installation before node init; retries preserve the generated key.
        write(SETTINGS, json.dumps(dict(settings, status='installing'), indent=2) + '\n', 0o600)
        configure_node(binary, settings, args.bootstrap, fresh=not (storage / 'config').exists())
        install_configs(settings)
        symlink_release(release)
        run(['/usr/sbin/apache2', '-f', CONFIG / 'apache/httpd.conf', '-t'], quiet=True)
        run(['systemctl', 'daemon-reload'], quiet=True)
        run(['systemctl', 'enable', '--now', *UNITS], quiet=True)
        wait_ready(settings)
        write(SETTINGS, json.dumps(dict(settings, status='ready'), indent=2) + '\n', 0o600)
    except Exception as failure:
        run(['systemctl', 'stop', *reversed(UNITS)], quiet=True, check=False)
        if backup:
            shutil.rmtree(CONFIG)
            copy_config_tree(backup / 'etc', CONFIG)
            shutil.copy2(backup / 'node-config', storage / 'config')
            shutil.chown(storage / 'config', user='ifshare', group='ifshare')
            for unit in UNITS:
                shutil.copy2(backup / unit, Path('/etc/systemd/system') / unit)
            symlink_release(previous)
            shutil.copyfile(CONFIG / 'tls/ca.crt', ROOT / 'IFShare-CA.crt')
            run(['systemctl', 'daemon-reload'], quiet=True)
            recovery_errors = []
            for unit in UNITS:
                run(['systemctl', 'enable' if enabled[unit] else 'disable', unit], quiet=True, check=False)
                if active[unit]:
                    result = run(['systemctl', 'start', unit], quiet=True, check=False)
                    if result.returncode:
                        recovery_errors.append(unit)
            if not recovery_errors and all(active.values()):
                try:
                    wait_ready(old)
                except (RuntimeError, OSError, subprocess.SubprocessError) as error:
                    recovery_errors.append(str(error))
            if recovery_errors:
                raise RuntimeError('升级失败，原配置已恢复但服务未恢复正常: ' + ', '.join(recovery_errors)
                                   + '；备份: ' + str(backup) + '；原错误: ' + str(failure)) from failure
            print('本次升级失败，已恢复原版本与配置。备份: ' + str(backup), file=sys.stderr)
        else:
            run(['systemctl', 'disable', *UNITS], quiet=True, check=False)
            print('安装未完成，已停止服务；数据和私网密钥已保留。修复错误后使用相同参数重试。', file=sys.stderr)
        raise
    if backup:
        print('升级前配置备份: ' + str(backup), flush=True)
    finish(settings, ROOT / 'current/bin/ifshare')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('storage', help='文件/节点仓库存储绝对路径，例如 /data/ifshare')
    parser.add_argument('web_port', type=port_number, help='HTTPS Web 监听端口，例如 3000')
    parser.add_argument('--host', help='客户端访问的 IPv4 或域名；默认本机主 IPv4，重装保留原值')
    parser.add_argument('--swarm-key', help='加入已有私网使用的 swarm.key 文件；不传则首次生成')
    parser.add_argument('--bootstrap', action='append', default=[], help='可重复传入私网 TCP 引导节点地址')
    parser.add_argument('--api-port', type=port_number, help='本机 RPC 端口，首次默认 5001')
    parser.add_argument('--gateway-port', type=port_number, help='本机 Gateway 端口，首次默认 8080')
    parser.add_argument('--swarm-port', type=port_number, help='节点互连 TCP 端口，首次默认 4001')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise ValueError('需要 root 权限，请由管理员使用 sudo bash install.sh 执行。')
        with open('/run/lock/ifshare-install.lock', 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('另一个 IFShare 安装或证书续签正在执行。')
            install(args)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print('安装失败: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
