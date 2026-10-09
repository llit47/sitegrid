"""Trusted payload of the version-pinned standalone bootstrap."""
import argparse
import os
from pathlib import Path
import sys
import tempfile
from argparse import Namespace
import channel
import install_debian
from release import SiteGridError, require

VERSION = '@SITEGRID_VERSION@'  # replaced only by the bootstrap builder


def install(args):
    with tempfile.TemporaryDirectory(prefix='sitegrid-bootstrap-') as directory:
        manifest = channel.resolve(directory, VERSION)
        archive, sha = channel.download_bundle(manifest, directory)
        install_debian.install(Namespace(bundle=str(archive), version=manifest['version'], sha256=sha,
                                         curl_config=None, origin=args.origin, yes=args.yes,
                                         signed_version=manifest['version']))


def main():
    parser = argparse.ArgumentParser(description='SiteGrid — publiczne podpisane wydanie, gotowy Debian 13')
    parser.add_argument('--origin')
    parser.add_argument('--yes', action='store_true')
    args = parser.parse_args()
    try:
        os.umask(0o077)
        require(os.geteuid() == 0, 'Instalator wymaga root.')
        install(args)
    except (SiteGridError, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error) if isinstance(error, SiteGridError) else 'Bootstrap zatrzymany: sprawdź metadane i stan instalacji.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__': sys.exit(main())
