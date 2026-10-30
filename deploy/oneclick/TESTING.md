# Deployment validation

Run input, real TCP port, checksum and OpenSSL certificate tests from the WebUI repository:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/oneclick -p test_installer.py -v
bash -n deploy/oneclick/install.sh deploy/oneclick/renew-certificate.sh
npm run eslint
npm run typecheck
```

Full integration tests require a disposable Ubuntu 22.04 amd64 container with systemd as PID 1. They install system services and create test repositories. Do not run them on a real deployment. The explicit environment variable is required as an additional guard.

```bash
docker build --platform linux/amd64 -t ifshare-installer-test:22.04 \
  -f deploy/oneclick/test.Dockerfile deploy/oneclick
docker run -d --name ifshare-install-check --platform linux/amd64 \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --mount type=bind,source=/absolute/path/to/packages,target=/packages,readonly \
  ifshare-installer-test:22.04
```

An optional build argument `--build-arg UBUNTU_MIRROR=http://your-ubuntu-mirror/ubuntu` changes only the test image's apt mirror. Package signatures remain checked. The image masks `systemd-binfmt.service` so a privileged test container cannot clear the Docker host's architecture emulator registrations.

Extract the selected tarball to `/test`, then install with non-default node ports:

```bash
docker exec ifshare-install-check mkdir -p /test
docker exec ifshare-install-check tar -xzf /packages/ifshare-linux-amd64-RELEASE.tar.gz -C /test
docker exec ifshare-install-check bash /test/ifshare-linux-amd64/install.sh \
  '/data/ifshare files' 18443 --host 127.0.0.1 \
  --api-port 15001 --gateway-port 18080 --swarm-port 14001
docker cp deploy/oneclick/test_integration.py ifshare-install-check:/test/test_integration.py
docker exec -e IFSHARE_RUN_INSTALL_TESTS=1 ifshare-install-check python3 /test/test_integration.py
docker stop -t 15 ifshare-install-check
docker rm ifshare-install-check
```

Coverage includes authenticated HTTPS RPC with browser Origin/Referer headers, gateway ranges/raw blocks, reinstall preserving user configuration and MFS content, occupied ports, wrong private keys, certificate renewal, failed-update rollback including file ownership, private-network transfer between two independent node identities, invalid storage paths, and rejection of non-root execution. A separate port-80 listener verifies that an unrelated web service survives the installer.

The tests exercise the actual Linux binary and Apache. They do not constitute browser rendering or mobile UI testing.
