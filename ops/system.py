import fcntl
import json
import os
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
