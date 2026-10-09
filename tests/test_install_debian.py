"""Exercise interrupted installer transactions; no host mutations."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
import install_debian as installer
from release import SiteGridError


class PowerLoss(BaseException):
    pass


class InstallerRetryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.lab = Path(temporary.name)
        self.root, self.config, self.state = [self.lab / p for p in ('app', 'config', 'state')]
        self.marker = self.state / 'installation.json'
        self.nginx = self.user = self.db = self.role = False
        self.modified_nginx = False
        self.crash = True
        self.calls = []
        self.sql_calls = []
        self.listeners = ''
        self.args = argparse.Namespace(bundle='/verified-test-bundle', sha256='a' * 64, version='0.1.0', curl_config=None, origin='https://sitegrid.example.test', yes=True)
        self.mapped('/etc/os-release').parent.mkdir(parents=True)
        self.mapped('/etc/os-release').write_text('ID=debian\nVERSION_ID=13\n')
        self.mapped('/proc/meminfo').parent.mkdir(parents=True)
        self.mapped('/proc/meminfo').write_text('MemTotal: 2097152 kB\n')
        for path in ('/run/systemd/system', '/etc/systemd/system', '/usr/local/bin'):
            self.mapped(path).mkdir(parents=True)
        copyfile = shutil.copyfile
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        values = {
            'ROOT': self.root, 'CONFIG': self.config, 'STATE': self.state, 'Path': self.mapped,
            'lock': contextlib.nullcontext, 'command': self.command, 'sql': self.sql,
            'download': lambda *args: None, 'extract_release': self.extract,
            'configure': lambda origin: self.config.mkdir(), 'app_cli': lambda *args: None,
            'grant_runtime': lambda: None, 'health': lambda *args: True,
        }
        for name, value in values.items(): self.stack.enter_context(patch.object(installer, name, value))
        self.stack.enter_context(patch.object(installer.shutil, 'which', side_effect=lambda name: '/usr/sbin/nginx' if name == 'nginx' and self.nginx else None if name == 'nginx' else '/usr/bin/' + name))
        self.stack.enter_context(patch.object(installer.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024 ** 3)))
        self.stack.enter_context(patch.object(installer.shutil, 'copyfile', side_effect=lambda source, dest, **kw: copyfile(source, self.mapped(dest), **kw)))
        self.stack.enter_context(patch.object(installer.pwd, 'getpwnam', side_effect=self.get_user))

    def mapped(self, path):
        path = Path(path)
        if any(path == Path(p) or path.is_relative_to(p) for p in ('/etc', '/proc', '/sys', '/run', '/usr/local')):
            return self.lab / 'system' / str(path).lstrip('/')
        return path

    def get_user(self, name):
        if self.user: return SimpleNamespace(pw_gid=123)
        raise KeyError(name)

    def command(self, args, **kwargs):
        self.calls.append(args)
        if args[0] == 'ss': return self.listeners
        if args[:2] == ['dpkg', '--verify']: return 'modified config' if self.modified_nginx else ''
        if args[:2] == ['apt-get', 'install']:
            self.nginx = True
            self.mapped('/etc/nginx').mkdir(exist_ok=True)
            self.listeners = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=123,fd=6))'
            if self.crash:
                self.crash = False
                raise PowerLoss()  # nginx installed; no DB/role claim or later state write
        if args[0] == 'useradd': self.user = True
        return ''

    def sql(self, statement, database='sitegrid'):
        self.sql_calls.append(statement)
        if 'pg_database' in statement: return str(int(self.db))
        if 'pg_roles' in statement: return str(int(self.role))
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'started')
        if statement.startswith('CREATE ROLE'): self.role = True
        if statement.startswith('CREATE DATABASE'): self.db = True
        return ''

    def extract(self, archive, staging, sha, version):
        (staging / 'ops').mkdir(parents=True)
        for name in ('release.py', 'system.py', 'manage.py', 'lifecycle.py', 'sitegrid', 'sitegrid.service', 'sitegrid-proxy.service'):
            (staging / 'ops' / name).write_text('test fixture')
        return {'version': version}

    def run_installer(self):
        with contextlib.redirect_stdout(io.StringIO()): installer.install(self.args)

    def interrupt_after_nginx(self):
        with self.assertRaises(PowerLoss): self.run_installer()
        self.assertTrue(self.nginx)
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'dependencies')
        self.assertFalse(self.sql_calls)

    def test_retry_after_state_directory_creation_before_receipt(self):
        self.crash = False
        interrupted = []

        def interrupt_before_receipt(path, value):
            self.assertTrue(path.parent.is_dir())  # mkdir completed
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertFalse(path.exists())  # installation.json not written
            interrupted.append(path.parent)
            raise PowerLoss()

        with patch.object(installer, 'write_json', side_effect=interrupt_before_receipt):
            with self.assertRaises(PowerLoss): self.run_installer()
        self.assertEqual(len(interrupted), 1)
        self.assertFalse(self.marker.exists())
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))
        self.run_installer()
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'done')
        self.assertTrue(self.db and self.role and self.user)
        self.assertNotEqual(interrupted[0], self.state)
        self.assertEqual(list(interrupted[0].iterdir()), [])  # leftover was not claimed or removed
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_unmarked_state_directory_is_not_adopted(self):
        self.state.mkdir()
        for contents in ('empty', 'foreign data'):
            with self.subTest(contents=contents):
                if contents != 'empty': (self.state / 'foreign.db').write_text(contents)
                with self.assertRaisesRegex(SiteGridError, 'odmowa nadpisania'): self.run_installer()
                self.assertFalse(self.marker.exists())
                self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))
                if contents != 'empty': self.assertEqual((self.state / 'foreign.db').read_text(), contents)

    def test_symlink_state_directory_is_not_adopted(self):
        foreign = self.lab / 'foreign'
        foreign.mkdir()
        (foreign / 'data').write_text('keep')
        self.state.symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(SiteGridError, 'Zabroniony symlink'): self.run_installer()
        self.assertEqual((foreign / 'data').read_text(), 'keep')
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))

    def test_state_publication_does_not_replace_concurrent_foreign_directory(self):
        write_json = installer.write_json

        def create_foreign_directory(path, value):
            write_json(path, value)
            self.state.mkdir()
            self.foreign_inode = self.state.stat().st_ino

        with patch.object(installer, 'write_json', side_effect=create_foreign_directory):
            with self.assertRaisesRegex(SiteGridError, 'odmowa nadpisania'): self.run_installer()
        self.assertEqual(self.state.stat().st_ino, self.foreign_inode)
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))

    def test_retry_after_apt_installs_nginx_before_original_marker_window(self):
        self.interrupt_after_nginx()
        self.run_installer()
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'done')
        self.assertEqual((self.root / 'current').resolve(), self.root / 'releases/0.1.0')
        self.assertTrue(self.db and self.role and self.user)
        self.assertEqual(sum(c[:2] == ['apt-get', 'install'] for c in self.calls), 2)

    def test_existing_nginx_without_reservation_is_not_adopted(self):
        self.nginx = True
        with self.assertRaisesRegex(SiteGridError, 'Istniejąca instalacja nginx'): self.run_installer()
        self.assertFalse(self.marker.exists())
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))

    def test_pending_dependencies_do_not_claim_foreign_database_or_role(self):
        self.interrupt_after_nginx()
        for attribute in ('db', 'role'):
            with self.subTest(attribute=attribute):
                setattr(self, attribute, True)
                with self.assertRaisesRegex(SiteGridError, 'już istnieje'): self.run_installer()
                self.assertEqual(json.loads(self.marker.read_text())['phase'], 'dependencies')
                self.assertFalse(any(s.startswith('CREATE') for s in self.sql_calls))
                self.assertFalse(any(c[:3] == ['systemctl', 'disable', '--now'] for c in self.calls))
                setattr(self, attribute, False)

    def test_pending_dependencies_do_not_claim_foreign_sitegrid_files_or_user(self):
        self.interrupt_after_nginx()
        self.root.mkdir()
        with self.assertRaisesRegex(SiteGridError, 'odmowa nadpisania'): self.run_installer()
        self.root.rmdir()  # only this empty test fixture
        self.user = True
        with self.assertRaisesRegex(SiteGridError, 'niezarządzany użytkownik'): self.run_installer()
        self.assertFalse(self.sql_calls)

    def test_pending_modified_nginx_is_not_adopted(self):
        self.interrupt_after_nginx()
        self.modified_nginx = True
        with self.assertRaisesRegex(SiteGridError, 'nginx została zmieniona'): self.run_installer()
        self.assertEqual(sum(c[:2] == ['apt-get', 'install'] for c in self.calls), 1)

    def test_pending_foreign_nginx_vhost_is_not_adopted(self):
        self.interrupt_after_nginx()
        enabled = self.mapped('/etc/nginx/sites-enabled')
        enabled.mkdir()
        (enabled / 'default').symlink_to(self.lab / 'foreign.conf')
        with self.assertRaisesRegex(SiteGridError, 'Obca konfiguracja nginx'): self.run_installer()
        self.assertEqual(sum(c[:2] == ['apt-get', 'install'] for c in self.calls), 1)

    def test_pending_foreign_listener_is_not_stopped(self):
        self.interrupt_after_nginx()
        self.listeners = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("other",pid=123,fd=6))'
        with self.assertRaisesRegex(SiteGridError, 'obcy proces'): self.run_installer()
        self.assertEqual(sum(c[:2] == ['apt-get', 'install'] for c in self.calls), 1)

    def test_pending_reservation_rejects_another_artifact(self):
        self.interrupt_after_nginx()
        self.args.sha256 = 'b' * 64
        with self.assertRaisesRegex(SiteGridError, 'tego samego'): self.run_installer()
        self.assertEqual(sum(c[:2] == ['apt-get', 'install'] for c in self.calls), 1)


if __name__ == '__main__': unittest.main()
