#!/usr/bin/env python3
import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
from release import SiteGridError, require, command, download, extract_release, atomic_link, read_manifest
from system import ROOT, CONFIG, STATE, RUNTIME_DB_URL, lock, write_json, sql, app_cli, grant_runtime, health


def preflight(managed, dependencies=False):
    release = dict(line.strip().split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(release.get('ID', '').strip('"') == 'debian' and release.get('VERSION_ID', '').strip('"') == '13', 'Wymagany Debian 13.')
    require(Path('/run/systemd/system').is_dir(), 'Wymagany uruchomiony systemd (PID 1).')
    require((os.cpu_count() or 0) >= 2, 'Wymagane co najmniej 2 vCPU.')
    memory = int(re.search(r'MemTotal:\s+(\d+)', Path('/proc/meminfo').read_text())[1]) * 1024
    cgroup_limit = Path('/sys/fs/cgroup/memory.max')
    if cgroup_limit.exists() and cgroup_limit.read_text().strip().isdigit():
        memory = min(memory, int(cgroup_limit.read_text()))
    require(memory >= 1536 * 1024 ** 2, 'Wymagane co najmniej 2 GiB przydzielonej pamięci (zalecane 8 GiB).')
    require(shutil.disk_usage('/opt').free >= 6 * 1024 ** 3, 'Wymagane 6 GiB wolnego miejsca w /opt (zalecany dysk 40 GiB).')
    for executable in ('python3', 'apt-get', 'systemctl', 'runuser', 'ss'):
        require(shutil.which(executable), f'Brak zależności: {executable}.')
    for path in (ROOT, CONFIG, STATE):
        require(not path.is_symlink(), f'Zabroniony symlink: {path}.')
        require(managed or (dependencies and path == STATE) or not path.exists(), f'Istniejący {path}; odmowa nadpisania danych bez znacznika instalacji.')
    if not managed:
        for path in ('/usr/local/bin/sitegrid', '/usr/local/lib/sitegrid', '/etc/systemd/system/sitegrid.service', '/etc/systemd/system/sitegrid-proxy.service'):
            require(not Path(path).exists(), f'Istnieje niezarządzany plik {path}.')
        try:
            pwd.getpwnam('sitegrid')
            raise SiteGridError('Istnieje niezarządzany użytkownik sitegrid.')
        except KeyError:
            pass
        if dependencies and shutil.which('nginx'):
            require(not Path('/etc/nginx').is_symlink(), 'Obca konfiguracja nginx; odmowa przejęcia.')
            require(not command(['dpkg', '--verify', 'nginx-common']), 'Konfiguracja nginx została zmieniona; odmowa przejęcia obcej instalacji.')
            for directory, allowed in (('conf.d', set()), ('sites-available', {'default'}), ('sites-enabled', {'default'})):
                path = Path('/etc/nginx') / directory
                require(not path.is_symlink(), 'Obca konfiguracja nginx; odmowa przejęcia.')
                require(not path.exists() or {p.name for p in path.iterdir()} <= allowed, 'Obca konfiguracja nginx; odmowa przejęcia.')
            enabled = Path('/etc/nginx/sites-enabled/default')
            available = Path('/etc/nginx/sites-available/default')
            require(not available.is_symlink() and (not enabled.exists() and not enabled.is_symlink() or
                    enabled.is_symlink() and enabled.resolve() == available), 'Obca konfiguracja nginx; odmowa przejęcia.')
            for path in ('/etc/systemd/system/nginx.service', '/etc/systemd/system/nginx.service.d'):
                require(not Path(path).exists(), 'Obca jednostka nginx; odmowa przejęcia.')
        else:
            require(not shutil.which('nginx') and not Path('/etc/nginx').exists(), 'Istniejąca instalacja nginx; użyj dedykowanego kontenera Debian 13.')
        listeners = command(['ss', '-H', '-ltnp'])
        for line in listeners.splitlines():
            port = re.search(r':(80|443|3000)\s', line)
            if port:
                owners = re.findall(r'\("([^"]+)"', line)
                require(dependencies and port[1] in ('80', '443') and owners and all(owner == 'nginx' for owner in owners),
                        'Port 80, 443 lub 3000 jest zajęty przez obcy proces.')


def origin_prompt():
    origin = input('Adres HTTPS SiteGrid (np. https://sitegrid.example.test): ').strip()
    require(re.fullmatch(r'https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', origin), 'Podaj origin HTTPS z nazwą DNS, bez ścieżki i portu.')
    return origin


def reserve_installation(state):
    # Publish a complete receipt, never an empty STATE directory. A crash can
    # leave private staging behind; retries neither claim nor remove it.
    staging = Path(tempfile.mkdtemp(prefix=f'.{STATE.name}-install-', dir=STATE.parent))
    write_json(staging / 'installation.json', state)
    # Debian/Linux renameat2(RENAME_NOREPLACE): even an empty foreign directory
    # appearing after preflight must not be replaced by our reservation.
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(staging), -100, os.fsencode(STATE), 1) != 0:
        error = ctypes.get_errno()
        require(error != errno.EEXIST, f'Istniejący {STATE}; odmowa nadpisania danych bez znacznika instalacji.')
        raise OSError(error, os.strerror(error))
    descriptor = os.open(STATE.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def configure(origin):
    group = pwd.getpwnam('sitegrid').pw_gid
    CONFIG.mkdir(mode=0o750, exist_ok=True)
    CONFIG.chmod(0o750)
    os.chown(CONFIG, 0, group)
    environment = CONFIG / 'sitegrid.env'
    if not environment.exists():
        environment.write_text(f'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\nDATABASE_URL={RUNTIME_DB_URL}\nPUBLIC_ORIGIN={origin}\n')
        environment.chmod(0o640)
        os.chown(environment, 0, group)
    tls = CONFIG / 'tls'
    tls.mkdir(mode=0o700, exist_ok=True)
    cert, key = tls / 'cert.pem', tls / 'key.pem'
    require(cert.exists() == key.exists(), 'Niepełna konfiguracja TLS; sprawdź cert.pem/key.pem przed ponowieniem.')
    if not cert.exists():
        hostname = origin.removeprefix('https://')
        print('Domyślnie powstanie lokalny certyfikat TLS. Zaufaj mu na urządzeniu testowym albo zastąp certyfikatem swojej domeny; instrukcja w INSTALL.md.')
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '90', '-keyout', str(key), '-out', str(cert),
                 '-subj', f'/CN={hostname}', '-addext', f'subjectAltName=DNS:{hostname}'])
        cert.chmod(0o644); key.chmod(0o600)
    nginx = CONFIG / 'nginx.conf'
    if not nginx.exists():
        nginx.write_text('''user www-data;
worker_processes auto;
pid /run/sitegrid-nginx.pid;
error_log /var/log/sitegrid/nginx-error.log warn;
events { worker_connections 512; }
http {
  include /etc/nginx/mime.types;
  access_log off;
  server {
    listen 80;
    server_name HOSTNAME;
    return 308 https://HOSTNAME$request_uri;
  }
  server {
    listen 443 ssl;
    server_name HOSTNAME;
    ssl_certificate /etc/sitegrid/tls/cert.pem;
    ssl_certificate_key /etc/sitegrid/tls/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 8k;
    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto https;
    }
  }
}
'''.replace('HOSTNAME', origin.removeprefix('https://')))
        nginx.chmod(0o640)


