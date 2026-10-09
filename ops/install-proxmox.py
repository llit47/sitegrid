#!/usr/bin/env python3
"""Creates only a NEW unprivileged CT. Real Proxmox execution requires operator approval."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import subprocess
from release import SiteGridError, require, command, download, extract_release
from install_debian import origin_prompt


def prompt(label, default):
    return input(f'{label} [{default}]: ').strip() or str(default)


def integer(label, default, minimum, maximum):
    value = prompt(label, default)
    require(value.isdigit() and minimum <= int(value) <= maximum, f'Nieprawidłowe {label}.')
    return int(value)


def main():
    parser = argparse.ArgumentParser(description='SiteGrid — nowy nieuprzywilejowany LXC Debian 13 (Proxmox VE 9)')
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--curl-config')
    args = parser.parse_args()
    created = None
    try:
        require(os.geteuid() == 0, 'Wymagany root na hoście Proxmox.')
        for executable in ('pct', 'pvesm', 'pvesh', 'pveam', 'pveversion'):
            require(shutil.which(executable), f'Brak {executable}; to nie jest host Proxmox VE.')
        require(command(['pveversion']).startswith('pve-manager/9.'), 'Zweryfikuj zgodność — instalator przeznaczony dla Proxmox VE 9.')
        directory = Path('/run/sitegrid-proxmox')
        require(not directory.is_symlink(), 'Nieprawidłowy katalog blokady hostowej.')
        directory.mkdir(mode=0o700, exist_ok=True)
        require(directory.stat().st_uid == 0, 'Nieprawidłowy właściciel katalogu blokady hostowej.')
        directory.chmod(0o700)
        descriptor = os.open(directory / 'operation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(descriptor, 'a') as stream:
            try: fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise SiteGridError('Inny instalator hostowy SiteGrid już działa.')
            with tempfile.TemporaryDirectory(prefix='sitegrid-proxmox-') as temporary:
                archive = Path(temporary) / 'sitegrid.tar.gz'
                download(args.bundle, archive, args.curl_config)
                staging = Path(temporary) / 'release'
                extract_release(archive, staging, args.sha256, args.version)
                ct = integer('Nowy CT ID', command(['pvesh', 'get', '/cluster/nextid']), 100, 999999999)
                resources = json.loads(command(['pvesh', 'get', '/cluster/resources', '--type', 'vm', '--output-format', 'json']))
                require(not any(int(row['vmid']) == ct for row in resources), 'CT/VM ID jest zajęte w klastrze. Nic nie zostanie nadpisane.')
                require(not Path(f'/etc/pve/lxc/{ct}.conf').exists() and not Path(f'/etc/pve/qemu-server/{ct}.conf').exists(), 'ID już istnieje.')
                storage = prompt('Storage rootfs (musi obsługiwać rootdir)', 'local-lvm')
                template_storage = prompt('Storage szablonów (vztmpl)', 'local')
                for name in (storage, template_storage): require(re.fullmatch('[a-zA-Z0-9_-]+', name), 'Nieprawidłowe storage.')
                cores = integer('vCPU', 4, 2, os.cpu_count() or 2)
                ram = integer('RAM MiB', 8192, 2048, 1048576)
                disk = integer('Dysk GiB', 40, 16, 1048576)
                available_ram = int(re.search(r'MemAvailable:\s+(\d+)', Path('/proc/meminfo').read_text())[1])
                require(available_ram >= ram * 1024, 'Za mało dostępnej pamięci na hoście.')
                status = command(['pvesm', 'status', '--storage', storage, '--content', 'rootdir'])
                rows = [line.split() for line in status.splitlines() if line.split() and line.split()[0] == storage]
                require(len(rows) == 1 and rows[0][2] == 'active' and int(rows[0][5]) >= disk * 1024 ** 2, 'Storage rootdir niedostępne lub za mało miejsca.')
                template_status = command(['pvesm', 'status', '--storage', template_storage, '--content', 'vztmpl'])
                require(any(line.split()[:1] == [template_storage] and line.split()[2] == 'active' for line in template_status.splitlines()), 'Storage szablonów niedostępne.')
                bridge = prompt('Bridge sieciowy', 'vmbr0')
                require(re.fullmatch('[a-zA-Z0-9_-]+', bridge) and Path(f'/sys/class/net/{bridge}/bridge').is_dir(), 'Nie znaleziono bridge.')
                network = prompt('IPv4 (dhcp lub adres/prefix)', 'dhcp')
                gateway = None
                if network != 'dhcp':
                    import ipaddress
                    ipaddress.IPv4Interface(network)
                    gateway = str(ipaddress.IPv4Address(prompt('Brama IPv4', '')))
                template_list = command(['pveam', 'list', template_storage])
                templates = [line.split()[0] for line in template_list.splitlines() if f'{template_storage}:vztmpl/debian-13-' in line]
                require(templates, 'Brak pobranego szablonu Debian 13. Pobierz oficjalny szablon przez pveam i ponów; CT nie został utworzony.')
                print('\nDostępne szablony Debian 13:\n' + '\n'.join(templates))
                template = prompt('Szablon (dokładny volid)', sorted(templates)[-1])
                require(template in templates and Path(command(['pvesm', 'path', template])).is_file(), 'Szablon nie istnieje.')
                origin = origin_prompt()
                print(f'Nowy CT {ct}: {cores} vCPU, {ram} MiB RAM, {disk} GiB {storage}, {bridge}/{network}. SiteGrid {args.version}.')
                require(input('Utworzyć NOWY nieuprzywilejowany kontener? Wpisz TAK: ').strip() == 'TAK', 'Anulowano.')
                net = f'name=eth0,bridge={bridge},ip={network},ip6=manual,firewall=1'
                if gateway: net += f',gw={gateway}'
                command(['pct', 'create', str(ct), template, '--unprivileged', '1', '--hostname', f'sitegrid-{ct}',
                         '--cores', str(cores), '--memory', str(ram), '--swap', '512', '--rootfs', f'{storage}:{disk}',
                         '--net0', net, '--onboot', '1'])
                created = ct
                command(['pct', 'start', str(ct)])
                command(['pct', 'push', str(ct), str(archive), '/root/sitegrid.tar.gz', '--perms', '0600'])
                # All members were validated, checksum is already trusted; no secrets/config sent to CT.
                command(['pct', 'exec', str(ct), '--', 'mkdir', '-p', '/root/sitegrid-installer'])
                command(['pct', 'exec', str(ct), '--', 'tar', '-xzf', '/root/sitegrid.tar.gz', '-C', '/root/sitegrid-installer'])
                command(['pct', 'exec', str(ct), '--', 'apt-get', 'update'])
                command(['pct', 'exec', str(ct), '--', 'apt-get', 'install', '-y', 'python3', 'iproute2'])
                result = subprocess.run(['pct', 'exec', str(ct), '--', 'python3', '-u', '/root/sitegrid-installer/ops/install_debian.py',
                                         '--bundle', '/root/sitegrid.tar.gz', '--sha256', args.sha256,
                                         '--version', args.version, '--origin', origin, '--yes'])
                require(result.returncode == 0, 'Instalacja wewnątrz nowego CT nie powiodła się.')
                print(f'CT {ct} gotowy: {origin}. Utwórz administratora lokalnie: pct enter {ct}, następnie sitegrid bootstrap-admin.')
        return 0
    except (SiteGridError, OSError, ValueError, KeyError) as error:
        print(f'Instalator Proxmox zatrzymany: {error if isinstance(error, SiteGridError) else "sprawdź parametry i dostępność zasobów"}.', file=sys.stderr)
        if created: print(f'Nowy CT {created} pozostawiono do inspekcji/ponowienia. Nie jest automatycznie usuwany.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
