# Pixelmani

Fotosajt för Per-Arne Hederstaf. Frontend i Next.js (App Router) som byggs till en **statisk export**; backend i PHP med MySQL/MariaDB. I drift krävs ingen Node.js.

- **Publika sidor:** `/` (start) och `/showcase` (bildgalleri).
- **Admin:** `/admin` — inloggning, uppladdning av bilder, kategorier och val av landningsbild. Sidan är `noindex` och blockerad i `robots.txt`.
- **Data:** bilder, kategorier och inställningar ligger i MySQL/MariaDB; bildfilerna under `/media`. Backend och API beskrivs i [`php/README.md`](php/README.md), databasen i [`db/README.md`](db/README.md).

## Arkitektur

```
BYGGE   npm run build ── hämtar bilder/kategorier/landningsbild från PHP-API:t
                         └─► out/  (statisk HTML/CSS/JS)

DRIFT   Apache ─┬─ out/            /, /showcase, /admin, /_next/…
                ├─ PHP-API         /api/*      (php/public/api)
                └─ bildfiler       /media/*
                       └─ MySQL / MariaDB
```

Webbläsaren pratar bara med sin egen origin: statiska filer, `/api` och `/media`. Ingen Node-server, inga Next-route handlers, ingen Supabase.

## Utveckling

