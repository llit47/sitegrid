#!/bin/bash
# Disposable VM only: real readiness failure, incompatible rollback, backup restore.
set -euo pipefail
umask 077
[[ ${SITEGRID_DISPOSABLE_TEST:-} == YES && $EUID == 0 ]] || exit 1
bad=${1:?bad-readiness bundle}; bad_sha=${2:?SHA256}
schema_bundle=${3:?schema-3 bundle}; schema_sha=${4:?SHA256}
identity() { runuser -u postgres -- psql -X -At -d "$1" -c "SELECT md5(string_agg(u.id::text || u.email || c.password_hash, ',' ORDER BY u.id)) FROM users u JOIN credentials c ON c.user_id=u.id"; }
before=$(identity sitegrid)
original=$(readlink /opt/sitegrid/current)
corrupt=$(mktemp /tmp/sitegrid-corrupt-final.XXXXXX.tar.gz)
printf 'broken test release' > "$corrupt"
if sitegrid update --bundle "$corrupt" --version 0.1.2 --sha256 "$bad_sha" --yes; then exit 1; fi
[[ $(readlink /opt/sitegrid/current) == "$original" ]]
if sitegrid update --bundle "$bad" --version 0.1.2 --sha256 "$bad_sha" --yes; then echo 'Bad readiness accepted' >&2; exit 1; fi
[[ $(readlink /opt/sitegrid/current) == "$original" && $(identity sitegrid) == "$before" ]]
python3 - <<'PY'
import json,pathlib,subprocess,fcntl
path=pathlib.Path('/var/lib/sitegrid/deployment.json')
state=json.loads(path.read_text()); assert state['phase']=='recovered' and state['failed_phase']=='activating'
# Persisted interrupted state remains after an actual service restart.
saved=path.with_name('deployment.before-interruption-test.json')
saved.write_text(path.read_text()); saved.chmod(0o600)
state['phase']='activating'; path.write_text(json.dumps(state))
subprocess.run(['systemctl','restart','sitegrid'],check=True)
rejected=subprocess.run(['sitegrid','rollback','--yes'],capture_output=True,text=True)
assert rejected.returncode != 0 and 'Przerwane wdrożenie' in rejected.stderr
assert json.loads(path.read_text())['phase']=='activating'
# Restore the known completed journal only after verifying this fixture did not migrate.
assert subprocess.check_output(['runuser','-u','postgres','--','psql','-X','-At','-d','sitegrid','-c','SELECT max(version) FROM schema_migrations']).strip()==b'2'
from shutil import copyfile
copyfile(saved,path)
with open('/run/sitegrid/operation.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    rejected=subprocess.run(['sitegrid','rollback','--yes'],capture_output=True,text=True)
    assert rejected.returncode != 0 and 'Trwa inna instalacja' in rejected.stderr
print('PASS: real readiness recovery, persisted interrupted journal, operation lock')
PY
sitegrid update --bundle "$schema_bundle" --version 0.1.3 --sha256 "$schema_sha" --yes
current=$(readlink /opt/sitegrid/current)
if sitegrid rollback --version 0.1.0 --yes; then echo 'Incompatible rollback accepted' >&2; exit 1; fi
[[ $(readlink /opt/sitegrid/current) == "$current" && $(identity sitegrid) == "$before" ]]
systemctl is-active --quiet sitegrid
backup=$(python3 -c "import json; print(json.load(open('/var/lib/sitegrid/deployment.json'))['backup']['path'])")
runuser -u postgres -- createdb sitegrid_restore_smoke
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges --dbname=sitegrid_restore_smoke < "$backup"
[[ $(identity sitegrid_restore_smoke) == "$before" ]]
[[ $(runuser -u postgres -- psql -X -At -d sitegrid_restore_smoke -c 'SELECT max(version) FROM schema_migrations') == 2 ]]
python3 - <<'PY'
import json,pathlib,hashlib
state=json.loads(pathlib.Path('/var/lib/sitegrid/deployment.json').read_text())
info=state['backup']; metadata=pathlib.Path(info['metadata'])
assert metadata.stat().st_mode & 0o777 == 0o600
value=json.loads(metadata.read_text()); assert value['version']=='0.1.0' and value['schema']==2
assert hashlib.sha256(pathlib.Path(info['path']).read_bytes()).hexdigest()==value['sha256']
PY
sitegrid status
printf 'PASS: real schema upgrade, rollback refused without service stop, account preserved, backup restored to separate DB\n'
