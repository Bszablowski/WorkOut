# Dziennik treningów na Cloudflare

Aplikacja (`index.html` z katalogu głównego) działa jako Cloudflare Worker, a dane trzyma w bazie D1.
API jest takie samo jak w wersji z Dockerem i PostgreSQL (`server/`), dochodzi logowanie hasłem.
Darmowy plan Cloudflare w zupełności wystarcza i nie wymaga karty.

## Pierwsze wdrożenie

Wszystkie polecenia uruchamiasz w katalogu `cloudflare/`.

1. Załóż darmowe konto na dash.cloudflare.com.
2. `npm install`
3. `npx wrangler login` i zatwierdź dostęp w przeglądarce.
4. `npx wrangler d1 create treningi` i wpisz zwrócone `database_id` do `wrangler.jsonc`.
5. `npx wrangler d1 execute treningi --remote --file schema.sql`
6. `npm run deploy` (wypisze adres aplikacji `https://treningi.<twoja-subdomena>.workers.dev`).
7. `npx wrangler secret put APP_PASSWORD` i wpisz hasło do aplikacji.

## Aktualizacja po zmianach w index.html

`npm run deploy`. Przy zmianie plików aplikacji podbij też wersję `CACHE` w `sw.js`.

## Kopia danych

`npx wrangler d1 export treningi --remote --output kopia.sql`

Poprzednie wersje dokumentów (90 dni) są w tabeli `docs_history`.

## Test lokalny

Utwórz plik `.dev.vars` z linią `APP_PASSWORD=test123`, potem:

```
npx wrangler d1 execute treningi --local --file schema.sql
npm run dev
```
