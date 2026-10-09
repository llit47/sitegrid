# SiteGrid

SiteGrid to rozwijana, self-hosted platforma do zarządzania projektami budowlanymi, zadaniami i pracą zespołów wielu niezależnych firm. Architektura zakłada React/TypeScript, Fastify, PostgreSQL i instalowalną PWA z podstawową pracą offline; docelowe uruchomienie w LXC Debian 13 na Proxmoxie.

**Status:** implementacja M01 w toku. Fundament aplikacji i prawdziwe logowanie są zaimplementowane; instalator, updater i rollback są kolejnymi checkpointami. Dokładny postęp i wyniki: [M01_STATUS.md](docs/M01_STATUS.md).

- [Architektura SiteGrid](docs/audit/ARCHITECTURE.md)
- [Uprawnienia i cykl kont](docs/audit/PERMISSIONS.md)
- [Roadmapa MVP](docs/audit/ROADMAP.md)
- [Uruchomienie i testy developerskie](docs/DEVELOPMENT.md)
- [Bootstrap administratora i logowanie](docs/AUTH.md)
- [Instalacja i dostarczenie prywatnych artefaktów](docs/INSTALL.md)
- [Rekomendacje i usprawnienia](docs/audit/IMPROVEMENTS.md)

Punktem odniesienia był osobny system HERC należący do innej firmy. [Audyt funkcjonalny HERC](docs/audit/FUNCTIONALITY.md) i [ocena UX](docs/audit/UX_REVIEW.md) dokumentują wyłącznie analizę referencji, nie nazwę ani implementację SiteGrid.
