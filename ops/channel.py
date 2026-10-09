"""Public GitHub Releases: locator metadata is untrusted until Ed25519 verifies."""
import hashlib
import json
from pathlib import Path
import platform
import re
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener
from release import SiteGridError, require, command

REPOSITORY = 'llit47/sitegrid'
API = f'https://api.github.com/repos/{REPOSITORY}/releases'
BASE = f'https://github.com/{REPOSITORY}/releases/download'
KEY = Path(__file__).with_name('release-public.pem')
HOSTS = {'github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
VERSION = r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)'


def version_tuple(version):
    require(isinstance(version, str) and re.fullmatch(VERSION, version), 'Kanał stable wymaga wersji X.Y.Z.')
    return tuple(map(int, version.split('.')))


def check_url(url):
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname in HOSTS and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.fragment, 'Niedozwolony adres kanału wydań.')


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, destination, limit=1024 ** 3):
    check_url(url)
    request = Request(url, headers={'User-Agent': 'SiteGrid-release-client', 'Accept': 'application/vnd.github+json' if url.startswith(API) else 'application/octet-stream'})
    try:
        with build_opener(Redirects()).open(request, timeout=30) as response, Path(destination).open('xb') as output:
            length = response.headers.get('Content-Length')
            require(not length or int(length) <= limit, 'Przekroczony limit pobrania.')
            total = 0
            while chunk := response.read(min(1024 * 1024, limit + 1)):
                total += len(chunk)
                require(total <= limit, 'Przekroczony limit pobrania.')
                output.write(chunk)
    except HTTPError as error:
        raise SiteGridError('Brak opublikowanego Release/assetu (HTTP 404).' if error.code == 404 else f'Kanał wydań niedostępny (HTTP {error.code}).') from error
    except (URLError, TimeoutError) as error:
        raise SiteGridError('Nie można pobrać publicznego wydania; sprawdź sieć/TLS. Brak fallbacku.') from error


def verify_manifest(path, signature, expected_version, key=None, now=None):
    key = Path(key or KEY)
    require(key.is_file() and not key.is_symlink(), 'Brak przypiętego klucza wydawcy; operacja zatrzymana.')
    require(Path(path).stat().st_size <= 16384 and Path(signature).stat().st_size == 64, 'Nieprawidłowy rozmiar manifestu/podpisu.')
    try:
        command(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(key), '-rawin', '-in', str(path), '-sigfile', str(signature)])
    except SiteGridError as error:
        raise SiteGridError('Nieprawidłowy podpis wydawcy; operacja zatrzymana.') from error
    manifest = json.loads(Path(path).read_text())
    require(isinstance(manifest, dict) and manifest.get('format') == 1 and manifest.get('repository') == REPOSITORY
            and manifest.get('channel') == 'stable', 'Nieprawidłowy manifest kanału.')
    version_tuple(manifest.get('version'))
    require(manifest['version'] == expected_version, 'Podpisany manifest nie odpowiada tagowi wydania.')
    issued, expires = manifest.get('issued_at'), manifest.get('expires_at')
    now = int(time.time()) if now is None else now
    require(type(issued) is int and type(expires) is int and issued <= now + 300 and now < expires
            and 0 < expires - issued <= 366 * 86400, 'Manifest przeterminowany lub z nieprawidłową datą.')
    artifacts = manifest.get('artifacts')
    require(isinstance(artifacts, dict) and artifacts and set(artifacts) <= {'x64', 'arm64'}, 'Brak obsługiwanych artefaktów.')
    for arch, artifact in artifacts.items():
        require(isinstance(artifact, dict) and artifact.get('name') == f'sitegrid-{expected_version}-linux-{arch}.tar.gz'
                and isinstance(artifact.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', artifact['sha256']), 'Nieprawidłowy artefakt manifestu.')
    bootstrap = manifest.get('bootstrap')
    require(isinstance(bootstrap, dict) and bootstrap.get('name') == f'sitegrid-install-{expected_version}.sh'
            and isinstance(bootstrap.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', bootstrap['sha256']), 'Nieprawidłowy bootstrap manifestu.')
    return manifest


def resolve(directory, version=None, *, key=None, fetcher=None):
    fetcher = fetcher or fetch
    directory = Path(directory)
    if version is None:
        metadata = directory / 'github.json'
        fetcher(API + '/latest', metadata, 1024 * 1024)
        locator = json.loads(metadata.read_text())
        require(isinstance(locator, dict) and locator.get('draft') is False and locator.get('prerelease') is False,
                'Kanał stable nie wskazuje opublikowanego wydania.')
        tag = locator.get('tag_name')
        require(isinstance(tag, str) and tag.startswith('v'), 'Nieprawidłowy tag kanału.')
        version = tag[1:]
    version_tuple(version)
    manifest, signature = directory / 'manifest.json', directory / 'manifest.sig'
    url = f'{BASE}/v{version}/'
    fetcher(url + 'sitegrid-manifest.json', manifest, 16384)
    fetcher(url + 'sitegrid-manifest.sig', signature, 64)
    return verify_manifest(manifest, signature, version, key)


def download_bundle(manifest, directory, *, fetcher=None):
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    require(arch in manifest['artifacts'], 'Brak podpisanego pakietu dla architektury serwera.')
    artifact = manifest['artifacts'][arch]
    archive = Path(directory) / artifact['name']
    (fetcher or fetch)(f"{BASE}/v{manifest['version']}/{artifact['name']}", archive, 1024 ** 3)
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    require(digest.hexdigest() == artifact['sha256'], 'SHA-256 pakietu nie odpowiada podpisanemu manifestowi.')
    return archive, artifact['sha256']


def automatic_update(args, state, *, key=None, fetcher=None):
    import lifecycle
    from system import write_json
    current, _ = lifecycle.installed()
    lifecycle.no_pending(lifecycle.journal())
    receipt = Path(state) / 'channel.json'
    require(not receipt.is_symlink(), 'Niedozwolony symlink stanu kanału.')
    seen = json.loads(receipt.read_text()) if receipt.exists() else {}
    require(isinstance(seen, dict), 'Nieprawidłowy stan kanału wydań.')
    floor = max(version_tuple(current.name), version_tuple(seen.get('version', current.name)))
    with tempfile.TemporaryDirectory(prefix='sitegrid-channel-') as directory:
        manifest = resolve(directory, key=key, fetcher=fetcher)
        candidate = version_tuple(manifest['version'])
        require(candidate >= floor, 'Cofnięty manifest kanału; operacja zatrzymana.')
        if candidate == version_tuple(current.name):
            print(f"SiteGrid {current.name}: brak nowszego podpisanego wydania.")
            return
        print(f"Publiczne wydanie: {current.name} → {manifest['version']}.")
        require(args.yes or input('Pobrać i zaktualizować z backupem DB? Wpisz TAK: ').strip() == 'TAK', 'Aktualizacja anulowana.')
        archive, sha = download_bundle(manifest, directory, fetcher=fetcher)
        from argparse import Namespace
        lifecycle.update(Namespace(bundle=str(archive), version=manifest['version'], sha256=sha, curl_config=None, yes=True))
        write_json(receipt, {'version': manifest['version']})