Kräver Laragon (Apache + PHP + MySQL) enligt [`php/README.md`](php/README.md#local-development-laragon).

```bash
npm install
npm run dev        # next dev på port 3000
```

Öppna sedan <http://pixelmani.test/>. Laragons vhost (`php/dev/apache-vhost.local.conf`) ger hela sajten en origin: `/api/*` och `/media/*` går till PHP, allt annat proxas till `next dev`. Därför fungerar adminens session, Origin-kontroll och CSRF precis som i produktion. `allowedDevOrigins` i `next.config.ts` gäller bara `next dev`.

## Miljövariabler

### Applikationen

`.env.local` (gitignorerad):

```
NEXT_PUBLIC_SITE_URL=https://pixelmani.se

# PHP-API:t som bygget hämtar data från. Bara på serversidan, hamnar aldrig i webbläsaren.
PIXELMANI_BUILD_API_BASE=http://pixelmani.test/api
```

Backendens inställningar (databas, `ADMIN_PASSWORD_HASH` m.m.) ligger i `.env.loopia.local` lokalt eller i serverns miljö/`php/config/config.php`. Mallen finns i [`.env.loopia.example`](.env.loopia.example).

### Verktyg för slutlig datasynk (tillfälligt)

Bara de skrivskyddade migreringsverktygen i `db/tools/` använder dessa, inför den sista synken från Supabase:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

De tas bort när synken är gjord. `NEXT_PUBLIC_`-prefixet är historiskt. Applikationen läser dem inte, och den statiska exporten innehåller dem inte.

### Utgått

`ADMIN_PASSWORD`, `ADMIN_SESSION_TOKEN` och `SUPABASE_SERVICE_ROLE_KEY` hörde till den gamla Next/Supabase-adminen och används inte längre. Adminen loggar in mot PHP med `ADMIN_PASSWORD_HASH`. Gamla värden i en lokal `.env.local` kan tas bort.

## Bygge

```bash
npm run build      # next build + scripts/fix-export-segments.mjs (postbuild)
```

- PHP och MySQL måste vara igång, och `PIXELMANI_BUILD_API_BASE` måste peka på PHP-API:t.
- Saknas variabeln, eller svarar inte API:t, avbryts bygget med ett tydligt fel. Det blir aldrig sidor utan innehåll, och det finns ingen reserv mot Supabase.
- Resultatet hamnar i **`out/`**: `index.html`, `showcase.html`, `admin.html`, `404.html`, `sitemap.xml`, `robots.txt` och `_next/static/`.

Testa exporten lokalt utan Node:

```bash
npm run serve:static                 # Apache på http://pixelmani.test:8090/
node php/dev/serve-static.mjs stop
```

## Drift

Apache + PHP 8.3 + MariaDB/MySQL. Ingen Node.js.

Säkerhetsheaders, omdirigeringen `www` → apex och regler för rena URL:er (`/showcase` → `showcase.html`) ska ligga i Apache. De sattes tidigare av Next.js. Exakta värden och krav finns under **Apache handoff** i [`php/README.md`](php/README.md#apache-handoff-phase-10).

## Produktionsdomän

Domänen används för canonical-länkar, `sitemap.xml`, `robots.txt`, Open Graph-URL:er och JSON-LD. Den sätts vid bygget via `NEXT_PUBLIC_SITE_URL`, annars `PRODUCTION_SITE_URL` i [`lib/site.ts`](lib/site.ts) (`https://pixelmani.se`).

`lib/site.ts` känner också igen Vercels `VERCEL_ENV`/`VERCEL_URL`, så att preview-byggen inte indexeras. Utanför Vercel är de inte satta, och då gäller produktionsdomänen och indexering är på.

Ska domänen bytas:
1. Ändra `NEXT_PUBLIC_SITE_URL` och `PRODUCTION_SITE_URL` i `lib/site.ts`.
2. Ändra `SITE_URL` för PHP-backenden.
3. Ändra Apache-omdirigeringen `www` → apex.
4. Bygg om.

## Adress och verksamhetsområde

Pixelmani beskrivs i strukturerad data som ett *service-area business*: geografin ligger i `areaServed` (Alingsås och Alingsås kommun), inte i en gatuadress. Finns det någon gång en besöksadress fylls `streetAddress` och `postalCode` i [`lib/site.ts`](lib/site.ts) i, varpå en `PostalAddress` läggs till automatiskt. Publicera aldrig en privat hemadress bara för att uppfylla ett krav för rich results.

## SEO-relaterade filer

| Fil | Ansvar |
| --- | --- |
| [`lib/site.ts`](lib/site.ts) | Domän, kontaktuppgifter, verksamhetsort och prispaketen — en enda källa för resten. |
| [`lib/metadata.ts`](lib/metadata.ts) | Bygger `title`, beskrivning, canonical, Open Graph och Twitter-taggar per sida. |
| [`lib/structuredData.ts`](lib/structuredData.ts) | JSON-LD: `WebSite`, `ProfessionalService`, `Person`, `BreadcrumbList` och `ImageGallery`. |
| [`lib/photoAlt.ts`](lib/photoAlt.ts) | Alt-texter som byggs av bildens titel och plats. |
| [`app/sitemap.ts`](app/sitemap.ts) | Sitemap med bild-URL:er för galleriet (genereras vid bygget). |
| [`app/robots.ts`](app/robots.ts) | Robots-regler; `/admin` och `/api` är blockerade. |
| `app/opengraph-image.png` | Delningsbild, 1200×630. Genererad från logotypen. |

Titlar och beskrivningar sätts per sida i `app/page.tsx` respektive `app/showcase/page.tsx`.

## Innehåll och uppdatering

Start- och galerisidan byggs med en ögonblicksbild från PHP-API:t. Bilderna, alt-texterna och den strukturerade datan finns alltså i den statiska HTML:en.

När sidan har laddats hämtar webbläsaren aktuella bilder och kategorier från `/api/photos` och `/api/categories`, och gör det igen när fliken blir synlig. Nya bilder från adminen syns därför direkt, utan nytt bygge. Misslyckas hämtningen ligger ögonblicksbilden kvar.

`sitemap.xml` och ögonblicksbilden uppdateras först vid nästa bygge.

Fyll i **titel** och **plats** på varje bild i adminpanelen — de används som alt-text, bildtext i lightboxen och i galleriets strukturerade data.

## Kommandon

```bash
npm run dev            # utveckling (bakom Laragons Apache, se ovan)
npm run build          # statisk export till out/
npm run serve:static   # testa out/ lokalt med Apache + PHP, utan Node
npm test               # enhetstester för adminlogiken
npm run lint           # eslint
npx tsc --noEmit       # typkontroll
php php/tests/smoke.php   # PHP-backendens tester
```
