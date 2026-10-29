# IFShare WebUI Apache deployment

The WebUI is a static production build. Apache serves it on port 80; no Node.js process is needed on the server.

## Build

Run from the repository root with the project Node.js version and dependencies installed:

```sh
CI=true npm run build:server
COPYFILE_DISABLE=1 tar --no-xattrs -czf ifshare-webui.tar.gz -C build .
shasum -a 256 ifshare-webui.tar.gz
```

Upload the archive and `ifshare-webui.conf` to the deployment server. Keep SSH credentials outside the repository and deployment package.

## Server layout

- `/var/www/ifshare/releases/<release>/`: extracted production build.
- `/var/www/ifshare/current`: symlink to the active release.
- `/etc/apache2/sites-available/ifshare-webui.conf`: Apache virtual host.
- `/var/log/apache2/ifshare-access.log` and `ifshare-error.log`: server logs.

Install Apache from the server's package repository. Before enabling the site, configure the authentication modules and server-only secrets:

```sh
sudo a2enmod headers request auth_form session session_cookie session_crypto proxy proxy_http
sudo install -d -m 0750 -g www-data /etc/apache2/ifshare
sudo htpasswd -B -C 8 -c /etc/apache2/ifshare/users admin
sudo sh -c 'umask 077; openssl rand -base64 48 > /etc/apache2/ifshare/session.key'
sudo chown root:www-data /etc/apache2/ifshare/users /etc/apache2/ifshare/session.key
sudo chmod 640 /etc/apache2/ifshare/users /etc/apache2/ifshare/session.key
```

Run these initialization commands once. Preserve the existing user file and session key on later deployments. The `htpasswd` command asks for the login password without saving plaintext credentials in the repository. Apache's `mod_auth_form` also requires `mod_request`, even if the distribution does not automatically enable that dependency.

Install the virtual host configuration, enable the `ifshare-webui` site, and run `apache2ctl configtest` before restarting Apache after module changes. On a new server, disable the packaged `000-default` site. Enable the `apache2` service at boot. Confirm `systemctl is-active apache2` and an HTTP response after restarting; the configuration syntax check alone does not validate all module dependencies.

For updates, extract each build into a new release directory, preserve the previous release, and atomically replace the `current` symlink. To roll back, point `current` to the previous release and reload Apache.

## Verification

```sh
sudo apache2ctl configtest
systemctl is-active apache2
systemctl is-enabled apache2
curl -I http://127.0.0.1/
curl -I http://127.0.0.1/locales/zh-CN/login.json
python3 deploy/apache/verify-rpc.py http://111.10.164.175:3000
# Add --content-cid <existing-file-CID> --content-name <filename> to verify gateway auth and byte ranges.
```

Open `http://111.10.164.175:3000/?lng=zh-CN#/login`. The public port 3000 must map to `192.168.10.52:80`. Check the login page, sign-in and a page reload.

## IFShare backend

The IFShare daemon must already run with its RPC listener on `127.0.0.1:5001`. Apache forwards `/api/v0/` to that listener after checking the server session. The daemon does not need a public RPC port or a restart for this proxy configuration.

`npm run build:server` enables server authentication and uses the page origin as the RPC address, including when the browser previously saved a localhost API address. The existing login form submits to Apache's form authentication handler; session cookies are encrypted, HttpOnly and SameSite=Strict, with an eight-hour lifetime. Logout clears the browser session. Unauthenticated RPC requests return 401, and requests bearing an unexpected Origin return 403. Apache removes the verified Origin header before forwarding to the loopback RPC listener.

The configured allowed origin is `http://111.10.164.175:3000`; update the Origin checks if the public URL changes. The current deployment uses HTTP. When moving to HTTPS, also add `secure` to `SessionCookieName`. The plain `npm start` and `npm run build` flows retain the local preview login; use `build:server` with this Apache configuration.

