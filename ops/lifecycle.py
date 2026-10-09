"""Pinned deployments with a durable journal, DB backup and guarded code rollback."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid
from release import SiteGridError, require, command, download, extract_release, read_manifest, atomic_link
from system import ROOT, STATE, sql, write_json, app_cli, grant_runtime, health

JOURNAL = STATE / 'deployment.json'
FINISHED = ('done', 'recovered', 'rejected')


def installed():
    marker = STATE / 'installation.json'
    require(marker.is_file() and json.loads(marker.read_text()).get('phase') == 'done', 'Brak ukończonej instalacji SiteGrid.')
    current = (ROOT / 'current').resolve(strict=True)
    require(current.parent == (ROOT / 'releases').resolve() and current.is_dir(), 'Nieprawidłowy symlink current.')
    manifest = read_manifest(current)
    require(current.name == manifest['version'], 'Wersja aktywnego katalogu nie odpowiada manifestowi.')
    return current, manifest


def journal():
    return json.loads(JOURNAL.read_text()) if JOURNAL.exists() else {}


def no_pending(state):
    require(not state or state.get('phase') in FINISHED,
            'Przerwane wdrożenie: sitegrid status. Sprawdź journal, backup i schemat; wymagane kontrolowane odzyskanie przed kolejną operacją.')


def schema_state():
    return json.loads(sql("SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT version, checksum FROM schema_migrations ORDER BY version) t;"))


def migration_checksums(release):
    files = sorted((Path(release) / 'migrations').glob('*.sql'))
    require(files and all(re.fullmatch(r'\d{3}_[a-z0-9_]+\.sql', f.name) and int(f.name[:3]) == i + 1 for i, f in enumerate(files)), 'Nieprawidłowa historia migracji wydania.')
    manifest = read_manifest(release)
    require(len(files) == manifest['schema']['target'], 'Manifest nie odpowiada migracjom wydania.')
    return [hashlib.sha256(f.read_bytes()).hexdigest() for f in files]


def compatible(release, rows):
    hashes = migration_checksums(release)
    contract = read_manifest(release)['schema']
    # Current API readiness requires an exact migration history. A broad manifest
    # alone cannot make old code compatible with a newer database.
    return contract['min'] <= len(rows) <= contract['max'] and len(rows) == len(hashes) and all(
        r['version'] == i + 1 and r['checksum'] == hashes[i] for i, r in enumerate(rows))


def can_upgrade(release, rows):
    hashes = migration_checksums(release)
    contract = read_manifest(release)['schema']
    require(contract['upgradeMin'] <= len(rows) <= contract['upgradeMax'] and len(rows) <= len(hashes), 'Wydanie nie obsługuje aktualnego schematu; brak downgrade DB.')
    require(all(r['version'] == i + 1 and r['checksum'] == hashes[i] for i, r in enumerate(rows)), 'Historia migracji DB nie odpowiada wydaniu; aktualizacja zatrzymana.')
    require(int(sql('SHOW server_version_num;')) // 10000 == read_manifest(release)['postgresMajor'], 'Niezgodna wersja PostgreSQL.')


def backup_database(operation):
    directory = STATE / 'backups'
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    require(shutil.disk_usage(directory).free > int(sql("SELECT pg_database_size('sitegrid');")) * 2 + 256 * 1024 ** 2,
            'Za mało miejsca na backup DB; migracje nie zostały uruchomione.')
    destination = directory / (operation + '.dump')
    with destination.open('xb') as stream:
        os.chmod(destination, 0o600)
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'pg_dump', '--format=custom', '--dbname=sitegrid'], stdout=stream, stderr=subprocess.PIPE)
        require(result.returncode == 0, 'Backup PostgreSQL nie powiódł się; migracje nie zostały uruchomione.')
        stream.flush()
        os.fsync(stream.fileno())
    command(['pg_restore', '--list', str(destination)])
    digest = hashlib.sha256()
    with destination.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return {'path': str(destination), 'sha256': digest.hexdigest()}


def stage(args):
    target = ROOT / 'releases' / args.version
    with tempfile.TemporaryDirectory(prefix='sitegrid-update-') as directory:
        archive = Path(directory) / 'release.tar.gz'
        download(args.bundle, archive, args.curl_config)
        staging = Path(directory) / 'release'
        extract_release(archive, staging, args.sha256, args.version)
        can_upgrade(staging, schema_state())
        require(not target.is_symlink(), 'Katalog wydania jest symlinkiem; odmowa nadpisania.')
        if target.exists():
            require((target / '.archive-sha256').read_text().strip() == args.sha256, 'Istniejące wydanie ma inną sumę; nic nie zostanie nadpisane.')
        else:
            incoming = target.with_name(target.name + '.incoming')
            require(not incoming.exists() and not incoming.is_symlink(), 'Pozostał katalog .incoming; sprawdź przerwane wdrożenie.')
            require(shutil.disk_usage(ROOT).free > sum(p.stat().st_size for p in staging.rglob('*') if p.is_file()) + 256 * 1024 ** 2, 'Za mało miejsca na wydanie.')
            shutil.copytree(staging, incoming)
            (incoming / '.archive-sha256').write_text(args.sha256 + '\n')
            os.rename(incoming, target)
    return target


def activate(target):
    atomic_link(target, ROOT / 'current')
    command(['systemctl', 'restart', 'sitegrid.service'])
    require(health(target.name), 'Nowe wydanie nie przeszło readiness.')


def service_state():
    result = subprocess.run(['systemctl', 'is-active', 'sitegrid.service'], text=True, capture_output=True)
    value = result.stdout.strip()
    return value if value in ('active', 'inactive', 'failed', 'activating', 'deactivating') else 'unknown'


def deploy(target, old, state, operation, migrate=False):
    record = {'operation': uuid.uuid4().hex, 'action': operation, 'from': old.name, 'to': target.name,
              'phase': 'prepared', 'completed_versions': state.get('completed_versions', [old.name])}
    write_json(JOURNAL, record)
    try:
        record['phase'] = 'stopping'
        write_json(JOURNAL, record)
        command(['systemctl', 'stop', 'sitegrid.service'])
        if migrate:
            record['phase'] = 'backup'
            write_json(JOURNAL, record)
            record['backup'] = backup_database(record['operation'])
            record['phase'] = 'migrating'
            write_json(JOURNAL, record)
            app_cli(target, 'migrate-cli.js')
            grant_runtime()
        require(compatible(target, schema_state()), 'Schemat nie odpowiada wydaniu po migracji.')
        record['phase'] = 'activating'
        write_json(JOURNAL, record)
        activate(target)
        record['phase'] = 'done'
        if target.name not in record['completed_versions']: record['completed_versions'].append(target.name)
        write_json(JOURNAL, record)
        print(f'Aktywne wydanie: {target.name}; gotowość potwierdzona.' + (f" Backup: {record['backup']['path']}" if migrate else ' DB i konfiguracja zachowane.'))
    except (SiteGridError, OSError, ValueError, KeyError, TypeError) as error:
        record['failed_phase'] = record['phase']
        # Never downgrade or automatically restore PostgreSQL. Restart the old
        # code only after independently checking the actual resulting history.
        recovered = False
        try:
            command(['systemctl', 'stop', 'sitegrid.service'])
            if compatible(old, schema_state()):
                activate(old)
                recovered = True
        except (SiteGridError, OSError, ValueError, KeyError, TypeError):
            pass
        record['phase'] = 'recovered' if recovered else 'needs_restore'
        write_json(JOURNAL, record)
        current = (ROOT / 'current').resolve().name
        message = f'Wdrożenie zatrzymane. Current: {current}; ' + ('poprzednie wydanie działa.' if recovered else f'stan usługi: {service_state()}; wymagany kontrolowany restore DB/sprawdzenie usługi. Nie wykonano downgrade ani restore.')
        if record.get('backup'): message += f" Backup: {record['backup']['path']}."
        raise SiteGridError(message) from error


def update(args):
    old, _ = installed()
    state = journal()
    no_pending(state)
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?', args.version or ''), 'Wymagana przypięta wersja.')
    require(args.version != old.name, 'To wydanie jest już aktywne; użyj sitegrid status.')
    require(args.yes or input(f'Aktualizować {old.name} do {args.version}, z backupem DB? Wpisz TAK: ').strip() == 'TAK', 'Aktualizacja anulowana.')
    target = stage(args)
    deploy(target, old, state, 'update', migrate=True)


def rollback(args):
    old, _ = installed()
    state = journal()
    no_pending(state)
    versions = state.get('completed_versions', [old.name])
    require(old.name in versions and versions.index(old.name) > 0, 'Brak wcześniejszego ukończonego wydania.')
    earlier = versions[:versions.index(old.name)]
    version = args.version or (state.get('from') if state.get('from') in earlier else earlier[-1])
    require(version in earlier, 'Rollback wymaga wcześniejszego ukończonego wydania.')
    target = ROOT / 'releases' / version
    require(not target.is_symlink() and target.is_dir() and (target / '.archive-sha256').is_file(), 'Niekompletne wcześniejsze wydanie.')
    require(read_manifest(target)['version'] == version and compatible(target, schema_state()),
            'Rollback zablokowany: wcześniejsze wydanie nie obsługuje obecnej DB. Wymagany kontrolowany restore z backupu; nie wykonano downgrade.')
    require(args.yes or input(f'Przełączyć kod {old.name} na {version}, zachowując DB? Wpisz TAK: ').strip() == 'TAK', 'Rollback anulowany.')
    deploy(target, old, state, 'rollback')


def status():
    current, manifest = installed()
    state = journal()
    try:
        schema = len(schema_state())
    except (SiteGridError, OSError, ValueError):
        schema = None
    print(json.dumps({'current': manifest['version'], 'service': service_state(), 'ready': health(current.name, 1), 'schema': schema, 'deployment': state}, indent=2))
