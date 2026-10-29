# IFShare WebUI Apache deployment

The WebUI is a static production build. Apache serves it on port 80; no Node.js process is needed on the server.

## Build

Run from the repository root with the project Node.js version and dependencies installed:

```sh
CI=true GENERATE_SOURCEMAP=false npm run build
COPYFILE_DISABLE=1 tar --no-xattrs -czf ifshare-webui.tar.gz -C build .
shasum -a 256 ifshare-webui.tar.gz
```

Upload the archive and `ifshare-webui.conf` to the deployment server. Keep SSH credentials outside the repository and deployment package.

## Server layout

- `/var/www/ifshare/releases/<release>/`: extracted production build.
- `/var/www/ifshare/current`: symlink to the active release.
- `/etc/apache2/sites-available/ifshare-webui.conf`: Apache virtual host.
- `/var/log/apache2/ifshare-access.log` and `ifshare-error.log`: server logs.

Install Apache from the server's package repository, enable the `headers` module and the `ifshare-webui` site, then run `apache2ctl configtest` before reloading Apache. On a new server, disable the packaged `000-default` site. Enable the `apache2` service at boot.

For updates, extract each build into a new release directory, preserve the previous release, and atomically replace the `current` symlink. To roll back, point `current` to the previous release and reload Apache.

## Verification

```sh
sudo apache2ctl configtest
systemctl is-active apache2
systemctl is-enabled apache2
curl -I http://127.0.0.1/
curl -I http://127.0.0.1/locales/zh-CN/login.json
```

Open `http://111.10.164.175:3000/?lng=zh-CN#/login`. The public port 3000 must map to `192.168.10.52:80`. Check the login page, sign-in and a page reload.

## IFShare backend

This configuration serves the WebUI only. It does not install a daemon or expose a Kubo RPC endpoint. Configure an existing, access-controlled IFShare RPC address in the WebUI when the backend is available. The login form is a frontend gate; it does not authenticate requests to the RPC service.

HTML and translation JSON are revalidated on each load. Files under `/static/` have content hashes and are cached for one year. The app uses hash routing, so missing files correctly return HTTP 404 without an SPA rewrite.

## Deployment record — 2026-10-29

- Public URL: `http://111.10.164.175:3000/?lng=zh-CN#/login`.
- Server: `192.168.10.52`, reached over SSH at `111.10.164.175:6022`.
- Active release: `/var/www/ifshare/releases/20261029-58dca21d`.
- Uploaded archive: `/home/master/ifshare-deploy-20261029/ifshare-webui-20261029.tar.gz`.
- Archive SHA-256: `58dca21dffaba7ac54b163f0dc5d40d77783cc2950774074a39ba906ef416a4e`.
- Apache configuration validation passed; the service is active and enabled at boot.
- Public HTTP response: 200. Server-side HTML, CSS, JavaScript and Chinese translation responses matched the deployed files byte for byte. Missing static files returned 404.
- No IFShare daemon or RPC proxy was deployed in this release.

Service commands on the server:

```sh
sudo systemctl status apache2
sudo apache2ctl configtest
sudo systemctl reload apache2
```
