#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 && ${1:-} != --help && ${1:-} != -h ]]; then
    printf '%s\n' '用法: sudo bash install.sh <存储目录绝对路径> <Web端口> [--host 访问IP或域名]' >&2
    exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
    if [[ $(id -u) -ne 0 ]]; then
        printf '%s\n' '请使用 sudo bash install.sh <存储目录> <Web端口>。' >&2
        exit 1
    fi
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$script_dir/installer.py" "$@"
