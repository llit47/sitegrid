"""Sign tested release assets. The Ed25519 private key stays outside the repository."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
from release import require, command
from channel import REPOSITORY, version_tuple, verify_manifest

p = argparse.ArgumentParser()
p.add_argument('version')
p.add_argument('--key-file', required=True)
p.add_argument('--public-key', default='ops/release-public.pem')
p.add_argument('--directory', default='artifacts')
p.add_argument('--issued-at', type=int)
a = p.parse_args()
version_tuple(a.version)
key, public, directory = Path(a.key_file), Path(a.public_key), Path(a.directory)
require(key.is_file() and not key.is_symlink() and key.stat().st_uid == os.geteuid() and key.stat().st_mode & 0o077 == 0, 'Signing key must be owner-only and outside the repository.')
repository = Path(__file__).resolve().parents[1]
require(not key.resolve().is_relative_to(repository), 'Private signing key must not be in the repository.')
require(command(['openssl', 'pkey', '-in', str(key), '-pubout']).strip() == public.read_text().strip(), 'Signing key does not match the pinned public key.')
artifacts = {}
for archive in sorted(directory.glob(f'sitegrid-{a.version}-linux-*.tar.gz')):
    with tarfile.open(archive, 'r:gz') as tar:
        manifest = json.load(tar.extractfile('./release.json'))
    arch = manifest['arch']
    require(manifest['version'] == a.version and arch in ('x64', 'arm64') and archive.name == f'sitegrid-{a.version}-linux-{arch}.tar.gz', 'Bundle does not match the tag/platform.')
    artifacts[arch] = {'name': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
require(artifacts, 'No tested bundles to sign.')
bootstrap = directory / f'sitegrid-install-{a.version}.sh'
issued = a.issued_at if a.issued_at is not None else int(time.time())
manifest = {'format': 1, 'repository': REPOSITORY, 'channel': 'stable', 'version': a.version,
            'issued_at': issued, 'expires_at': issued + 90 * 86400, 'artifacts': artifacts,
            'bootstrap': {'name': bootstrap.name, 'sha256': hashlib.sha256(bootstrap.read_bytes()).hexdigest()}}
path, signature = directory / 'sitegrid-manifest.json', directory / 'sitegrid-manifest.sig'
path.write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n')
command(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin', '-in', str(path), '-out', str(signature)])
verify_manifest(path, signature, a.version, public, now=issued)
notes = f'''SiteGrid {a.version} — Debian 13 only\n\nThis release contains the prebuilt application, Node runtime, installer and signed manifest.\nPinned bootstrap command (run as root inside an existing Debian 13):\n\n```sh\n{(directory / 'INSTALL_COMMAND.txt').read_text().strip()}\n```\n\nAfter installation: `sitegrid bootstrap-admin`, `sitegrid update`, `sitegrid rollback`.\nRelease public key fingerprint (SHA-256 of PEM): {hashlib.sha256(public.read_bytes()).hexdigest()}\n'''
(directory / 'RELEASE_NOTES.md').write_text(notes)
print(f'Signed {a.version}: {", ".join(artifacts)}; valid for 90 days. No publication performed.')
