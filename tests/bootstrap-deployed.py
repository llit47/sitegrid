"""Local interactive bootstrap over the disposable VM's loopback SSH console."""
import argparse
import json
import os
from pathlib import Path
import pty
import secrets
import select
import subprocess
import termios
import time

assert os.environ.get('SITEGRID_DISPOSABLE_TEST') == 'YES', 'Disposable VM opt-in required'
p = argparse.ArgumentParser()
p.add_argument('--ssh-key', required=True)
p.add_argument('--known-hosts', required=True)
p.add_argument('--credentials', required=True)
p.add_argument('--port', default='12222')
a = p.parse_args()
credentials = Path(a.credentials).resolve()
assert not credentials.is_relative_to(Path(__file__).resolve().parents[1]), 'Credentials must remain outside repository'
assert not credentials.exists(), 'Refusing to overwrite credentials'
email, password = 'browser-admin@example.test', secrets.token_urlsafe(32)
ssh = ['ssh', '-i', a.ssh_key, '-p', a.port, '-o', 'UserKnownHostsFile=' + a.known_hosts, '-o', 'LogLevel=ERROR']
for expected in [0, 1]:
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO | termios.ICANON)
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    child = subprocess.Popen(ssh + ['-tt', 'root@127.0.0.1', 'sitegrid bootstrap-admin'], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = ''
    try:
        for prompt, answer in [('Email pierwszego administratora:', email), ('niewidoczne):', password), ('Powtórz hasło:', password)]:
            deadline = time.monotonic() + 45
            while prompt not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 1)[0]:
                    try: output += os.read(master, 65536).decode(errors='replace')
                    except OSError: break
            assert prompt in output, 'Expected CLI prompt missing'
            os.write(master, (answer + '\n').encode())
        deadline = time.monotonic() + 60
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 1)[0]:
                try: output += os.read(master, 65536).decode(errors='replace')
                except OSError: break
        assert child.wait(timeout=5) == expected, 'Unexpected bootstrap result'
        assert password not in output, 'CLI echoed secret'
    finally:
        os.close(master)
        if child.poll() is None: child.terminate(); child.wait(timeout=5)
rejected = subprocess.run(ssh + ['-T', 'root@127.0.0.1', 'sitegrid bootstrap-admin'], stdin=subprocess.DEVNULL, capture_output=True)
assert rejected.returncode != 0, 'Noninteractive bootstrap must fail'
with credentials.open('x') as f:
    os.chmod(credentials, 0o600)
    json.dump({'email': email, 'password': password}, f)
print('PASS: deployed local CLI bootstrap, retry rejected, no password echo, noninteractive rejected')
