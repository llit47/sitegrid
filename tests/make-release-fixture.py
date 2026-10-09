"""Create trusted, local-only deployment failure/schema fixtures from a real bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
from release import extract_release
assert os.environ.get('SITEGRID_DISPOSABLE_TEST') == 'YES', 'Disposable-test opt-in required'
p=argparse.ArgumentParser()
p.add_argument('bundle'); p.add_argument('sha256'); p.add_argument('mode', choices=['readiness', 'schema'])
a=p.parse_args()
version = '0.1.2' if a.mode == 'readiness' else '0.1.3'
output=Path('artifacts') / f'sitegrid-test-{version}.tar.gz'
assert not output.exists(), 'Refusing to overwrite test fixture'
with tempfile.TemporaryDirectory(prefix='sitegrid-fixture-') as directory:
    root=Path(directory) / 'release'
    manifest=extract_release(a.bundle, root, a.sha256, '0.1.1')
    manifest['version']=version
    if a.mode=='readiness':
        (root / 'dist/server/main.js').write_text('process.exit(17);\n')
    else:
        (root / 'migrations/003_lifecycle_smoke.sql').write_text('CREATE TABLE lifecycle_smoke_stamp (id integer PRIMARY KEY);\n')
        manifest['schema'].update(target=3, min=3, max=3, upgradeMax=3)
    (root / 'release.json').write_text(json.dumps(manifest))
    with tarfile.open(output, 'w:gz') as tar:
        for item in sorted(root.rglob('*')):
            tar.add(item, arcname='./'+str(item.relative_to(root)), recursive=False)
digest=hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(output.suffix+'.sha256').write_text(digest+'  '+output.name+'\n')
print('TEST FIXTURE ONLY',output,digest)
