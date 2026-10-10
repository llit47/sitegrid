import argparse
import contextlib
import io
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
import lifecycle as lc
from release import SiteGridError, atomic_link
from system import write_json


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'app'
        self.state = Path(self.tmp.name) / 'state'
        self.state.mkdir()
        (self.root / 'releases').mkdir(parents=True)
        self.old = self.release('0.1.0')
        self.new = self.release('0.1.1')
        atomic_link(self.old, self.root / 'current')
        write_json(self.state / 'installation.json', {'phase': 'done'})
        self.rows = self.history(self.old)
        self.events = []
        for name, value in [('ROOT', self.root), ('STATE', self.state), ('JOURNAL', self.state / 'deployment.json')]:
            p = patch.object(lc, name, value); p.start(); self.addCleanup(p.stop)
        for name, value in [('schema_state', lambda: self.rows), ('command', lambda args: self.events.append(args)),
                            ('backup_database', lambda operation: self.events.append('backup') or {'path': '/protected/test.dump'}),
                            ('app_cli', lambda *args: self.events.append('migrate')), ('grant_runtime', lambda: None),
                            ('health', lambda *args: True), ('service_state', lambda: 'inactive')]:
            p = patch.object(lc, name, value); p.start(); self.addCleanup(p.stop)

    def release(self, version):
        root = self.root / 'releases' / version
        root.mkdir()
        manifest = json.loads(Path('release.json').read_text())
        manifest['version'] = version
        (root / 'release.json').write_text(json.dumps(manifest))
        shutil.copytree('migrations', root / 'migrations')
        (root / '.archive-sha256').write_text('a' * 64)
        return root

    def history(self, release):
        return [{'version': i + 1, 'checksum': h} for i, h in enumerate(lc.migration_checksums(release))]

    def test_update_backs_up_before_migration_and_switch(self):
        lc.deploy(self.new, self.old, {}, 'update', migrate=True)
        self.assertLess(self.events.index('backup'), self.events.index('migrate'))
        self.assertLess(self.events.index('migrate'), self.events.index(['systemctl', 'restart', 'sitegrid.service']))
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertEqual(lc.journal()['phase'], 'done')
        self.assertEqual(lc.journal()['completed_versions'], ['0.1.0', '0.1.1'])

    def test_backup_failure_never_runs_migrations(self):
        with patch.object(lc, 'backup_database', side_effect=SiteGridError('backup failed')):
            with self.assertRaisesRegex(SiteGridError, 'poprzednie wydanie działa'):
                lc.deploy(self.new, self.old, {}, 'update', migrate=True)
        self.assertNotIn('migrate', self.events)
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(lc.journal()['phase'], 'recovered')

    def test_failed_readiness_recovers_only_compatible_old_code(self):
        with patch.object(lc, 'health', side_effect=lambda version: version == '0.1.0'):
            with self.assertRaises(SiteGridError): lc.deploy(self.new, self.old, {}, 'update', migrate=True)
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(lc.journal()['phase'], 'recovered')

    def test_newer_db_blocks_automatic_old_code_restart(self):
        manifest = json.loads((self.new / 'release.json').read_text())
        target = manifest['schema']['target'] + 1
        manifest['schema'].update(target=target, min=target, max=target, upgradeMax=target)
        (self.new / 'release.json').write_text(json.dumps(manifest))
        (self.new / f'migrations/{target:03d}_test.sql').write_text('SELECT 1;')
        def migrated_then_failed(*args):
            self.rows = self.history(self.new)
            raise SiteGridError('grant failed after migration')
        with patch.object(lc, 'app_cli', side_effect=migrated_then_failed):
            with self.assertRaisesRegex(SiteGridError, 'restore'):
                lc.deploy(self.new, self.old, {}, 'update', migrate=True)
        self.assertNotIn(['systemctl', 'restart', 'sitegrid.service'], self.events)
        self.assertEqual(lc.journal()['phase'], 'needs_restore')
        with self.assertRaises(SiteGridError): lc.no_pending(lc.journal())

    def test_rollback_never_migrates_and_preserves_db(self):
        atomic_link(self.new, self.root / 'current')
        write_json(lc.JOURNAL, {'phase': 'done', 'completed_versions': ['0.1.0', '0.1.1']})
        before = list(self.rows)
        lc.rollback(argparse.Namespace(version=None, yes=True))
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(self.rows, before)
        self.assertNotIn('migrate', self.events)
        self.assertNotIn('backup', self.events)

    def test_incompatible_rollback_rejected_before_stopping_service(self):
        atomic_link(self.new, self.root / 'current')
        write_json(lc.JOURNAL, {'phase': 'done', 'completed_versions': ['0.1.0', '0.1.1']})
        self.rows.append({'version': len(self.rows) + 1, 'checksum': 'b' * 64})
        with self.assertRaisesRegex(SiteGridError, 'Rollback zablokowany'):
            lc.rollback(argparse.Namespace(version='0.1.0', yes=True))
        self.assertEqual(self.events, [])
        self.assertEqual((self.root / 'current').resolve(), self.new)

    def pr12_release(self):
        # Concrete M07 -> M08 contract; retain the actual historical SQL/checksums.
        self.schema_release(self.old, 9)

    def schema_release(self, release, target):
        manifest = json.loads((release / 'release.json').read_text())
        manifest['schema'] = {'target': target, 'min': target, 'max': target, 'upgradeMin': 0, 'upgradeMax': target}
        (release / 'release.json').write_text(json.dumps(manifest))
        for migration in (release / 'migrations').glob('*.sql'):
            if int(migration.name[:3]) > target:
                migration.unlink()

    def test_pr13_update_from_schema9_backs_up_before_schema10_activation(self):
        self.pr12_release()
        self.schema_release(self.new, 10)
        self.rows = self.history(self.old)
        with patch.object(lc, 'sql', return_value='170000'):
            lc.can_upgrade(self.new, self.rows)
        def migrate_schema10(*args):
            self.events.append('migrate')
            self.rows = self.history(self.new)
        with patch.object(lc, 'app_cli', side_effect=migrate_schema10):
            lc.deploy(self.new, self.old, {}, 'update', migrate=True)
        self.assertEqual(len(self.rows), 10)
        self.assertLess(self.events.index('backup'), self.events.index('migrate'))
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertEqual(lc.journal()['phase'], 'done')

    def test_pr13_schema10_blocks_pr12_rollback_before_stopping_service(self):
        self.pr12_release()
        self.schema_release(self.new, 10)
        self.rows = self.history(self.new)
        atomic_link(self.new, self.root / 'current')
        write_json(lc.JOURNAL, {'phase': 'done', 'completed_versions': ['0.1.0', '0.1.1']})
        with self.assertRaisesRegex(SiteGridError, 'Rollback zablokowany'):
            lc.rollback(argparse.Namespace(version='0.1.0', yes=True))
        self.assertEqual(self.events, [])
        self.assertEqual((self.root / 'current').resolve(), self.new)

    def test_pr16_update_from_schema10_backs_up_before_schema11_activation(self):
        self.schema_release(self.old, 10)
        self.rows = self.history(self.old)
        with patch.object(lc, 'sql', return_value='170000'):
            lc.can_upgrade(self.new, self.rows)
        def migrate_schema11(*args):
            self.events.append('migrate')
            self.rows = self.history(self.new)
        with patch.object(lc, 'app_cli', side_effect=migrate_schema11):
            lc.deploy(self.new, self.old, {}, 'update', migrate=True)
        self.assertEqual(len(self.rows), 11)
        self.assertLess(self.events.index('backup'), self.events.index('migrate'))
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertEqual(lc.journal()['phase'], 'done')

    def test_pr16_schema11_blocks_pr15_rollback_before_stopping_service(self):
        self.schema_release(self.old, 10)
        self.rows = self.history(self.new)
        atomic_link(self.new, self.root / 'current')
        write_json(lc.JOURNAL, {'phase': 'done', 'completed_versions': ['0.1.0', '0.1.1']})
        with self.assertRaisesRegex(SiteGridError, 'Rollback zablokowany'):
            lc.rollback(argparse.Namespace(version='0.1.0', yes=True))
        self.assertEqual(self.events, [])
        self.assertEqual((self.root / 'current').resolve(), self.new)

    def test_default_rollback_uses_immediately_previous_active_release(self):
        latest = self.release('0.1.2')
        atomic_link(latest, self.root / 'current')
        write_json(lc.JOURNAL, {'phase': 'done', 'from': '0.1.0', 'completed_versions': ['0.1.0', '0.1.1', '0.1.2']})
        lc.rollback(argparse.Namespace(version=None, yes=True))
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_changed_migration_history_is_rejected(self):
        self.rows[0]['checksum'] = 'corrupt'
        with self.assertRaisesRegex(SiteGridError, 'Historia migracji'):
            lc.can_upgrade(self.new, self.rows)
        self.assertEqual(self.events, [])

    def test_interrupted_deployment_requires_recovery(self):
        for phase in ['prepared', 'stopping', 'backup', 'migrating', 'activating', 'needs_restore']:
            with self.subTest(phase=phase), self.assertRaisesRegex(SiteGridError, 'Przerwane'):
                lc.no_pending({'phase': phase})

    def test_status_reports_current_when_database_is_down(self):
        output = io.StringIO()
        with patch.object(lc, 'schema_state', side_effect=SiteGridError('DB down')), patch.object(lc, 'health', return_value=False), contextlib.redirect_stdout(output):
            lc.status()
        report = json.loads(output.getvalue())
        self.assertEqual(report['current'], '0.1.0')
        self.assertFalse(report['ready'])
        self.assertIsNone(report['schema'])


if __name__ == '__main__': unittest.main()
