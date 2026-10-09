"""Trusted release transport, metadata validation and safe extraction (stdlib only)."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import tarfile


class SiteGridError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SiteGridError(message)


def command(args, *, env=None, input=None, cwd=None):
    result = subprocess.run(args, env=env, input=input, cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        # Do not print raw commands/stdin/stderr: they can contain credentials.
        raise SiteGridError(f"Polecenie {Path(args[0]).name} nie powiodło się (kod {result.returncode}).")
    return result.stdout.strip()


def download(source, destination, curl_config=None):
    if source.startswith('https://'):
        from urllib.parse import urlsplit
        parsed = urlsplit(source)
        require(parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
                'URL artefaktu nie może zawierać sekretów ani parametrów; użyj chronionej konfiguracji curl.')
        args = ['curl', '--disable']
        if curl_config:
            path = Path(curl_config)
            require(path.is_file() and not path.is_symlink() and path.stat().st_uid == 0 and path.stat().st_mode & 0o077 == 0,
                    'Konfiguracja curl musi należeć do root i mieć prawa 0600.')
            args += ['--config', str(path)]
        args += ['--fail', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
                 '--connect-timeout', '15', '--max-time', '600', '--max-filesize', str(1024 ** 3),
                 '--output', str(destination), source]
        # No redirects: avoid forwarding authorization to a different origin.
        command(args)
    else:
        import shutil
        require(not '://' in source, 'Źródło musi być lokalnym plikiem albo HTTPS.')
        path = Path(source)
        require(path.is_file(), 'Nie znaleziono pliku wydania.')
        require(path.stat().st_size <= 1024 ** 3, 'Artefakt jest zbyt duży.')
        shutil.copyfile(path, destination)


def validate_manifest(manifest):
    require(isinstance(manifest, dict), 'Manifest musi być obiektem JSON.')
    require(manifest.get('format') == 1, 'Nieobsługiwany format wydania.')
    require(isinstance(manifest.get('version'), str) and re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?', manifest['version']), 'Nieprawidłowa wersja.')
    require(manifest.get('platform') == 'linux' and manifest.get('arch') in ('x64', 'arm64'), 'Nieobsługiwana platforma.')
    require(isinstance(manifest.get('node'), str) and re.fullmatch(r'24\.\d+\.\d+', manifest['node']), 'Wydanie wymaga Node 24 LTS.')
    require(manifest.get('postgresMajor') == 17, 'Nieobsługiwana wersja PostgreSQL.')
    schema = manifest.get('schema', {})
    require(isinstance(schema, dict), 'Kontrakt schematu musi być obiektem JSON.')
    require(all(type(schema.get(key)) is int and schema[key] >= 0 for key in ('target', 'min', 'max', 'upgradeMin', 'upgradeMax')),
            'Brak jawnego kontraktu zgodności schematu.')
    require(0 < schema['min'] <= schema['target'] <= schema['max'] and schema['upgradeMin'] <= schema['upgradeMax'] <= schema['target'],
            'Nieprawidłowy kontrakt zgodności schematu.')


def extract_release(archive, destination, expected_sha, expected_version):
    require(re.fullmatch('[a-f0-9]{64}', expected_sha or ''), 'Wymagana zaufana suma SHA-256 (64 znaki).')
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?', expected_version or ''), 'Wymagana przypięta wersja.')
    sha = hashlib.sha256()
    with open(archive, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    require(sha.hexdigest() == expected_sha, 'Integralność wydania: SHA-256 niezgodne. Instalacja zatrzymana.')
    destination = Path(destination)
    require(not destination.exists(), 'Katalog docelowy już istnieje.')
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        require(len(members) <= 100000 and sum(m.size for m in members) <= 4 * 1024 ** 3, 'Przekroczony limit rozpakowanego wydania.')
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and (member.isfile() or member.isdir()), 'Niebezpieczna ścieżka lub link w archiwum.')
            require(str(path) not in seen, 'Powtórzona ścieżka w archiwum.')
            seen.add(str(path))
        metadata = next((m for m in members if str(PurePosixPath(m.name)) == 'release.json'), None)
        require(metadata and metadata.isfile() and metadata.size < 8192, 'Brak manifestu wydania.')
        manifest = json.load(tar.extractfile(metadata))
        validate_manifest(manifest)
        require(manifest['version'] == expected_version, 'Manifest nie odpowiada przypiętej wersji.')
        machine = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
        require(machine == manifest['arch'], 'Wydanie nie odpowiada architekturze serwera.')
        destination.mkdir(mode=0o755)
        tar.extractall(destination, members=members, filter='data')
    destination.chmod(0o755)
    for path in destination.rglob('*'):
        path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    for required in ('runtime/bin/node', 'dist/server/main.js', 'dist/server/migrate-cli.js', 'dist/server/bootstrap-cli.js', 'dist/web/index.html', 'migrations/001_installation.sql', 'node_modules/argon2/package.json'):
        require((destination / required).is_file(), f'Niekompletne wydanie: {required}.')
    require(command([str(destination / 'runtime/bin/node'), '--version']) == 'v' + manifest['node'], 'Runtime nie odpowiada manifestowi.')
    # Execute only after checking the outer archive against a separately trusted digest.
    command([str(destination / 'runtime/bin/node'), '--input-type=module', '-e', "import argon2 from 'argon2'; await argon2.hash('native-addon-smoke-check', {memoryCost:8192,timeCost:1});"], cwd=destination)
    return manifest


def read_manifest(directory):
    with open(Path(directory) / 'release.json') as stream:
        manifest = json.load(stream)
    validate_manifest(manifest)
    return manifest


def atomic_link(target, link):
    link = Path(link)
    temporary = link.with_name(link.name + '.next')
    require(not temporary.exists() and not temporary.is_symlink(), 'Pozostał symlink .next; sprawdź przerwane wdrożenie.')
    temporary.symlink_to(target)
    os.replace(temporary, link)
    descriptor = os.open(link.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
