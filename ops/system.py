import fcntl
import json
import os
import pwd
from pathlib import Path
import time
import urllib.request
from release import command, require, SiteGridError

ROOT = Path('/opt/sitegrid')
CONFIG = Path('/etc/sitegrid')
STATE = Path('/var/lib/sitegrid')
DB_URL = 'postgresql://postgres@localhost/sitegrid?host=/var/run/postgresql'
RUNTIME_DB_URL = 'postgresql://sitegrid@localhost/sitegrid?host=/var/run/postgresql'


def lock():
    require(os.geteuid() == 0, 'Polecenie wymaga root.')
    directory = Path('/run/sitegrid')
    require(not directory.is_symlink(), 'Nieprawidłowy katalog blokady.')
    directory.mkdir(mode=0o700, exist_ok=True)
    require(directory.stat().st_uid == 0, 'Nieprawidłowy właściciel katalogu blokady.')
    directory.chmod(0o700)
    descriptor = os.open(directory / 'operation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    stream = os.fdopen(descriptor, 'a')
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        stream.close()
        raise SiteGridError('Trwa inna instalacja/aktualizacja SiteGrid.')
    return stream


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sql(statement, database='sitegrid'):
    return command(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database], input=statement)


def app_cli(release, filename, interactive=False):
    import subprocess
    release = Path(release)
    env = {**os.environ, 'DATABASE_URL': DB_URL, 'MIGRATION_DATABASE_URL': DB_URL,
           'MIGRATIONS_ROOT': str(release / 'migrations')}
    args = ['runuser', '-u', 'postgres', '--', str(release / 'runtime/bin/node'), str(release / 'dist/server' / filename)]
    if interactive:
        result = subprocess.run(args, env=env, cwd=release)
        require(result.returncode == 0, 'Lokalny bootstrap nie powiódł się.')
    else:
        command(args, env=env, cwd=release)


def grant_runtime():
    sql('''REVOKE ALL ON DATABASE sitegrid FROM PUBLIC;
      GRANT CONNECT ON DATABASE sitegrid TO sitegrid;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO sitegrid;
      GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid;
      GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid;
      GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid;''')


def health(version, attempts=30):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000/health/ready', timeout=3) as response:
                result = json.load(response)
                if result.get('status') == 'ready' and result.get('version') == version:
                    return True
        except (OSError, ValueError):
            pass
        if attempt + 1 < attempts:
            time.sleep(1)
    return False


def configure_media_proxy(reload=True):
    """Narrow upload location; preserve operator configuration and all other limits."""
    nginx = CONFIG / 'nginx.conf'
    require(nginx.is_file() and not nginx.is_symlink(), 'Brak bezpiecznej konfiguracji proxy.')
    content = nginx.read_text()
    include = '    include /etc/sitegrid/task-media-proxy.conf;\n'
    if include not in content:
        require(content.count('    location / {') == 1,
                'Niestandardowa konfiguracja proxy: dodaj include /etc/sitegrid/task-media-proxy.conf w serwerze HTTPS przed update.')
        content = content.replace('    location / {', include + '    location / {')
        temporary = nginx.with_name('nginx.conf.media-incoming')
        with temporary.open('x') as stream:
            os.chmod(temporary, nginx.stat().st_mode & 0o777)
            stream.write(content)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, nginx)
    location = CONFIG / 'task-media-proxy.conf'
    require(not location.is_symlink(), 'Niebezpieczny plik konfiguracji mediów.')
    expected = '''location ~ "^/api/organizations/[0-9a-fA-F-]{36}/projects/[0-9a-fA-F-]{36}/tasks/[0-9a-fA-F-]{36}/comments$" {
  client_max_body_size 50m;
  client_body_timeout 60s;
  proxy_request_buffering off;
  proxy_read_timeout 75s;
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
}
'''
    if location.exists(): require(location.read_text() == expected, 'Konfiguracja mediów została zmieniona; sprawdź ją przed update.')
    else:
        with location.open('x') as stream:
            os.chmod(location, 0o640)
            stream.write(expected); stream.flush(); os.fsync(stream.fileno())
    command(['nginx', '-t', '-c', str(nginx)])
    if reload: command(['systemctl', 'reload', 'sitegrid-proxy.service'])


MEDIA = Path('/srv/sitegrid/files')


def prepare_media_storage():
    require(MEDIA.parent.is_dir() and not MEDIA.parent.is_symlink(), 'Niebezpieczny katalog /srv/sitegrid.')
    MEDIA.mkdir(mode=0o700, exist_ok=True)
    descriptor = os.open(MEDIA, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        account = pwd.getpwnam('sitegrid')
        os.fchown(descriptor, account.pw_uid, account.pw_gid)
        os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)