The gateway on `127.0.0.1:8080` is separate from the RPC listener. Apache forwards authenticated `/ipfs/` and `/ipns/` GET/HEAD requests to it, including byte-range requests for video seeking. The existing public port 3000 is sufficient; do not expose port 8080 separately. Content responses have a restrictive CSP sandbox because files share the WebUI host. They cannot execute scripts with the WebUI's privileges. The daemon's repository and private-network configuration stay unchanged.

Server builds keep RPC, directory listings and downloads on the page origin. File previews and image thumbnails first probe the local client at `http://127.0.0.1:8080` (or the Local Gateway URL override). The probe has a 1.5-second deadline, sends no credentials, and falls back to the server when the CID is unavailable, the request fails, or the browser blocks local-network access. A failed local media/text load also falls back. Standalone builds keep their configured gateway behavior. A CID entered without a filename uses the gateway MIME type to select its preview. Text/code previews read all chunks up to 256 KiB, render read-only with line numbers, and offer download for the full file.

On refresh, initialization and the first bandwidth poll show a connecting state. An actual failed initialization or poll still shows the connection error. Regression checks:

```sh
npm run test:unit -- --runTestsByPath src/bundles/connected.test.js src/status/StatusPage.test.js src/bundles/config.test.js src/files/file-preview/preview-source.test.ts src/files/file-preview/FilePreview.test.js src/auth/AuthGate.test.tsx
npm run eslint
npm run typecheck
```

The gateway proxy follows [Apache ProxyPass](https://httpd.apache.org/docs/2.4/mod/mod_proxy.html#proxypass); the content isolation uses the [CSP sandbox directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).

HTML and translation JSON are revalidated on each load. Files under `/static/` have content hashes and are cached for one year. The app uses hash routing, so missing files correctly return HTTP 404 without an SPA rewrite.

## Initial deployment — 2026-10-29

- Public URL: `http://111.10.164.175:3000/?lng=zh-CN#/login`.
- Server: `192.168.10.52`, reached over SSH at `111.10.164.175:6022`.
- Initial release: `/var/www/ifshare/releases/20261029-58dca21d`.
- Uploaded archive: `/home/master/ifshare-deploy-20261029/ifshare-webui-20261029.tar.gz`.
- Archive SHA-256: `58dca21dffaba7ac54b163f0dc5d40d77783cc2950774074a39ba906ef416a4e`.
- Apache configuration validation passed; the service is active and enabled at boot.
- Public HTTP response: 200. Server-side HTML, CSS, JavaScript and Chinese translation responses matched the deployed files byte for byte. Missing static files returned 404.
- This initial release served only static WebUI files. The subsequent RPC fix adds authenticated forwarding to the separately installed IFShare daemon.

Service commands on the server:

```sh
sudo systemctl status apache2
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## RPC connectivity update — 2026-10-29

- Active release: `/var/www/ifshare/releases/20261029-rpc-776ce00f`.
- Archive SHA-256: `776ce00ffae106b0e0a90ae8e1f411bb174453df1c59b506ecab621591fa7997`.
- Previous site configuration: `/etc/apache2/sites-available/ifshare-webui.conf.before-rpc-20261029`.
- Previous release pointer: `/home/master/ifshare-rpc-20261029/previous-release.txt`.
- The same login, cookie, RPC, multipart request, foreign-origin rejection and logout checks passed first on a loopback-only Apache test listener, then from outside the server through public port 3000. The test listener was disabled after deployment.
- The daemon remains bound to `127.0.0.1:5001`; its service, repository and private-network settings were not changed.

To roll back this update, restore the previous site configuration together with the previous `current` symlink, validate the configuration, and reload Apache. The initial release has no RPC forwarding, so restoring it also removes remote backend access.

Implementation references: [Apache form authentication](https://httpd.apache.org/docs/2.4/mod/mod_auth_form.html), [encrypted sessions](https://httpd.apache.org/docs/2.4/mod/mod_session_crypto.html) and [session cookie attributes](https://httpd.apache.org/docs/2.4/mod/mod_session_cookie.html).
