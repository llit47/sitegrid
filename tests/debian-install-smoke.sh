#!/bin/bash
# Run only INSIDE a disposable Debian 13 VM. Never on an existing installation.
set -euo pipefail
[[ ${SITEGRID_DISPOSABLE_TEST:-} == YES && $EUID == 0 ]] || { echo 'Requires root inside a disposable VM and SITEGRID_DISPOSABLE_TEST=YES' >&2; exit 1; }
bundle=${1:?bundle path}
sha=${2:?trusted SHA256}
version=${3:-0.1.0}
installer=${4:?trusted ops directory}
python3 -u "$installer/install_debian.py" --bundle "$bundle" --sha256 "$sha" --version "$version" --origin https://sitegrid.example.test --yes
before=$(sha256sum /etc/sitegrid/sitegrid.env /etc/sitegrid/tls/key.pem)
python3 -u "$installer/install_debian.py" --bundle "$bundle" --sha256 "$sha" --version "$version" --origin https://sitegrid.example.test --yes
after=$(sha256sum /etc/sitegrid/sitegrid.env /etc/sitegrid/tls/key.pem)
[[ "$before" == "$after" ]] || { echo 'Configuration changed during installer retry' >&2; exit 1; }
[[ $(stat -c %a /etc/sitegrid/sitegrid.env) == 640 && $(stat -c %a /etc/sitegrid/tls/key.pem) == 600 ]]
[[ $(stat -c %a /opt/sitegrid) == 755 && $(stat -c %a /opt/sitegrid/releases) == 755 ]]
[[ $(stat -c %a /var/lib/sitegrid) == 700 ]]
[[ $(runuser -u postgres -- psql -X -At -c "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname='sitegrid'") == f ]]
if runuser -u sitegrid -- psql -X -v ON_ERROR_STOP=1 -d sitegrid -c 'CREATE TABLE runtime_must_not_own_tables(id integer)' >/dev/null 2>&1; then
  echo 'Runtime has forbidden schema privileges' >&2; exit 1
fi
runuser -u sitegrid -- psql -X -v ON_ERROR_STOP=1 -d sitegrid -c 'SELECT count(*) FROM users' >/dev/null
systemctl restart sitegrid
for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:3000/health/ready >/dev/null; then break; fi
  sleep 1
done
systemctl is-active --quiet sitegrid sitegrid-proxy postgresql
curl --fail --silent http://127.0.0.1:3000/health/ready
curl --fail --silent --insecure --resolve sitegrid.example.test:443:127.0.0.1 https://sitegrid.example.test/ -o /tmp/sitegrid-frontend-smoke.html
python3 - <<'PY'
from pathlib import Path
assert '<title>SiteGrid</title>' in Path('/tmp/sitegrid-frontend-smoke.html').read_text()
print('\nPASS: install, retry, permissions, peer auth, runtime grants, systemd restart, HTTPS frontend')
PY
