#!/usr/bin/env python3
import argparse
import os
import sys
from release import SiteGridError, require
from system import ROOT, STATE, lock, app_cli
import lifecycle


def main():
    parser = argparse.ArgumentParser(description='SiteGrid — lokalna administracja')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('bootstrap-admin')
    commands.add_parser('status')
    update = commands.add_parser('update')
    for name in ('bundle', 'sha256', 'version'):
        update.add_argument('--' + name, required=True)
    update.add_argument('--curl-config')
    update.add_argument('--yes', action='store_true')
    rollback = commands.add_parser('rollback')
    rollback.add_argument('--version')
    rollback.add_argument('--yes', action='store_true')
    args = parser.parse_args()
    try:
        os.umask(0o077)
        require(os.geteuid() == 0, 'Polecenie wymaga root.')
        if args.command == 'status':
            lifecycle.status()
            return 0
        with lock():
            require((STATE / 'installation.json').is_file(), 'Brak zarządzanej instalacji SiteGrid.')
            if args.command == 'update': lifecycle.update(args)
            elif args.command == 'rollback': lifecycle.rollback(args)
            else:
                require(sys.stdin.isatty() and sys.stdout.isatty(), 'Bootstrap wymaga lokalnego terminala.')
                app_cli(ROOT / 'current', 'bootstrap-cli.js', interactive=True)
        return 0
    except (SiteGridError, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error) if isinstance(error, SiteGridError) else 'Nie można odczytać instalacji SiteGrid.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
