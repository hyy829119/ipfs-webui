# IFShare WebUI Apache deployment

The WebUI is a static production build. Apache terminates HTTPS on internal port 80, mapped from public port 3000; no Node.js process is needed on the server.

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
sudo a2enmod ssl headers request auth_form session session_cookie session_crypto proxy proxy_http
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
curl --cacert IFShare-CA.crt -I https://111.10.164.175:3000/
python3 deploy/apache/verify-rpc.py https://111.10.164.175:3000 --ca-file IFShare-CA.crt
# Add --content-cid <existing-file-CID> --content-name <filename> to verify gateway auth and byte ranges.
```

Open `https://111.10.164.175:3000/?lng=zh-CN#/login`. The public port 3000 must map to `192.168.10.52:80`. Check the login page, sign-in and a page reload.

## IFShare backend

The IFShare daemon must already run with its RPC listener on `127.0.0.1:5001`. Apache forwards `/api/v0/` to that listener after checking the server session. The daemon does not need a public RPC port or a restart for this proxy configuration.

`npm run build:server` enables server authentication and uses the page origin as the RPC address, including when the browser previously saved a localhost API address. The existing login form submits to Apache's form authentication handler; session cookies are encrypted, Secure, HttpOnly and SameSite=Strict, with an eight-hour lifetime. Logout clears the browser session. Unauthenticated RPC requests return 401, and requests bearing an unexpected Origin return 403. Apache removes the verified Origin header before forwarding to the loopback RPC listener.

The configured allowed origin is `https://111.10.164.175:3000`; update the Origin checks and certificate if the public URL changes. The plain `npm start` and `npm run build` flows retain the local preview login; use `build:server` with this Apache configuration.

The gateway on `127.0.0.1:8080` is separate from the RPC listener. Apache forwards authenticated `/ipfs/` and `/ipns/` GET/HEAD requests to it, including byte-range requests for video seeking. The existing public port 3000 is sufficient; do not expose port 8080 separately. Content responses have a restrictive CSP sandbox because files share the WebUI host. They cannot execute scripts with the WebUI's privileges. The daemon's repository and private-network configuration stay unchanged.

Server builds keep RPC, directory listings and downloads on the page origin. File previews and image thumbnails first probe the local client at `http://127.0.0.1:8080` (or the Local Gateway URL override). The probe has a 1.5-second deadline, sends no credentials, and falls back to the server when the CID is unavailable, the request fails, or the browser blocks local-network access. A failed local media/text load also falls back. Standalone builds keep their configured gateway behavior. A CID entered without a filename uses the gateway MIME type to select its preview. Text/code previews read all chunks up to 256 KiB, render read-only with line numbers, and offer download for the full file. Common suffixes select syntax highlighting (including C#, JavaScript, Java, C/C++, Python, Go, Rust, scripts and configuration files); unknown suffixes and extensionless files also attempt text preview. Binary content and unsupported text encodings show a download prompt.

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

## HTTPS and browser archive extraction

Run `sudo sh deploy/apache/create-certificate.sh` once before enabling this TLS configuration. The script creates a private CA and a 365-day server certificate with the public IP in its SAN. It refuses to replace existing keys. Only export `ca.crt` to clients, as `IFShare-CA.crt`; keep both private keys on the server. Import and trust this CA on each client device. A browser exception alone may not enable secure-context storage APIs. Renew the server certificate before expiry, using the existing CA. No port mapping change is required: Apache speaks TLS on the already-mapped internal port 80. Plain HTTP requests receive the configured HTTPS error redirect; verify it when changing Apache versions.

Clicking a `.zip`, `.rar`, or `.tar.gz` file starts local extraction immediately. A worker receives input in awaited chunks of at most 1 MiB, mounts the disk-backed archive through WORKERFS and writes outputs to OPFS. The UI shows reading/scanning/extraction progress, then lists files only after all regular files have been extracted. Downloads use disk-backed File URLs. Closing or cancelling the preview terminates the worker and removes its temporary directory.

Desktop has no application file-size, entry-count or overall extraction-time limit. Archive decoder memory, browser disk quota and available disk space still apply. Solid archives may be read repeatedly when extracting individual entries. Small physical screens (up to 820 CSS pixels on the shorter side, with coarse primary input) enforce 100 MiB compressed and total unpacked limits, plus 10,000 files. Unknown browser APIs, storage failures, encrypted/unsupported/corrupt content degrade to the existing original-download button. Password-protected archives can be retried with a password. Symbolic/hard links are excluded; archived paths never become output filesystem paths.

The inspector's Helia block broker now obtains current gateway settings per request. It first attempts a raw block at the local gateway without cookies (1.5 seconds), validates it, then falls back to the server with same-origin authentication. Both file-list inspection and CID inspection use this broker. No remote public routing is needed for these reads.

Validation:

```sh
node --test test/archive/extraction.mjs test/explore-gateway.mjs
npm run test:unit -- --runTestsByPath src/explore/gateway-broker.test.js src/files/file-preview/archive/archive-source.test.js src/files/file-preview/archive/archive-client.test.js src/files/file-preview/archive/ArchivePreview.test.js
npm run eslint
npm run typecheck
```

The real WASM tests use a disk-backed OPFS adapter with ZIP, RAR 4/5, TAR.GZ, Chinese paths, empty files, pagination and 128 MiB output. They do not substitute for checking OPFS support in the target browser. See [OPFS requirements and quotas](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

The extraction engine is unmodified `7z-wasm` 1.2.0 (7-Zip 24.09), loaded as separate versioned assets. Its LGPL and unRAR notices accompany the engine. Source and build instructions: [7z-wasm](https://github.com/use-strict/7z-wasm), [7-Zip source](https://www.7-zip.org/download.html).
