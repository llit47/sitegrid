"""Build a deterministic, version-pinned bootstrap; no network or signing secrets."""
import argparse
import base64
import hashlib
import io
from pathlib import Path
import re
import shlex
import zipfile

p = argparse.ArgumentParser()
p.add_argument('version')
p.add_argument('--public-key', default='ops/release-public.pem')
p.add_argument('--output', default='artifacts')
a = p.parse_args()
assert re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)', a.version), 'Stable version required'
key = Path(a.public_key).read_bytes()
assert key.startswith(b'-----BEGIN PUBLIC KEY-----'), 'Pinned public key required'
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name in ('bootstrap.py', 'channel.py', 'install_debian.py', 'release.py', 'system.py', 'release-public.pem'):
        data = key if name.endswith('.pem') else Path('ops', name).read_bytes()
        if name == 'bootstrap.py': data = data.replace(b'@SITEGRID_VERSION@', a.version.encode())
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data)
payload = base64.b64encode(buffer.getvalue()).decode()
script = '''#!/bin/bash
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo 'SiteGrid wymaga root.' >&2; exit 1; }
. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_ID" = 13 ] || { echo 'Wymagany gotowy Debian 13.' >&2; exit 1; }
[ -d /run/systemd/system ] || { echo 'Wymagany systemd.' >&2; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3 openssl iproute2 util-linux
sitegrid_bootstrap_tmp=$(mktemp -d)
trap 'rm -rf -- "$sitegrid_bootstrap_tmp"' EXIT
base64 -d > "$sitegrid_bootstrap_tmp/payload.zip" <<'SITEGRID_PAYLOAD'
''' + payload + '''
SITEGRID_PAYLOAD
python3 - "$sitegrid_bootstrap_tmp" <<'SITEGRID_UNPACK'
import sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
with zipfile.ZipFile(root / 'payload.zip') as archive:
    archive.extractall(root)
SITEGRID_UNPACK
python3 "$sitegrid_bootstrap_tmp/bootstrap.py" "$@"
'''
output = Path(a.output)
output.mkdir(parents=True, exist_ok=True)
bootstrap = output / f'sitegrid-install-{a.version}.sh'
bootstrap.write_text(script)
bootstrap.chmod(0o755)
sha = hashlib.sha256(bootstrap.read_bytes()).hexdigest()
# The command itself is the initial trust anchor and must be copied from a trusted instruction.
runner = f'''set -euo pipefail; test "$(id -u)" = 0; . /etc/os-release; test "$ID:$VERSION_ID" = debian:13; apt-get update; apt-get install -y ca-certificates curl; f=$(mktemp); trap 'rm -f -- "$f"' EXIT; curl --disable --fail --silent --show-error --location --proto =https --proto-redir =https --connect-timeout 15 --max-time 120 --max-filesize 1048576 https://github.com/llit47/sitegrid/releases/download/v{a.version}/{bootstrap.name} -o "$f"; echo "{sha}  $f" | sha256sum --check --status; bash "$f"'''
command = 'bash -c ' + shlex.quote(runner)
(output / 'INSTALL_COMMAND.txt').write_text(command + '\n')
(output / (bootstrap.name + '.sha256')).write_text(sha + '  ' + bootstrap.name + '\n')
print(bootstrap, sha)
