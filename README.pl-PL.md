<div align="center">

# DBX — zarządzanie bazami danych

**Ponad 100 baz danych w lekkiej aplikacji o rozmiarze około 25 MB.**

Aplikacja desktopowa, Docker, interfejs wiersza poleceń (CLI), wbudowany asystent AI i serwer MCP.

![Zrzut ekranu DBX](https://dl.dbxio.com/assets/readme-hero-20260925.png)

[English](README.md) | **Polski** | [简体中文](README.zh-CN.md)

[**Pobierz DBX**](https://github.com/t8y2/dbx/releases) · [**Kod źródłowy**](https://github.com/t8y2/dbx) · [**Zgłoś problem**](https://github.com/t8y2/dbx/issues)

</div>

## O projekcie

**DBX** to lekki, wieloplatformowy, otwartoźródłowy program do pracy z bazami danych. Umożliwia korzystanie z wielu silników bazodanowych w jednym narzędziu, bez konieczności instalowania osobnego klienta dla każdego systemu.

Projekt oferuje aplikację desktopową, możliwość uruchamiania w Dockerze, narzędzia CLI oraz integracje związane z AI i MCP.

## Najważniejsze funkcje

- **Obsługa ponad 100 baz danych** — praca z różnymi silnikami z poziomu jednego programu.
- **Wieloplatformowość** — korzystanie z DBX na obsługiwanych systemach operacyjnych.
- **Interfejs graficzny** — wygodny dostęp do połączeń, danych i narzędzi bazodanowych.
- **CLI** — możliwość pracy z poziomu terminala.
- **Docker** — wariant uruchamiania w kontenerze.
- **Wbudowany asystent AI** — funkcje wspomagające pracę z bazami danych.
- **Serwer MCP** — integracja z narzędziami wykorzystującymi Model Context Protocol.
- **Polski interfejs użytkownika** — lokalizacja `pl-PL` dodana w ramach [PR #11726](https://github.com/t8y2/dbx/pull/11726).

> Dostępność poszczególnych funkcji może zależeć od wersji i sposobu uruchomienia programu.

## Obsługiwane bazy danych

DBX obsługuje ponad 100 systemów bazodanowych. Przykładowe silniki:

| Relacyjne i analityczne | NoSQL, wyszukiwanie i inne |
| --- | --- |
| MySQL | Redis |
| PostgreSQL | MongoDB |
| SQLite | Elasticsearch |
| MariaDB | Meilisearch |
| Microsoft SQL Server | Apache CouchDB |
| Oracle | InfluxDB |
| DuckDB | TDengine |
| ClickHouse | JDBC |
| TiDB | |
| CockroachDB | |
| Amazon Redshift | |
| Google Cloud Spanner | |
| OceanBase | |
| StarRocks | |

Pełną i aktualną listę obsługiwanych baz danych można znaleźć w [oficjalnym repozytorium](https://github.com/t8y2/dbx).

## Wygląd aplikacji

<div align="center">
  <img src="https://dl.dbxio.com/assets/screenshot-light.png" alt="DBX — jasny motyw" width="395" />
  <img src="https://dl.dbxio.com/assets/screenshot-dark.png" alt="DBX — ciemny motyw" width="395" />
  <img src="https://dl.dbxio.com/assets/screenshot-er.png" alt="DBX — widok diagramu" width="395" />
  <img src="https://dl.dbxio.com/assets/screenshot-grid.png" alt="DBX — widok danych tabelarycznych" width="395" />
</div>

## Instalacja

1. Otwórz stronę [oficjalnych wydań DBX](https://github.com/t8y2/dbx/releases).
2. Wybierz najnowsze stabilne wydanie.
3. Pobierz pakiet odpowiedni dla swojego systemu operacyjnego.
4. Zainstaluj lub uruchom program zgodnie z instrukcją danego pakietu.
5. Po uruchomieniu wybierz język polski w ustawieniach języka, jeśli jest dostępny w zainstalowanej wersji.

**Uwaga:** Pobieraj pliki wyłącznie z oficjalnych źródeł projektu. Szczegółowe instrukcje dla poszczególnych platform i metod instalacji znajdują się w [angielskiej dokumentacji](README.md).

## Pierwsze kroki

1. Uruchom DBX.
2. Dodaj nowe połączenie z wybraną bazą danych.
3. Wprowadź wymagane parametry połączenia, takie jak adres serwera, port i dane uwierzytelniające.
4. Sprawdź połączenie i zapisz konfigurację, jeżeli program udostępnia taką możliwość.
5. Otwórz bazę i rozpocznij pracę z danymi.

**Bezpieczeństwo:** Nie publikuj haseł, tokenów, ciągów połączeń ani innych danych dostępowych w zgłoszeniach GitHub, zrzutach ekranu i plikach konfiguracyjnych udostępnianych publicznie.

## Język polski

Polska lokalizacja interfejsu została przygotowana w ramach [Pull Request #11726](https://github.com/t8y2/dbx/pull/11726).

Jeżeli w interfejsie pojawi się nieprzetłumaczony tekst lub błąd językowy, można go zgłosić w [GitHub Issues](https://github.com/t8y2/dbx/issues), podając wersję programu, miejsce występowania problemu i proponowane tłumaczenie.

## Społeczność i pomoc

- [Repozytorium GitHub](https://github.com/t8y2/dbx)
- [Oficjalne wydania](https://github.com/t8y2/dbx/releases)
- [Zgłaszanie błędów i sugestii](https://github.com/t8y2/dbx/issues)
- [Pull Requests](https://github.com/t8y2/dbx/pulls)
- [Społeczność Discord](https://discord.gg/W7NyVDRt6a)

## Współtworzenie projektu

DBX jest projektem open source. Możesz pomagać, zgłaszając błędy, proponując ulepszenia, aktualizując dokumentację i przesyłając Pull Requesty. Przed wysłaniem zmian zapoznaj się z zasadami współpracy obowiązującymi w repozytorium.

## Licencja

Informacje o licencji i warunkach wykorzystania projektu znajdują się w [oficjalnym repozytorium DBX](https://github.com/t8y2/dbx).

---

*To polska wersja dokumentacji wprowadzającej. W razie rozbieżności dotyczących funkcji, instalacji lub licencji należy kierować się aktualną dokumentacją i plikami oficjalnego repozytorium.*
