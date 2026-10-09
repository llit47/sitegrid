#!/bin/bash
# Run only inside the disposable Debian test VM, after installation.
set -euo pipefail
[[ ${SITEGRID_DISPOSABLE_TEST:-} == YES && $EUID == 0 ]] || exit 1
bundle=${1:?bundle}; sha=${2:?trusted SHA256}; version=${3:?new version}
controller=${4:-/opt/sitegrid/current/ops}
manage() { python3 "$controller/manage.py" "$@"; }
original=$(readlink /opt/sitegrid/current)
# Synthetic account; random password remains only in memory, never printed.
cd /opt/sitegrid/current
runuser -u postgres -- env DATABASE_URL='postgresql://postgres@localhost/sitegrid?host=/var/run/postgresql' runtime/bin/node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {createPool} from './dist/server/db.js'; import {bootstrapAdmin} from './dist/server/auth/bootstrap.js'; const p=createPool(process.env.DATABASE_URL); if((await p.query('SELECT count(*) FROM users')).rows[0].count==='0') await bootstrapAdmin(p,'release-smoke@example.test',randomBytes(24).toString('base64url')); await p.end();"
identity() { runuser -u postgres -- psql -X -At -d sitegrid -c "SELECT md5(string_agg(u.id::text || u.email || c.password_hash, ',' ORDER BY u.id)) FROM users u JOIN credentials c ON c.user_id=u.id"; }
before=$(identity)
config=$(sha256sum /etc/sitegrid/sitegrid.env /etc/sitegrid/tls/key.pem)
corrupt=$(mktemp /tmp/sitegrid-corrupt.XXXXXX.tar.gz)
printf 'damaged test release' > "$corrupt"
if manage update --bundle "$corrupt" --sha256 "$sha" --version "$version" --yes; then echo 'Corrupt release accepted' >&2; exit 1; fi
[[ $(readlink /opt/sitegrid/current) == "$original" && $(identity) == "$before" ]]
manage update --bundle "$bundle" --sha256 "$sha" --version "$version" --yes
manage status
[[ $(identity) == "$before" && $(sha256sum /etc/sitegrid/sitegrid.env /etc/sitegrid/tls/key.pem) == "$config" ]]
python3 - <<'PY'
import json, pathlib, subprocess
state=json.loads(pathlib.Path('/var/lib/sitegrid/deployment.json').read_text())
backup=pathlib.Path(state['backup']['path'])
assert state['phase']=='done' and backup.stat().st_mode & 0o777 == 0o600
subprocess.run(['pg_restore','--list',str(backup)],check=True,stdout=subprocess.DEVNULL)
PY
manage rollback --yes
[[ $(readlink /opt/sitegrid/current) == "$original" && $(identity) == "$before" ]]
[[ $(sha256sum /etc/sitegrid/sitegrid.env /etc/sitegrid/tls/key.pem) == "$config" ]]
manage status
systemctl is-active --quiet sitegrid sitegrid-proxy postgresql
printf 'PASS: corrupt release rejection, pinned update, real backup, guarded rollback, account/config preserved\n'
