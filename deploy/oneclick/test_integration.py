#!/usr/bin/env python3
"""Run only in the disposable Ubuntu systemd test container after a fresh install."""
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

PACKAGE = Path('/test/ifshare-linux-amd64')
STORAGE = Path('/data/ifshare files')
ORIGIN = 'https://127.0.0.1:18443'
INSTALL = ['bash', str(PACKAGE / 'install.sh'), str(STORAGE), '18443', '--host', '127.0.0.1',
           '--api-port', '15001', '--gateway-port', '18080', '--swarm-port', '14001']
ENV = dict(os.environ, IPFS_PATH=str(STORAGE), LIBP2P_FORCE_PNET='1', IPFS_TELEMETRY='off', DO_NOT_TRACK='1')
BINARY = '/opt/ifshare/current/bin/ifshare'


def command(argv, *, input=None, env=None, check=True, timeout=180):
    result = subprocess.run(list(map(str, argv)), input=input, env=env, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(result.stdout + '\n' + result.stderr)
    return result


def cli(*args, input=None):
    return command(['runuser', '-u', 'ifshare', '--', BINARY, *args], env=ENV, input=input).stdout.strip()


@unittest.skipUnless(os.environ.get('IFSHARE_RUN_INSTALL_TESTS') == '1' and os.environ.get('container') == 'docker',
                     'Requires the explicit disposable-container test environment')
class InstallationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identity = json.loads((STORAGE / 'config').read_text())['Identity']['PeerID']
        cls.key = (STORAGE / 'swarm.key').read_bytes()
        cls.ca = Path('/etc/ifshare/tls/ca.crt').read_bytes()
        cls.password = Path('/etc/ifshare/apache/users').read_bytes()
        cls.session = Path('/etc/ifshare/apache/session.key').read_bytes()
        cls.cid = cli('add', '-Q', '--pin=false', input='IFShare private deployment regression fixture\n')
        cli('files', 'cp', '/ipfs/' + cls.cid, '/deployment-fixture.txt')
        cls.sentinel = subprocess.Popen([sys.executable, '-m', 'http.server', '80', '--bind', '127.0.0.1'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/opt/ifshare/IFShare-CA.crt')))

    @classmethod
    def tearDownClass(cls):
        cls.sentinel.terminate()
        cls.sentinel.wait(timeout=5)

    def request(self, path, data=None, origin=ORIGIN, headers=None):
        values = {'User-Agent': 'Mozilla/5.0 IFShare-Install-Test', 'Origin': origin, 'Referer': ORIGIN + '/'}
        values.update(headers or {})
        request = urllib.request.Request(ORIGIN + path, data=data, headers=values)
        try:
            with self.client.open(request, timeout=15) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def login(self):
        body = urllib.parse.urlencode({'httpd_username': 'admin', 'httpd_password': '123456'}).encode()
        status, body, _ = self.request('/auth/login', body)
        self.assertEqual(status, 200, body)
        self.assertTrue(json.loads(body)['authenticated'])

    def assert_preserved(self):
        self.assertEqual((STORAGE / 'swarm.key').read_bytes(), self.key)
        self.assertEqual(json.loads((STORAGE / 'config').read_text())['Identity']['PeerID'], self.identity)
        self.assertEqual(Path('/etc/ifshare/tls/ca.crt').read_bytes(), self.ca)
        self.assertEqual(Path('/etc/ifshare/apache/users').read_bytes(), self.password)
        self.assertEqual(Path('/etc/ifshare/apache/session.key').read_bytes(), self.session)
        self.assertEqual(cli('files', 'stat', '--hash', '/deployment-fixture.txt'), self.cid)
        command(['systemctl', 'is-active', '--quiet', 'ifshare-node', 'ifshare-web'])
        self.assertIsNone(self.sentinel.poll(), 'Existing port-80 process was stopped')

    def test_01_authenticated_https_rpc_and_gateway(self):
        self.assertEqual(self.request('/api/v0/version', b'')[0], 401)
        wrong = urllib.parse.urlencode({'httpd_username': 'admin', 'httpd_password': 'wrong'}).encode()
        self.assertEqual(self.request('/auth/login', wrong)[0], 401)
        self.login()
        for path in ['/api/v0/version', '/api/v0/stats/bw', '/api/v0/files/ls?arg=/&long=true']:
            status, body, _ = self.request(path, b'')
            self.assertEqual(status, 200, body)
            json.loads(body)
        self.assertEqual(self.request('/api/v0/version', b'', origin='https://foreign.invalid')[0], 403)
        status, body, headers = self.request('/ipfs/' + self.cid, headers={'Range': 'bytes=0-15'})
        self.assertEqual(status, 206)
        self.assertEqual(len(body), 16)
        self.assertIn('sandbox', headers['Content-Security-Policy'])
        self.assertEqual(self.request('/ipfs/' + self.cid + '?format=raw')[0], 200)
        self.assertEqual(self.request('/auth/logout', b'')[0], 200)
        self.assertEqual(self.request('/api/v0/version', b'')[0], 401)

    def test_02_repeat_install_preserves_data_keys_and_custom_apache(self):
        site = Path('/etc/ifshare/apache/site.conf')
        site.write_text(site.read_text() + '\n# customer configuration must survive reinstall\n')
        expected = site.read_bytes()
        result = command(INSTALL)
        self.assertIn(str(STORAGE / 'swarm.key'), result.stdout)
        self.assertEqual(site.read_bytes(), expected)
        self.assertTrue(site.with_suffix('.conf.package-new').exists())
        self.assert_preserved()
        self.login()
        self.assertEqual(self.request('/api/v0/version', b'')[0], 200)

    def test_03_busy_port_and_missing_parameters_are_rejected(self):
        self.assertNotEqual(command(INSTALL[:2], check=False).returncode, 0)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 18444))
            listener.listen()
            args = INSTALL.copy()
            args[3] = '18444'
            result = command(args, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('已被占用', result.stderr)
        args = INSTALL.copy()
        args[3] = '65536'
        self.assertNotEqual(command(args, check=False).returncode, 0)
        self.assert_preserved()

    def test_04_wrong_private_key_is_rejected(self):
        wrong = Path('/test/wrong-swarm.key')
        wrong.write_text('/key/swarm/psk/1.0.0/\n/base16/\n' + '00' * 32 + '\n')
        result = command([*INSTALL, '--swarm-key', wrong], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('不一致', result.stderr)
        self.assert_preserved()

    def test_05_renewal_keeps_trusted_ca(self):
        old_leaf = Path('/etc/ifshare/tls/server.crt').read_bytes()
        command(['bash', '/opt/ifshare/current/renew-certificate.sh'])
        self.assertNotEqual(Path('/etc/ifshare/tls/server.crt').read_bytes(), old_leaf)
        self.assertEqual(self.request('/')[0], 200)
        self.assert_preserved()

    def test_06_failed_update_restores_running_services(self):
        result = command([*INSTALL, '--bootstrap', '/ip4/127.0.0.1/tcp/14002/p2p/NotAValidPeerID'], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('已恢复原版本', result.stderr)
        self.assert_preserved()
        self.login()
        self.assertEqual(self.request('/api/v0/version', b'')[0], 200)

    def test_07_same_swarm_key_allows_a_second_node_to_fetch(self):
        second = Path('/data/second-node')
        second.mkdir(mode=0o700)
        shutil.copyfile(STORAGE / 'swarm.key', second / 'swarm.key')
        env = dict(ENV, IPFS_PATH=str(second))
        def second_cli(*args):
            return command([BINARY, *args], env=env).stdout.strip()
        second_cli('init', '--empty-repo', '--profile=autoconf-off')
        for name, value in {
            'Addresses.Swarm': ['/ip4/127.0.0.1/tcp/14002'],
            'Addresses.API': '/ip4/127.0.0.1/tcp/15002',
            'Addresses.Gateway': '/ip4/127.0.0.1/tcp/18081',
            'Swarm.Transports.Network.Websocket': False, 'AutoTLS.Enabled': False,
            'Swarm.DisableNatPortMap': True, 'Discovery.MDNS.Enabled': False,
            'Routing.Type': 'dht',
        }.items():
            second_cli('config', '--json', name, json.dumps(value))
        daemon = subprocess.Popen([BINARY, 'daemon', '--migrate=false'], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 30
            while not (second / 'api').exists() and time.monotonic() < deadline:
                self.assertIsNone(daemon.poll())
                time.sleep(0.2)
            peer = json.loads((second / 'config').read_text())['Identity']['PeerID']
            self.assertNotEqual(peer, self.identity)
            cli('swarm', 'connect', '/ip4/127.0.0.1/tcp/14002/p2p/' + peer)
            self.assertEqual(second_cli('cat', self.cid), 'IFShare private deployment regression fixture')
        finally:
            daemon.terminate()
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()

    def test_08_storage_file_and_unprivileged_user_are_rejected(self):
        path = Path('/data/not-a-directory')
        path.write_text('keep this file')
        args = INSTALL.copy()
        args[2] = str(path)
        result = command(args, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('不是目录', result.stderr)
        self.assertEqual(path.read_text(), 'keep this file')
        result = command(['runuser', '-u', 'nobody', '--', *INSTALL], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('root', result.stderr)
        self.assert_preserved()


if __name__ == '__main__':
    if os.geteuid() != 0 or os.environ.get('container') != 'docker' or os.environ.get('IFSHARE_RUN_INSTALL_TESTS') != '1':
        sys.exit('This destructive integration test is only for the disposable test container.')
    unittest.main(verbosity=2)
