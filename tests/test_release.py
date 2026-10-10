import hashlib
import io
import json
import os
import re
import subprocess
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
from release import SiteGridError, extract_release, validate_manifest, atomic_link, download


class ReleaseTests(unittest.TestCase):
    def test_malformed_manifest_fails_closed(self):
        manifest = json.loads(Path('release.json').read_text())
        for value in [[], {**manifest, 'version': 1}, {**manifest, 'schema': []}]:
            with self.subTest(value=value), self.assertRaises(SiteGridError): validate_manifest(value)

    def test_manifest_requires_schema_contract(self):
        manifest = json.loads(Path('release.json').read_text())
        validate_manifest(manifest)
        del manifest['schema']['min']
        with self.assertRaises(SiteGridError): validate_manifest(manifest)

    def malicious_archive(self, name, link=False):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'release.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/etc/passwd'
                    tar.addfile(member)
                else:
                    member.size = 1
                    tar.addfile(member, io.BytesIO(b'x'))
            sha = hashlib.sha256(archive.read_bytes()).hexdigest()
            with self.assertRaisesRegex(SiteGridError, 'Niebezpieczna'):
                extract_release(archive, Path(directory) / 'out', sha, '0.1.0')

    def test_parent_traversal_rejected(self): self.malicious_archive('../outside')
    def test_absolute_path_rejected(self): self.malicious_archive('/outside')
    def test_symlink_rejected(self): self.malicious_archive('link', True)

    def test_untrusted_checksum_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'invalid.tar.gz'
            archive.write_bytes(b'corrupt')
            destination = Path(directory) / 'out'
            with self.assertRaisesRegex(SiteGridError, 'SHA-256'):
                extract_release(archive, destination, '0' * 64, '0.1.0')
            self.assertFalse(destination.exists())

    def test_pinned_version_required(self):
        with self.assertRaises(SiteGridError): extract_release('/missing', '/missing', '0' * 64, 'main')

    def test_atomic_switch_and_recovery_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory) / 'current'
            atomic_link('/one', current)
            atomic_link('/two', current)
            self.assertEqual(os.readlink(current), '/two')
            current.with_name('current.next').symlink_to('/interrupted')
            with self.assertRaises(SiteGridError): atomic_link('/three', current)
            self.assertEqual(os.readlink(current), '/two')

    def test_missing_download_preserves_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'file'
            destination.write_text('old')
            with self.assertRaises(SiteGridError): download('/missing-sitegrid-artifact', destination)
            self.assertEqual(destination.read_text(), 'old')

    @unittest.skipUnless(os.environ.get('SITEGRID_TEST_BUNDLE'), 'Run packaging test with SITEGRID_TEST_BUNDLE')
    def test_actual_built_bundle(self):
        archive = Path(os.environ['SITEGRID_TEST_BUNDLE'])
        version = os.environ.get('SITEGRID_TEST_VERSION', '0.1.0')
        sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            manifest = extract_release(archive, Path(directory) / 'release', sha, version)
            self.assertEqual(manifest['schema'], json.loads(Path('release.json').read_text())['schema'])
            self.assertTrue((Path(directory) / 'release/migrations/011_contractors.sql').is_file())
            for module in ['domain', 'persistence', 'routes']:
                self.assertTrue((Path(directory) / f'release/dist/server/contractors/{module}.js').is_file())
            self.assertEqual((Path(directory) / 'release').stat().st_mode & 0o777, 0o755)
            web = Path(directory) / 'release/dist/web'
            worker = (web / 'sw.js').read_text()
            shell = json.loads(re.search(r'const shell = (.*);', worker).group(1))
            self.assertRegex(shell['version'], r'^[a-f0-9]{64}$')
            for asset in shell['assets']:
                self.assertRegex(asset['url'], r'^/(assets|pwa)/')
                self.assertEqual(hashlib.sha256((web / asset['url'].lstrip('/')).read_bytes()).hexdigest(), asset['sha256'])
            self.assertEqual((web / shell['shell'].lstrip('/')).read_bytes(), (web / 'index.html').read_bytes())
            manifest_path = next(asset['url'] for asset in shell['assets'] if asset['url'].endswith('.webmanifest'))
            pwa = json.loads((web / manifest_path.lstrip('/')).read_text())
            self.assertEqual([pwa['id'], pwa['name'], pwa['display']], ['/', 'SiteGrid', 'standalone'])
            self.assertTrue(all((web / icon['src'].lstrip('/')).is_file() for icon in pwa['icons']))
            # Production packaging skips install scripts. Exercise the bundled native
            # raster decoder with the pinned runtime, rather than the workspace modules.
            script = '''
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validateLogo } from './dist/server/organization-branding.js';
import { contractorInput } from './dist/server/contractors/domain.js';
assert.equal(contractorInput({ name: ' Contractor ' }).name, 'Contractor');
for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0022' } }).toFormat(format).toBuffer();
  const logo = await validateLogo(mime, image.toString('base64'));
  assert.equal(logo.mimeType, mime);
  assert.equal((await sharp(logo.data).metadata()).format, format);
}
'''
            result = subprocess.run([str(Path(directory) / 'release/runtime/bin/node'), '--input-type=module', '-e', script],
                                    cwd=Path(directory) / 'release', capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            wrong = '9999.9999.9999' if version != '9999.9999.9999' else '0.0.0'
            with self.assertRaises(SiteGridError): extract_release(archive, Path(directory) / 'wrong', sha, wrong)


if __name__ == '__main__': unittest.main()
