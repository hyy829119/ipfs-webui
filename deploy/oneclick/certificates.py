#!/usr/bin/env python3
"""Create or renew the deployment's TLS leaf certificate without replacing its CA."""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def validate_host(value):
    try:
        address = ipaddress.ip_address(value)
        if address.version != 4:
            raise ValueError('当前部署脚本的 --host 使用 IPv4 地址或域名。')
        return str(address)
    except ValueError:
        if re.fullmatch(r'[0-9.]+', value):
            raise ValueError('无效 IPv4 地址。')
        if len(value) > 253 or not re.fullmatch(r'(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*', value):
            raise ValueError('--host 必须是 IPv4 地址或域名，不包含协议、端口或路径。')
        if any(label.endswith('-') or len(label) > 63 for label in value.split('.')):
            raise ValueError('无效域名。')
        return value.lower()


def openssl(*args):
    result = subprocess.run(['openssl', *map(str, args)], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('OpenSSL 执行失败: ' + result.stderr.strip())
    return result.stdout.strip()


def ensure_certificate(directory, host, renew=False):
    host = validate_host(host)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    ca_key, ca_cert = directory / 'ca.key', directory / 'ca.crt'
    if ca_key.exists() != ca_cert.exists():
        raise RuntimeError('CA 文件不完整；为避免覆盖已使用的 CA，已停止。请恢复 ca.key 和 ca.crt。')
    with tempfile.TemporaryDirectory(prefix='.certificate-', dir=directory) as temporary:
        temporary = Path(temporary)
        if not ca_key.exists():
            config = temporary / 'ca.cnf'
            config.write_text('''[req]
prompt=no
distinguished_name=dn
x509_extensions=ca
[dn]
CN=IFShare Private CA
O=IFShare
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
''')
            openssl('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650',
                    '-config', config, '-keyout', temporary / 'ca.key', '-out', temporary / 'ca.crt')
            for name in ['ca.key', 'ca.crt']:
                (temporary / name).chmod(0o600)
                os.replace(temporary / name, directory / name)
        server_key, server_cert = directory / 'server.key', directory / 'server.crt'
        metadata = directory / 'certificate.json'
        old_host = json.loads(metadata.read_text()).get('host') if metadata.exists() else None
        if server_key.exists() and server_cert.exists() and old_host == host and not renew:
            expiry = subprocess.run(['openssl', 'x509', '-in', str(server_cert), '-checkend', '2592000', '-noout'], capture_output=True)
            if expiry.returncode == 0:
                openssl('verify', '-CAfile', ca_cert, server_cert)
                return ca_cert
        try:
            ipaddress.ip_address(host)
            subject = 'IP:' + host
        except ValueError:
            subject = 'DNS:' + host
        extension = temporary / 'server.ext'
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
                             'extendedKeyUsage=serverAuth\nsubjectAltName=' + subject + ',DNS:localhost,IP:127.0.0.1\n'
                             'authorityKeyIdentifier=keyid,issuer\nsubjectKeyIdentifier=hash\n')
        openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=' + host + '/O=IFShare',
                '-keyout', temporary / 'server.key', '-out', temporary / 'server.csr')
        openssl('x509', '-req', '-sha256', '-days', '365', '-in', temporary / 'server.csr', '-CA', ca_cert,
                '-CAkey', ca_key, '-CAcreateserial', '-extfile', extension, '-out', temporary / 'server.crt')
        openssl('verify', '-CAfile', ca_cert, temporary / 'server.crt')
        for name in ['server.key', 'server.crt']:
            (temporary / name).chmod(0o600)
            os.replace(temporary / name, directory / name)
        metadata.write_text(json.dumps({'host': host}) + '\n')
        metadata.chmod(0o600)
    return ca_cert


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', help='确认安装时的 IPv4 或域名；默认使用已保存地址')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('请使用 sudo 执行证书续签。')
    settings = json.loads(Path('/etc/ifshare/install.json').read_text())
    host = args.host or settings['host']
    if host != settings['host']:
        parser.error('更换访问地址请重新运行 install.sh 并传入 --host，以同步 Apache 的来源校验。')
    with open('/run/lock/ifshare-install.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('另一个 IFShare 安装或证书续签正在执行。')
        files = [Path('/etc/ifshare/tls') / name for name in ['server.key', 'server.crt', 'certificate.json']]
        previous = {file: file.read_bytes() for file in files}
        try:
            ca = ensure_certificate('/etc/ifshare/tls', host, renew=True)
            subprocess.run(['/usr/sbin/apache2', '-f', '/etc/ifshare/apache/httpd.conf', '-t'], check=True)
            subprocess.run(['systemctl', 'reload', 'ifshare-web.service'], check=True)
            shutil.copyfile(ca, '/opt/ifshare/IFShare-CA.crt')
            Path('/opt/ifshare/IFShare-CA.crt').chmod(0o644)
        except (RuntimeError, OSError, subprocess.SubprocessError):
            for file, content in previous.items():
                file.write_bytes(content)
                file.chmod(0o600)
            raise
    print('HTTPS 服务器证书已续签一年并重载；CA 保持不变。')
    print('CA 证书: /opt/ifshare/IFShare-CA.crt')


if __name__ == '__main__':
    main()
