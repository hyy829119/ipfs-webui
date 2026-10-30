import argparse
import hashlib
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from certificates import ensure_certificate, openssl, validate_host
from installer import check_ports, environment_value, port_number, storage_path, validate_swarm_key, verify_payload


class InputChecks(unittest.TestCase):
    def test_port_range(self):
        self.assertEqual(port_number('3000'), 3000)
        for value in ['0', '-1', '65536', 'http', '30.5']:
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                port_number(value)

    def test_storage_requires_dedicated_absolute_directory(self):
        for value in ['data', '/', '/var', '/etc/data', '/opt/ifshare/data', '/data/line\nbreak']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                storage_path(value)
        self.assertEqual(storage_path('/data/with space'), Path('/data/with space'))

    def test_host_cannot_inject_configuration(self):
        self.assertEqual(validate_host('111.10.164.175'), '111.10.164.175')
        self.assertEqual(validate_host('Files.EXAMPLE.com'), 'files.example.com')
        for value in ['https://example.com', 'example.com:3000', '999.1.2.3', '::1', 'host\nListen 80', 'a-.com', '-x.com']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_host(value)

    def test_swarm_key_normalization_and_rejection(self):
        key = b'/key/swarm/psk/1.0.0/\n/base16/\n' + b'ab' * 32 + b'\n'
        self.assertEqual(validate_swarm_key(key), validate_swarm_key(key.replace(b'\n', b'\r\n')))
        for content in [b'', key[:-20], key.replace(b'ab', b'xx'), key + b'not a key']:
            with self.subTest(content_length=len(content)), self.assertRaises(ValueError):
                validate_swarm_key(content)

    def test_environment_path_quotes(self):
        self.assertEqual(environment_value('/data/my files'), '"/data/my files"')
        self.assertEqual(environment_value('/data/a"b'), '"/data/a\\"b"')

    def test_occupied_ipv4_port_is_rejected(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(ValueError, '已被占用'):
                check_ports({'web_port': port}, None)
            with patch('installer.is_active', return_value=True):
                check_ports({'web_port': port}, {'web_port': port})
            with patch('installer.is_active', return_value=False), self.assertRaises(ValueError):
                check_ports({'web_port': port}, {'web_port': port})

    @unittest.skipUnless(socket.has_ipv6, 'IPv6 unavailable')
    def test_occupied_ipv6_port_is_rejected(self):
        with socket.socket(socket.AF_INET6) as listener:
            listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            listener.bind(('::1', 0))
            listener.listen()
            with self.assertRaisesRegex(ValueError, '已被占用'):
                check_ports({'web_port': listener.getsockname()[1]}, None)


class PayloadChecks(unittest.TestCase):
    def test_corrupted_or_unlisted_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            names = ['installer.py', 'certificates.py', 'install.sh', 'renew-certificate.sh',
                     'web/index.html', 'web/auth/session.json', 'apache/httpd.conf', 'apache/site.conf']
            for name in names:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('payload')
            (root / 'bin').mkdir()
            (root / 'bin/ifshare').write_bytes(b'\x7fELF\x02' + bytes(13) + b'\x3e\x00')
            (root / 'manifest.json').write_text(json.dumps({'release': 'test', 'platform': 'linux-amd64'}))
            (root / 'SHA256SUMS').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  '
                                                  + file.relative_to(root).as_posix() + '\n'
                                                  for file in root.rglob('*') if file.is_file()))
            self.assertEqual(verify_payload(root)['release'], 'test')
            (root / 'extra.sh').write_text('extra')
            with self.assertRaisesRegex(ValueError, '未校验'):
                verify_payload(root)
            (root / 'extra.sh').unlink()
            (root / 'bin/ifshare').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, '校验失败'):
                verify_payload(root)


class CertificateChecks(unittest.TestCase):
    def test_reinstall_preserves_ca_and_renewal_changes_leaf(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ensure_certificate(root, '10.10.1.125')
            ca = (root / 'ca.crt').read_bytes()
            ca_key = (root / 'ca.key').read_bytes()
            leaf = (root / 'server.crt').read_bytes()
            ensure_certificate(root, '10.10.1.125')
            self.assertEqual((root / 'server.crt').read_bytes(), leaf)
            ensure_certificate(root, '10.10.1.125', renew=True)
            self.assertNotEqual((root / 'server.crt').read_bytes(), leaf)
            self.assertEqual((root / 'ca.crt').read_bytes(), ca)
            self.assertEqual((root / 'ca.key').read_bytes(), ca_key)
            self.assertEqual((root / 'server.key').stat().st_mode & 0o777, 0o600)
            openssl('verify', '-CAfile', root / 'ca.crt', root / 'server.crt')
            ensure_certificate(root, 'files.example.com')
            details = openssl('x509', '-in', root / 'server.crt', '-noout', '-text')
            self.assertIn('DNS:files.example.com', details)
            self.assertEqual((root / 'ca.crt').read_bytes(), ca)

    def test_partial_ca_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'ca.key').write_text('existing key')
            with self.assertRaisesRegex(RuntimeError, 'CA 文件不完整'):
                ensure_certificate(root, 'example.com')
            self.assertEqual((root / 'ca.key').read_text(), 'existing key')


if __name__ == '__main__':
    unittest.main()