def install(args):
    with lock():
        marker = STATE / 'installation.json'
        previous = json.loads(marker.read_text()) if marker.is_file() and not marker.is_symlink() else None
        if previous:
            require(previous.get('version') == args.version and previous.get('sha256') == args.sha256, 'Ponowienie wymaga tego samego przypiętego artefaktu; inne wydanie dostarcza sitegrid update.')
            require(previous.get('phase') in ('dependencies', 'started', 'done'), 'Nieznana faza instalacji; wymagana inspekcja stanu.')
        dependencies = bool(previous and previous['phase'] == 'dependencies')
        managed = bool(previous and not dependencies)
        preflight(managed, dependencies)
        print('Weryfikacja przypiętego wydania…')
        with tempfile.TemporaryDirectory(prefix='sitegrid-install-') as temporary:
            archive = Path(temporary) / 'release.tar.gz'
            download(args.bundle, archive, args.curl_config)
            staging = Path(temporary) / 'release'
            manifest = extract_release(archive, staging, args.sha256, args.version)
            if previous and previous.get('phase') == 'done':
                require(read_manifest(ROOT / 'current')['version'] == args.version, 'Aktywne wydanie jest inne; instalator nie wykona downgrade.')
                require(health(args.version, 1), 'Instalacja istnieje, lecz readiness nie działa. Sprawdź journalctl -u sitegrid.')
                print('Instalacja już ukończona; dane i konfiguracja zachowane.')
                return
            origin = previous['origin'] if previous else (args.origin or origin_prompt())
            require(re.fullmatch(r'https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', origin), 'Nieprawidłowy origin HTTPS.')
            require(args.yes or input(f'Zainstalować {args.version} na tym Debianie ({origin})? Wpisz TAK: ').strip() == 'TAK', 'Instalacja anulowana.')
            # Reserve the verified, confirmed installation before apt can leave
            # nginx behind. This phase does not claim any SiteGrid DB or role.
            state = previous or {'version': args.version, 'sha256': args.sha256, 'origin': origin, 'phase': 'dependencies'}
            if not previous:
                reserve_installation(state)
            print('Instalacja zależności Debian 13…')
            command(['apt-get', 'update'])
            command(['apt-get', 'install', '-y', 'ca-certificates', 'curl', 'postgresql-17', 'postgresql-client-17', 'nginx-light', 'openssl', 'util-linux'], env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
            command(['systemctl', 'enable', '--now', 'postgresql.service'])
            if not managed:
                # Before claiming a DB/role, refuse any existing data with these names.
                require(sql("SELECT count(*) FROM pg_database WHERE datname = 'sitegrid';", 'postgres') == '0', 'Baza sitegrid już istnieje; nie zostanie nadpisana.')
                require(sql("SELECT count(*) FROM pg_roles WHERE rolname = 'sitegrid';", 'postgres') == '0', 'Rola sitegrid już istnieje; nie zostanie przejęta.')
                state['phase'] = 'started'
                write_json(marker, state)
            command(['systemctl', 'disable', '--now', 'nginx.service'])
            try: pwd.getpwnam('sitegrid')
            except KeyError: command(['useradd', '--system', '--user-group', '--home-dir', '/srv/sitegrid', '--shell', '/usr/sbin/nologin', 'sitegrid'])
            command(['install', '-d', '-m', '0750', '-o', 'sitegrid', '-g', 'sitegrid', '/srv/sitegrid'])
            command(['install', '-d', '-m', '0750', '/var/log/sitegrid'])
            if sql("SELECT count(*) FROM pg_roles WHERE rolname = 'sitegrid';", 'postgres') == '0':
                sql('CREATE ROLE sitegrid LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;', 'postgres')
            if sql("SELECT count(*) FROM pg_database WHERE datname = 'sitegrid';", 'postgres') == '0':
                sql('CREATE DATABASE sitegrid OWNER postgres;', 'postgres')
            (ROOT / 'releases').mkdir(mode=0o755, parents=True, exist_ok=True)
            ROOT.chmod(0o755)
            (ROOT / 'releases').chmod(0o755)
            target = ROOT / 'releases' / args.version
            if target.exists():
                require((target / '.archive-sha256').read_text().strip() == args.sha256, 'Istniejący katalog wydania ma inne pochodzenie; nie zostanie nadpisany.')
            else:
                # Copy to the release filesystem, then rename atomically (temporary staging can be on another mount).
                incoming = target.with_name(target.name + '.incoming')
                require(not incoming.exists(), 'Pozostał katalog .incoming; sprawdź przerwaną instalację.')
                shutil.copytree(staging, incoming)
                (incoming / '.archive-sha256').write_text(args.sha256 + '\n')
                os.rename(incoming, target)
            configure(origin)
            app_cli(target, 'migrate-cli.js')
            grant_runtime()
            for service in ('sitegrid.service', 'sitegrid-proxy.service'):
                destination = Path('/etc/systemd/system') / service
                require(managed or not destination.exists(), f'Istniejąca jednostka {service}; odmowa nadpisania.')
                shutil.copyfile(target / 'ops' / service, destination)
                destination.chmod(0o644)
            library = Path('/usr/local/lib/sitegrid')
            library.mkdir(mode=0o755, parents=True, exist_ok=True)
            library.chmod(0o755)
            for name in ('release.py', 'system.py', 'manage.py', 'lifecycle.py'):
                shutil.copyfile(target / 'ops' / name, library / name)
            shutil.copyfile(target / 'ops/sitegrid', '/usr/local/bin/sitegrid')
            Path('/usr/local/bin/sitegrid').chmod(0o755)
            atomic_link(target, ROOT / 'current')
            command(['systemctl', 'daemon-reload'])
            command(['systemctl', 'enable', '--now', 'sitegrid.service', 'sitegrid-proxy.service'])
            require(health(args.version), 'Health check nie powiódł się; dane zachowane. Sprawdź journalctl -u sitegrid i ponów ten sam instalator.')
            state['phase'] = 'done'
            write_json(marker, state)
            print(f'Gotowe: {origin}\nUtwórz administratora lokalnie: sudo sitegrid bootstrap-admin\nTLS: /etc/sitegrid/tls. Trwałe dane: PostgreSQL; konfiguracja: /etc/sitegrid.')


def main():
    parser = argparse.ArgumentParser(description='SiteGrid — Debian 13, pinned local/HTTPS artifact')
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--curl-config')
    parser.add_argument('--origin', help='Origin HTTPS do automatyzacji; interaktywne pytanie jest domyślne')
    parser.add_argument('--yes', action='store_true', help='Jawne potwierdzenie automatyzacji instalacji')
    args = parser.parse_args()
    try:
        os.umask(0o077)
        install(args)
    except (SiteGridError, OSError, ValueError, KeyError) as error:
        print(f'Instalacja zatrzymana: {error if isinstance(error, SiteGridError) else "sprawdź pliki, prawa dostępu i stan instalacji"}. Dane nie zostały usunięte.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
