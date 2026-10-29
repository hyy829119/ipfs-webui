#!/usr/bin/env python3
"""Check authenticated RPC access without changing the node's stored content."""
import argparse
import getpass
import http.cookiejar
import json
import secrets
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('base_url')
parser.add_argument('--origin')
parser.add_argument('--username', default='admin')
parser.add_argument('--content-cid', help='An existing non-empty file CID to check gateway streaming')
parser.add_argument('--content-name', default='preview.bin')
args = parser.parse_args()
base = args.base_url.rstrip('/')
origin = args.origin or base
content_path = '/ipfs/' + args.content_cid + '?' + urllib.parse.urlencode({'filename': args.content_name}) if args.content_cid else None
password = getpass.getpass('IFShare password: ')
jar = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def request(path, data=None, request_origin=origin, content_type=None):
    headers = {'Origin': request_origin}
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        with client.open(req, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def login(value):
    data = urllib.parse.urlencode({
        'httpd_username': args.username,
        'httpd_password': value
    }).encode()
    return request('/auth/login', data, content_type='application/x-www-form-urlencoded')


assert request('/auth/session.json')[0] == 401, 'Anonymous session was accepted'
assert request('/api/v0/version', b'')[0] == 401, 'Anonymous RPC was accepted'
if content_path:
    assert request(content_path)[0] == 401, 'Anonymous gateway access was accepted'
print('Anonymous session and RPC: blocked')
assert login(secrets.token_hex(24))[0] == 401, 'Invalid password was accepted'
print('Incorrect password: rejected')
status, body = login(password)
assert status == 200 and json.loads(body)['authenticated'], ('Login failed', status)
print('Login and session validation: passed')

for path in ['/api/v0/version', '/api/v0/stats/bw', '/api/v0/files/ls?arg=/&long=true']:
    status, body = request(path, b'')
    assert status == 200, (path, status, body[:200])
    json.loads(body)
    print('Authenticated RPC:', path, status)

# only-hash computes the CID but does not add content or pins to the node.
boundary = 'ifshare-' + secrets.token_hex(12)
body = ('--{0}\r\nContent-Disposition: form-data; name="file"; filename="probe.txt"'
        '\r\nContent-Type: text/plain\r\n\r\nIFShare proxy verification\r\n--{0}--\r\n').format(boundary).encode()
status, body = request('/api/v0/add?only-hash=true&pin=false', body, content_type='multipart/form-data; boundary=' + boundary)
assert status == 200 and json.loads(body)['Hash'], ('Multipart request failed', status)
print('Multipart upload forwarding (only-hash): passed')
assert request('/api/v0/version', b'', request_origin='http://untrusted.invalid')[0] == 403, 'Foreign origin was accepted'
print('Foreign origin: blocked')
if content_path:
    req = urllib.request.Request(base + content_path, method='HEAD', headers={'Origin': origin})
    with client.open(req, timeout=20) as response:
        assert response.status == 200, 'Gateway HEAD failed'
        assert 'sandbox' in response.headers.get('Content-Security-Policy', ''), 'Content sandbox missing'
        assert 'no-store' in response.headers.get('Cache-Control', ''), 'Private caching policy missing'
        assert response.headers.get('X-Content-Type-Options') == 'nosniff', 'Content type protection missing'
        print('Authenticated gateway HEAD:', response.headers.get('Content-Type'))
    req = urllib.request.Request(base + content_path, headers={'Origin': origin, 'Range': 'bytes=0-15'})
    with client.open(req, timeout=20) as response:
        assert response.status == 206, 'Gateway byte ranges are unavailable'
        assert response.headers.get('Content-Range', '').startswith('bytes 0-15/'), 'Incorrect byte range'
        assert len(response.read()) == 16, 'Incorrect range response length'
    assert request(content_path, request_origin='http://untrusted.invalid')[0] == 403, 'Foreign content origin accepted'
    assert request(content_path, b'')[0] == 403, 'Gateway accepted a write request'
    print('Gateway byte ranges, foreign origin rejection and read-only access: passed')
assert request('/auth/logout', b'')[0] == 200, 'Logout failed'
assert request('/api/v0/version', b'')[0] == 401, 'RPC remained accessible after logout'
if content_path:
    assert request(content_path)[0] == 401, 'Gateway remained accessible after logout'
print('RPC after logout: blocked')
