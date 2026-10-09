"""Repackage a trusted real bundle for signed, local-only release integration tests."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
from release import extract_release
assert os.environ.get('SITEGRID_DISPOSABLE_TEST') == 'YES', 'Disposable fixture opt-in required'
p = argparse.ArgumentParser()
p.add_argument('bundle'); p.add_argument('sha256'); p.add_argument('base_version'); p.add_argument('version')
p.add_argument('--public-key', required=True); p.add_argument('--key-file', required=True); p.add_argument('--output', required=True)
a = p.parse_args()
output = Path(a.output)
output.mkdir(parents=True, exist_ok=True)
archive = output / f'sitegrid-{a.version}-linux-x64.tar.gz'
assert not archive.exists(), 'Refusing to overwrite a fixture'
with tempfile.TemporaryDirectory(prefix='sitegrid-signed-fixture-') as directory:
    root = Path(directory) / 'release'
    manifest = extract_release(a.bundle, root, a.sha256, a.base_version)
    manifest['version'] = a.version
    (root / 'release.json').write_text(json.dumps(manifest))
    (root / 'ops/release-public.pem').write_bytes(Path(a.public_key).read_bytes())
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(root, arcname='.')
subprocess.run([sys.executable, 'scripts/build-bootstrap.py', a.version, '--public-key', a.public_key, '--output', a.output], check=True)
subprocess.run([sys.executable, 'scripts/sign-release.py', a.version, '--key-file', a.key_file, '--public-key', a.public_key, '--directory', a.output], check=True)
print('LOCAL TEST FIXTURE ONLY', archive.name, hashlib.sha256(archive.read_bytes()).hexdigest())
