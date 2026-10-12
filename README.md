# SiteGrid

Self-hosted platforma projektów budowlanych i pracy wielu firm. React/TypeScript, Fastify i PostgreSQL; pełne MVP obejmie PWA i podstawową pracę offline. M01 dostarcza działające logowanie administratora oraz mechanizm instalacji, aktualizacji i rollbacku. Instalacja wyłącznie **w gotowym Debianie 13 z systemd**, również w LXC.

**Przygotowywane wydanie: v0.1.4, po scaleniu PR25–PR26; PostgreSQL schema 14.** [Oficjalne wydania](https://github.com/llit47/sitegrid/releases) obejmują v0.1.0–v0.1.3. [Release notes v0.1.4](docs/releases/v0.1.4.md) i [procedura podpisanego Draft Release](docs/RELEASES.md). Historyczny status M01: [M01_STATUS.md](docs/M01_STATUS.md).

Dla opublikowanego wydania operator jako root wkleja komendę z jego `INSTALL_COMMAND.txt`, po sprawdzeniu zaufanej instrukcji. Wzorzec (placeholdery zastępuje builder, bez ręcznego kopiowania `ops/` lub paczki):

```sh
bash -c 'set -euo pipefail; test "$(id -u)" = 0; . /etc/os-release; test "$ID:$VERSION_ID" = debian:13; apt-get update; apt-get install -y ca-certificates curl; f=$(mktemp); trap '\''rm -f -- "$f"'\'' EXIT; curl --disable --fail --silent --show-error --location --proto =https --proto-redir =https "https://github.com/llit47/sitegrid/releases/download/v<VERSION>/sitegrid-install-<VERSION>.sh" -o "$f"; echo "<BOOTSTRAP_SHA256>  $f" | sha256sum --check --status; bash "$f"'
```

Komenda z zaufanej instrukcji przypina bootstrap i sprawdza go przed wykonaniem. Bootstrap weryfikuje podpis manifestu przypiętym kluczem Ed25519 i sumę paczki, instaluje PostgreSQL 17, nginx, runtime Node, SiteGrid/systemd, pyta o origin i sprawdza readiness. Miejsce instalacji wybiera użytkownik: LXC, VM, bare metal lub host Proxmox VE z Debianem 13. Instalator nie tworzy LXC/VM. Repo i Releases są publiczne; klient nie potrzebuje poświadczeń GitHub.

Po instalacji:

```sh
sitegrid bootstrap-admin
sitegrid update   # pokazuje wersje i wymaga TAK; bez aktualizacji w tle
sitegrid rollback
sitegrid status
```

Tryb manualny update nadal działa z `--bundle`, `--version` i `--sha256`. Rollback wymaga zgodności z aktualną bazą i zachowuje dane; nie wykonuje downgrade PostgreSQL. Szczegóły TLS, retry i wymagań: [INSTALL.md](docs/INSTALL.md). Proces przygotowania podpisanych wydań z tagów i zatwierdzenia publikacji: [RELEASES.md](docs/RELEASES.md).

- [Architektura](docs/audit/ARCHITECTURE.md) i [roadmapa](docs/audit/ROADMAP.md)
- [Uprawnienia](docs/audit/PERMISSIONS.md), [logowanie](docs/AUTH.md), [development](docs/DEVELOPMENT.md)
- [Zaproszenia email i aktywacja administratora firmy](docs/INVITATIONS.md)
- [Panel firmy, członkowie i pracownicy](docs/COMPANY_MEMBERS.md)
- [Branding, logo i ustawienia firmy](docs/COMPANY_BRANDING.md)
- [Projekty, przydziały i zadania online (M07)](docs/PROJECTS_TASKS.md)
- [Model pracy: kontrahenci, wspólni pracownicy, zadania i przyszła ewidencja godzin](docs/CONTRACTOR_PROJECT_MODEL.md) — decyzja na przyszłe PR-y, nie istniejąca funkcja
- [Rekomendacje](docs/audit/IMPROVEMENTS.md)

HERC pozostaje osobną aplikacją referencyjną: [audyt funkcjonalny](docs/audit/FUNCTIONALITY.md) i [ocena UX](docs/audit/UX_REVIEW.md).

Scalone PR22/PR23: [podzadania](docs/SUBTASKS.md) oraz [komentarze i prywatne zdjęcia online, backup/restore PostgreSQL + media](docs/TASK_COMMENTS_MEDIA.md). Schemat 14; trwała kolejka offline M11/M12 pozostaje osobnym etapem.
