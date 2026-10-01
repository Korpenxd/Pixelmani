# Pixelmani

Fotosajt för Per-Arne Hederstaf, byggd med Next.js (App Router) och Supabase.

- **Publika sidor:** `/` (start) och `/showcase` (bildgalleri).
- **Admin:** `/admin` — inloggning, uppladdning av bilder, kategorier och val av landningsbild. Sidan är `noindex` och blockerad i `robots.txt`.
- **Data:** bilder och kategorier ligger i Supabase (tabellerna `photos`, `categories`, `site_settings` samt storage-bucketen `photos`).

## Kom igång

```bash
npm install
npm run dev
```

Skapa en `.env.local` med:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SITE_URL=https://pixelmani.se
SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_PASSWORD=...
ADMIN_SESSION_TOKEN=...

# Publika data hämtas från PHP-API:t (php/). Krävs för build och server-
# rendering; webbläsaren använder alltid relativa /api/...-adresser.
PIXELMANI_BUILD_API_BASE=http://pixelmani.test/api
```

`PIXELMANI_BUILD_API_BASE` pekar på PHP-API:t som bygget hämtar bilder,
kategorier och landningsbild från. Lokalt är det Laragons
`http://pixelmani.test/api` (se [`php/README.md`](php/README.md)). Utan den
avbryts bygget med ett tydligt felmeddelande. Supabase används inte som
reserv. Så länge sajten körs med Next.js-server vidarebefordras
`/api/{health,photos,categories,hero,hero-image}` och `/media/*` till samma
PHP-server (`rewrites()` i `next.config.ts`), så webbläsaren bara pratar med
sin egen origin. `/api/admin/*` hanteras fortfarande av Next.js.

## Produktionsdomän och miljöer

Domänen används för canonical-länkar, `sitemap.xml`, `robots.txt`, Open Graph-URL:er och JSON-LD. Basadressen väljs miljömedvetet i [`lib/site.ts`](lib/site.ts):

| Miljö | Bas-URL | Indexeras? |
| --- | --- | --- |
| Production (`VERCEL_ENV=production`) | `NEXT_PUBLIC_SITE_URL`, annars `https://pixelmani.se` | Ja |
| Preview (`VERCEL_ENV=preview`) | deployens egen URL (`VERCEL_URL`) | **Nej** – `noindex` + `Disallow: /` |
| Lokalt / egen server | `NEXT_PUBLIC_SITE_URL` från `.env.local` | Ja |

Preview-deployer pekar alltså aldrig sin canonical mot produktionsdomänen, och de blockeras både i `robots.txt` och via robots-metataggen. Vercel exponerar `VERCEL_ENV` och `VERCEL_URL` automatiskt – ingen konfiguration behövs.

Ska domänen bytas räcker det att ändra på två ställen:

1. `NEXT_PUBLIC_SITE_URL` i `.env.local` och (om den används) i Vercels miljövariabler för **Production**.
2. `PRODUCTION_SITE_URL` i [`lib/site.ts`](lib/site.ts).

`www` omdirigeras permanent till apex-domänen via `redirects()` i [`next.config.ts`](next.config.ts) — värdnamnet står där och behöver uppdateras vid domänbyte.

## Adress och verksamhetsområde

Pixelmani beskrivs i strukturerad data som ett *service-area business*: geografin ligger i `areaServed` (Alingsås och Alingsås kommun), inte i en gatuadress. Finns det någon gång en besöksadress fylls `streetAddress` och `postalCode` i [`lib/site.ts`](lib/site.ts) i, varpå en `PostalAddress` läggs till automatiskt. Publicera aldrig en privat hemadress bara för att uppfylla ett krav för rich results.

## SEO-relaterade filer

| Fil | Ansvar |
| --- | --- |
| [`lib/site.ts`](lib/site.ts) | Domän, kontaktuppgifter, verksamhetsort och prispaketen — en enda källa för resten. |
| [`lib/metadata.ts`](lib/metadata.ts) | Bygger `title`, beskrivning, canonical, Open Graph och Twitter-taggar per sida. |
| [`lib/structuredData.ts`](lib/structuredData.ts) | JSON-LD: `WebSite`, `ProfessionalService`, `Person`, `BreadcrumbList` och `ImageGallery`. |
| [`lib/photoAlt.ts`](lib/photoAlt.ts) | Alt-texter som byggs av bildens titel och plats. |
| [`app/sitemap.ts`](app/sitemap.ts) | Sitemap med bild-URL:er för galleriet. |
| [`app/robots.ts`](app/robots.ts) | Robots-regler; `/admin` och `/api` är blockerade. |
| `app/opengraph-image.png` | Delningsbild, 1200×630. Genererad från logotypen. |

Titlar och beskrivningar sätts per sida i `app/page.tsx` respektive `app/showcase/page.tsx`.

## Innehåll och uppdatering

Start- och galerisidan förrenderas med en ögonblicksbild från PHP-API:t, så att bilderna, alt-texterna och den strukturerade datan finns i HTML:en. Sidorna uppdateras dessutom var femte minut (`export const revalidate = 300`). Efter att sidan laddats hämtar webbläsaren aktuella bilder och kategorier från `/api/photos` och `/api/categories` och gör det igen när fliken blir synlig. Misslyckas hämtningen ligger ögonblicksbilden kvar. Adminpanelen läser och skriver fortfarande mot Supabase tills PHP-adminen är klar.

Fyll i **titel** och **plats** på varje bild i adminpanelen — de används som alt-text, bildtext i lightboxen och i galleriets strukturerade data.

## Kommandon

```bash
npm run dev      # utvecklingsserver
npm run build    # produktionsbygge
npm run lint     # eslint
npx tsc --noEmit # typkontroll
```
