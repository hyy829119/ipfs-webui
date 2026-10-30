#!/usr/bin/env python3
"""Package prebuilt Linux IFShare and a server-authenticated WebUI build."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    source = Path(__file__).resolve().parent
    web_repo = source.parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--kubo-root', required=True, type=Path)
    parser.add_argument('--web-build', type=Path, default=web_repo / 'build')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    with args.binary.open('rb') as binary:
        header = binary.read(20)
    if header[:5] != b'\x7fELF\x02' or header[18:20] != b'\x3e\x00':
        parser.error('--binary must be a prebuilt Linux amd64 ELF executable (use make build).')
    if not (args.web_build / 'index.html').exists() or not (args.web_build / 'auth/session.json').exists():
        parser.error('Build the WebUI with npm run build:server first.')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.package-', dir=args.output_dir) as temporary:
        stage = Path(temporary) / 'ifshare-linux-amd64'
        stage.mkdir()
        for name in ['install.sh', 'installer.py', 'certificates.py', 'renew-certificate.sh', 'README-zh-CN.md']:
            shutil.copyfile(source / name, stage / name)
        shutil.copytree(source / 'apache', stage / 'apache')
        shutil.copytree(args.web_build, stage / 'web', ignore=shutil.ignore_patterns('*.map', '.DS_Store'))
        (stage / 'bin').mkdir()
        shutil.copyfile(args.binary, stage / 'bin/ifshare')
        licenses = stage / 'licenses'
        licenses.mkdir()
        for prefix, root in [('kubo', args.kubo_root), ('webui', web_repo)]:
            for file in root.glob('LICENSE*'):
                if file.is_file():
                    shutil.copyfile(file, licenses / (prefix + '-' + file.name))
        # Include the compiler's dependency inventory; npm license notices are in web/static.
        inventory = subprocess.check_output(['go', 'version', '-m', str(args.binary)], text=True)
        (licenses / 'ifshare-go-modules.txt').write_text(inventory)
        payload = '\n'.join(digest(file) + '  ' + file.relative_to(stage).as_posix()
                            for file in sorted(stage.rglob('*')) if file.is_file())
        suffix = hashlib.sha256(payload.encode()).hexdigest()[:12]
        date = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        release = f'{date}-{suffix}'
        metadata = {
            'release': release, 'platform': 'linux-amd64', 'server_auth': True,
            'webui_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=web_repo, text=True).strip(),
            'kubo_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.kubo_root, text=True).strip(),
            'built_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        (stage / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
        checksum = ''.join(digest(file) + '  ' + file.relative_to(stage).as_posix() + '\n'
                           for file in sorted(stage.rglob('*')) if file.is_file())
        (stage / 'SHA256SUMS').write_text(checksum)
        for file in stage.rglob('*'):
            file.chmod(0o755 if file.is_dir() or file.suffix == '.sh' or file.name == 'ifshare' else 0o644)
        archive = args.output_dir / f'ifshare-linux-amd64-{release}.tar.gz'
        with tarfile.open(archive, 'w:gz', compresslevel=6) as tar:
            tar.add(stage, arcname='ifshare-linux-amd64')
        checksum_file = archive.with_name(archive.name + '.sha256')
        checksum_file.write_text(digest(archive) + '  ' + archive.name + '\n')
        print(archive)
        print(checksum_file)


if __name__ == '__main__':
    main()
