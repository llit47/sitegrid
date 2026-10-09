"""Signed local fixtures exercise public release trust and the existing lifecycle."""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import shlex
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
import bootstrap
import channel
import lifecycle
import manage
from release import SiteGridError
import test_install_debian
import test_lifecycle


class ChannelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.private = Path(cls.keys.name) / 'private.pem'
        cls.public = Path(cls.keys.name) / 'public.pem'
        cls.private.touch(mode=0o600)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(cls.private)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(cls.private), '-pubout', '-out', str(cls.public)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls): cls.keys.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.downloads = []
        self.create_fixture()

    def create_fixture(self, version='0.1.1', **overrides):
        now = int(time.time())
        self.bundle = b'signed local test bundle'
        self.manifest = {'format': 1, 'repository': channel.REPOSITORY, 'channel': 'stable', 'version': version,
                         'issued_at': now, 'expires_at': now + 3600,
                         'artifacts': {'x64': {'name': f'sitegrid-{version}-linux-x64.tar.gz', 'sha256': hashlib.sha256(self.bundle).hexdigest()}},
                         'bootstrap': {'name': f'sitegrid-install-{version}.sh', 'sha256': 'b' * 64}, **overrides}
        self.sign_fixture()

    def sign_fixture(self):
        (self.root / 'signed.json').write_text(json.dumps(self.manifest))
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(self.private), '-rawin', '-in', str(self.root / 'signed.json'), '-out', str(self.root / 'signed.sig')], check=True, capture_output=True)

    def fetch(self, url, destination, limit):
        self.downloads.append(url)
        if url.endswith('/latest'):
            data = json.dumps({'tag_name': 'v' + self.manifest['version'], 'draft': False, 'prerelease': False}).encode()
        elif url.endswith('sitegrid-manifest.json'): data = (self.root / 'signed.json').read_bytes()
        elif url.endswith('sitegrid-manifest.sig'): data = (self.root / 'signed.sig').read_bytes()
        else: data = self.bundle
        self.assertLessEqual(len(data), limit)
        Path(destination).write_bytes(data)

    def resolve(self):
        directory = self.root / 'download'
        directory.mkdir()
        return channel.resolve(directory, key=self.public, fetcher=self.fetch)

    def lifecycle_case(self):
        case = test_lifecycle.LifecycleTests('test_update_backs_up_before_migration_and_switch')
        case.setUp()
        self.addCleanup(case.doCleanups)
        return case

    def installer_case(self):
        case = test_install_debian.InstallerRetryTests('test_retry_after_apt_installs_nginx_before_original_marker_window')
        case.setUp()
        self.addCleanup(case.doCleanups)
        self.create_fixture('0.1.0')
        return case

    def run_bootstrap(self, case):
        with patch.object(channel, 'KEY', self.public), patch.object(channel, 'fetch', self.fetch), patch.object(bootstrap, 'VERSION', '0.1.0'), contextlib.redirect_stdout(io.StringIO()):
            bootstrap.install(argparse.Namespace(origin=case.args.origin, yes=True))

    def test_signed_manifest_and_bundle(self):
        manifest = self.resolve()
        archive, sha = channel.download_bundle(manifest, self.root, fetcher=self.fetch)
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), sha)
        self.assertTrue(all(url.startswith((channel.API, channel.BASE)) for url in self.downloads))

    def test_tampered_manifest_rejected_before_bundle(self):
        (self.root / 'signed.json').write_text((self.root / 'signed.json').read_text().replace('0.1.1', '0.1.2'))
        with self.assertRaisesRegex(SiteGridError, 'podpis'): self.resolve()
        self.assertFalse(any(url.endswith('.tar.gz') for url in self.downloads))

    def test_wrong_public_key_rejected(self):
        wrong = self.root / 'wrong.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(wrong)], check=True, capture_output=True)
        pub = self.root / 'wrong-public.pem'
        subprocess.run(['openssl', 'pkey', '-in', str(wrong), '-pubout', '-out', str(pub)], check=True, capture_output=True)
        with self.assertRaisesRegex(SiteGridError, 'podpis'):
            channel.verify_manifest(self.root / 'signed.json', self.root / 'signed.sig', '0.1.1', pub)

    def test_asset_corruption_rejected(self):
        manifest = self.resolve()
        self.bundle = b'corrupt'
        with self.assertRaisesRegex(SiteGridError, 'SHA-256'): channel.download_bundle(manifest, self.root, fetcher=self.fetch)

    def test_expired_future_and_wrong_repository_rejected(self):
        for overrides in ({'expires_at': int(time.time()) - 1}, {'issued_at': int(time.time()) + 600}, {'repository': 'someone/else'}):
            with self.subTest(overrides=overrides):
                self.create_fixture(**overrides)
                with self.assertRaises(SiteGridError):
                    channel.verify_manifest(self.root / 'signed.json', self.root / 'signed.sig', '0.1.1', self.public)

    def test_signed_manifest_must_match_tag(self):
        with self.assertRaisesRegex(SiteGridError, 'tagowi'):
            channel.verify_manifest(self.root / 'signed.json', self.root / 'signed.sig', '0.1.2', self.public)

    def test_redirects_refuse_http_credentials_and_other_hosts(self):
        for url in ('http://github.com/file', 'https://evil.example/file', 'https://user:pass@github.com/file', 'https://github.com:444/file'):
            with self.subTest(url=url), self.assertRaises(SiteGridError): channel.check_url(url)
        channel.check_url('https://release-assets.githubusercontent.com/file?signature=public-storage-redirect')

    def test_no_release_stops_update_without_deployment(self):
        case = self.lifecycle_case()
        def absent(*args): raise SiteGridError('Brak opublikowanego Release/assetu (HTTP 404).')
        with self.assertRaisesRegex(SiteGridError, 'Brak opublikowanego'):
            channel.automatic_update(argparse.Namespace(yes=False), case.state, key=self.public, fetcher=absent)
        self.assertEqual(case.events, [])
        self.assertEqual((case.root / 'current').resolve(), case.old)

    def test_confirmation_then_update_and_rollback_preserve_history(self):
        case = self.lifecycle_case()
        def confirm(prompt):
            self.assertFalse(any(url.endswith('.tar.gz') for url in self.downloads))
            return 'TAK'
        with patch('builtins.input', confirm), patch.object(lifecycle, 'stage', return_value=case.new), contextlib.redirect_stdout(io.StringIO()):
            channel.automatic_update(argparse.Namespace(yes=False), case.state, key=self.public, fetcher=self.fetch)
        self.assertLess(case.events.index('backup'), case.events.index('migrate'))
        self.assertEqual((case.root / 'current').resolve(), case.new)
        self.assertEqual(json.loads((case.state / 'channel.json').read_text())['version'], '0.1.1')
        with contextlib.redirect_stdout(io.StringIO()): lifecycle.rollback(argparse.Namespace(version=None, yes=True))
        self.assertEqual((case.root / 'current').resolve(), case.old)
        self.assertEqual(case.rows, case.history(case.old))
        self.create_fixture('0.1.0')
        with self.assertRaisesRegex(SiteGridError, 'Cofnięty'):
            channel.automatic_update(argparse.Namespace(yes=True), case.state, key=self.public, fetcher=self.fetch)

    def test_cancel_never_downloads_bundle_or_stops_service(self):
        case = self.lifecycle_case()
        with patch('builtins.input', return_value='NIE'), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(SiteGridError, 'anulowana'):
                channel.automatic_update(argparse.Namespace(yes=False), case.state, key=self.public, fetcher=self.fetch)
        self.assertEqual(case.events, [])
        self.assertFalse(any(url.endswith('.tar.gz') for url in self.downloads))
        self.assertFalse((case.state / 'channel.json').exists())

    def test_current_release_is_explicit_noop(self):
        case = self.lifecycle_case()
        self.create_fixture('0.1.0')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            channel.automatic_update(argparse.Namespace(yes=False), case.state, key=self.public, fetcher=self.fetch)
        self.assertIn('brak nowszego', output.getvalue())
        self.assertEqual(case.events, [])
        self.assertFalse(any(url.endswith('.tar.gz') for url in self.downloads))

    def test_bootstrap_signed_install_and_nginx_retry(self):
        case = self.installer_case()
        with self.assertRaises(test_install_debian.PowerLoss): self.run_bootstrap(case)
        self.assertEqual(json.loads(case.marker.read_text())['phase'], 'dependencies')
        self.run_bootstrap(case)
        self.assertEqual(json.loads(case.marker.read_text())['phase'], 'done')
        self.assertEqual(json.loads((case.state / 'channel.json').read_text())['version'], '0.1.0')

    def test_bootstrap_signed_install_and_mkdir_retry(self):
        case = self.installer_case()
        case.crash = False
        with patch.object(test_install_debian.installer, 'write_json', side_effect=test_install_debian.PowerLoss):
            with self.assertRaises(test_install_debian.PowerLoss): self.run_bootstrap(case)
        self.assertFalse(case.state.exists())
        self.run_bootstrap(case)
        self.assertEqual(json.loads(case.marker.read_text())['phase'], 'done')

    def test_unsigned_bootstrap_never_mutates_installation(self):
        case = self.installer_case()
        (self.root / 'signed.sig').write_bytes(b'x' * 64)
        with self.assertRaisesRegex(SiteGridError, 'podpis'): self.run_bootstrap(case)
        self.assertFalse(case.state.exists())
        self.assertFalse(case.calls)

    def test_old_pinned_bootstrap_retry_never_lowers_seen_version(self):
        case = self.installer_case()
        case.crash = False
        self.run_bootstrap(case)
        channel.remember('0.1.1', case.state)
        self.run_bootstrap(case)
        self.assertEqual(channel.seen_version(case.state), '0.1.1')
        self.assertEqual(json.loads(case.marker.read_text())['phase'], 'done')

    def test_no_release_bootstrap_never_claims_state(self):
        case = self.installer_case()
        def absent(*args): raise SiteGridError('Brak opublikowanego Release/assetu (HTTP 404).')
        with patch.object(channel, 'KEY', self.public), patch.object(channel, 'fetch', absent), patch.object(bootstrap, 'VERSION', '0.1.0'):
            with self.assertRaisesRegex(SiteGridError, 'Brak opublikowanego'):
                bootstrap.install(argparse.Namespace(origin=case.args.origin, yes=True))
        self.assertFalse(case.state.exists())
        self.assertFalse(case.calls)

    def test_signed_bootstrap_refuses_foreign_state(self):
        case = self.installer_case()
        case.state.mkdir()
        (case.state / 'foreign').write_text('keep')
        with self.assertRaisesRegex(SiteGridError, 'odmowa nadpisania'): self.run_bootstrap(case)
        self.assertEqual((case.state / 'foreign').read_text(), 'keep')
        self.assertFalse(any(c[0] == 'apt-get' for c in case.calls))

    def test_cli_manual_mode_preserved_and_partial_flags_rejected(self):
        state = self.root / 'state'
        state.mkdir()
        (state / 'installation.json').write_text('{}')
        with patch.object(manage, 'STATE', state), patch.object(manage, 'lock', contextlib.nullcontext), patch.object(manage.os, 'geteuid', return_value=0), patch.object(lifecycle, 'update') as manual, patch.object(channel, 'automatic_update') as automatic:
            with patch.object(sys, 'argv', ['sitegrid', 'update']): self.assertEqual(manage.main(), 0)
            automatic.assert_called_once()
            self.assertEqual(automatic.call_args.kwargs['key'], Path('/usr/local/lib/sitegrid/release-public.pem'))
            with patch.object(sys, 'argv', ['sitegrid', 'update', '--bundle', 'local', '--version', '0.1.1', '--sha256', 'a' * 64]): self.assertEqual(manage.main(), 0)
            manual.assert_called_once()
            with patch.object(sys, 'argv', ['sitegrid', 'update', '--version', '0.1.1']), contextlib.redirect_stderr(io.StringIO()): self.assertEqual(manage.main(), 1)
            self.assertEqual(manual.call_count, 1)

    def test_bootstrap_is_reproducible_and_command_is_shell_valid(self):
        first, second = self.root / 'first', self.root / 'second'
        for output in (first, second):
            subprocess.run([sys.executable, 'scripts/build-bootstrap.py', '0.1.0', '--public-key', str(self.public), '--output', str(output)], check=True, capture_output=True)
            subprocess.run(['bash', '-n', str(output / 'sitegrid-install-0.1.0.sh')], check=True, capture_output=True)
            subprocess.run(['bash', '-n', str(output / 'INSTALL_COMMAND.txt')], check=True, capture_output=True)
        self.assertEqual((first / 'sitegrid-install-0.1.0.sh').read_bytes(), (second / 'sitegrid-install-0.1.0.sh').read_bytes())
        command = (first / 'INSTALL_COMMAND.txt').read_text()
        parts = shlex.split(command)
        self.assertEqual(len(parts), 3)  # one shell program, including its quoted cleanup trap
        self.assertIn(hashlib.sha256((first / 'sitegrid-install-0.1.0.sh').read_bytes()).hexdigest(), command)
        self.assertNotIn('/main/', command)
        # Execute the runner with harmless host-boundary stubs; checksum is real.
        tools = self.root / 'tools'
        tools.mkdir()
        for name, body in {
            'id': 'echo 0', 'apt-get': 'exit 0',
            'curl': 'for arg; do destination="$arg"; done; cp "$BOOTSTRAP_SOURCE" "$destination"',
            'bash': 'echo verified > "$RUNNER_MARKER"',
        }.items():
            path = tools / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        os_release = self.root / 'os-release'
        os_release.write_text('ID=debian\nVERSION_ID=13\n')
        runner = parts[2].replace('/etc/os-release', str(os_release))
        marker = self.root / 'executed'
        env = {**os.environ, 'PATH': str(tools) + ':' + os.environ['PATH'], 'BOOTSTRAP_SOURCE': str(first / 'sitegrid-install-0.1.0.sh'), 'RUNNER_MARKER': str(marker)}
        subprocess.run(['/bin/bash', '-c', runner], env=env, capture_output=True, check=True)
        self.assertTrue(marker.exists())
        marker.unlink()
        (first / 'sitegrid-install-0.1.0.sh').write_text('tampered bootstrap')
        result = subprocess.run(['/bin/bash', '-c', runner], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())


if __name__ == '__main__': unittest.main()
