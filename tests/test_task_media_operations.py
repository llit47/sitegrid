"""Managed proxy/storage integration; lifecycle contracts retain their original tests."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
import system
import lifecycle
from release import SiteGridError


class MediaOperationsTests(unittest.TestCase):
    def test_existing_proxy_keeps_limits_and_gains_only_upload_location(self):
        with tempfile.TemporaryDirectory() as path:
            config = Path(path)
            nginx = config / 'nginx.conf'
            original = 'server {\n    client_max_body_size 8k;\n    location / {\n      proxy_pass http://127.0.0.1:3000;\n    }\n}\n'
            nginx.write_text(original)
            calls = []
            with patch.object(system, 'CONFIG', config), patch.object(system, 'command', side_effect=lambda argv: calls.append(argv)):
                system.configure_media_proxy()
                once = nginx.read_text()
                system.configure_media_proxy()
            self.assertEqual(nginx.read_text(), once)
            self.assertIn('client_max_body_size 8k;', once)
            self.assertEqual(once.count('include /etc/sitegrid/task-media-proxy.conf;'), 1)
            media = (config / 'task-media-proxy.conf').read_text()
            self.assertIn('/comments$', media)
            self.assertIn('client_max_body_size 50m;', media)
            self.assertIn('proxy_request_buffering off;', media)
            self.assertIn(['systemctl', 'reload', 'sitegrid-proxy.service'], calls)
            (config / 'task-media-proxy.conf').write_text('operator changes')
            with patch.object(system, 'CONFIG', config), self.assertRaises(SiteGridError):
                system.configure_media_proxy()

    def test_custom_proxy_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as path:
            config = Path(path)
            (config / 'nginx.conf').write_text('custom configuration')
            with patch.object(system, 'CONFIG', config), self.assertRaisesRegex(SiteGridError, 'Niestandardowa'):
                system.configure_media_proxy()
            self.assertEqual((config / 'nginx.conf').read_text(), 'custom configuration')

    def test_schema14_backup_uses_database_plus_media_and_propagates_failure(self):
        with tempfile.TemporaryDirectory() as path:
            with patch.object(lifecycle, 'STATE', Path(path)), patch.object(lifecycle, 'schema_state', return_value=[{}]*14), patch.object(lifecycle, 'sql', return_value='1'), patch.object(lifecycle, 'media_command', return_value={'path': 'complete.backup', 'mediaCount': 3}) as backup:
                result = lifecycle.backup_database('fixture')
                self.assertEqual(result['mediaCount'], 3)
                self.assertEqual(backup.call_args.args, ('backup', Path(path) / 'backups/fixture.backup'))
            with patch.object(lifecycle, 'STATE', Path(path)), patch.object(lifecycle, 'schema_state', return_value=[{}]*14), patch.object(lifecycle, 'sql', return_value='1'), patch.object(lifecycle, 'media_command', side_effect=SiteGridError('missing photo')), self.assertRaisesRegex(SiteGridError, 'missing photo'):
                lifecycle.backup_database('failed')

    def test_media_maintenance_refuses_running_service(self):
        with patch.object(lifecycle, 'installed'), patch.object(lifecycle, 'service_state', return_value='active'), patch.object(lifecycle, 'media_command') as work, self.assertRaises(SiteGridError):
            lifecycle.media_operation(argparse.Namespace(command='backup'))
        work.assert_not_called()
