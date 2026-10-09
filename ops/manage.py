#!/usr/bin/env python3
import argparse
import sys
from release import SiteGridError, require
from system import ROOT, STATE, lock, app_cli


def main():
    parser = argparse.ArgumentParser(description='SiteGrid — lokalna administracja')
    parser.add_argument('command', choices=['bootstrap-admin'])
    args = parser.parse_args()
    try:
        with lock():
            require((STATE / 'installation.json').is_file(), 'Brak zarządzanej instalacji SiteGrid.')
            require(sys.stdin.isatty() and sys.stdout.isatty(), 'Bootstrap wymaga lokalnego terminala.')
            app_cli(ROOT / 'current', 'bootstrap-cli.js', interactive=True)
        return 0
    except (SiteGridError, OSError) as error:
        print(str(error) if isinstance(error, SiteGridError) else 'Nie można odczytać instalacji SiteGrid.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
