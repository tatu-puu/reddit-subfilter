# Reddit Subfilter

Userscript, joka piilottaa ei-toivotut subredditit ja mainokset Redditistä. Toimii koneella (Chrome/Firefox) ja Androidilla (Firefox) Violentmonkeyn kautta. Estolista synkronoituu laitteiden välillä oman yksityisen subredditin wikisivun kautta.

Nykyinen versio: **1.8.0**, tiedosto `reddit-subfilter.user.js`.

## Ominaisuudet

- ✕-nappi jokaisessa postauksessa piilottaa koko subin, ja 5 sekunnin ajan voi painaa **Peru**.
- Jokerimerkkisuodattimet: `*india*` (nimessä missä tahansa), `india*` (alkaa), `*india` (päättyy).
- Mainosten piilotus (Asetukset → Piilota mainokset, oletuksena päällä).
- Laskuripaneeli oikeassa alakulmassa näyttää piilotetut subit tältä kerralta ja kaikkiaan. Tilarivillä näkyvät synkkauksen tila ja mainosten määrä.
- Asetukset ovat paneelissa: synkkaus-subreddit, suodattimen lisäys, koko listan muokkaus ja vianetsintä.
- Jos avaat estetyn subin suoraan, se näkyy normaalisti.
- Piilottaa Redditin "Avaa sovelluksessa" -popupin ja poistaa sen mukana tulevan scroll-lukituksen.

## Asennus

1. Asenna Violentmonkey: koneella Chrome/Firefox, Androidilla Firefox (Lisäosat).
2. Lisää skripti Violentmonkeyyn.
3. **Päivittäessä korvaa vanhan skriptin sisältö.** Älä lisää uutta skriptiä, koska jokaisella kopiolla on omat asetuksensa.

## Päivitys jatkossa

Repo on julkinen, ja skriptissä on `@updateURL`/`@downloadURL` osoittamassa GitHubin raw-tiedostoon. Kun uusi versio on pushattu `main`-haaraan:

- Violentmonkey tarkistaa päivitykset itse ajoittain (oletuksena n. kerran vuorokaudessa), sekä koneella että Androidilla — ei vaadi mitään, jos ehtii odottaa.
- Pakota tarkistus heti: Violentmonkey-kojelauta → skriptin kohdalla **Tarkista päivitykset** (koneella ja puhelimella sama painike).
- Vaihtoehto ilman kojelautaa: avaa puhelimella/koneella suoraan `https://raw.githubusercontent.com/tatu-puu/reddit-subfilter/main/reddit-subfilter.user.js` Firefoxissa — Violentmonkey tunnistaa `.user.js`-tiedoston ja tarjoaa "Päivitä"-dialogin, koska `@namespace`+`@name` täsmää olemassa olevaan skriptiin.

Versionumeroa (`@version`) pitää nostaa jokaisessa muutoksessa, muuten Violentmonkey ei näe uutta versiota päivityksenä.

## Synkkaus

- Estolista on sivulla `old.reddit.com/r/estotestitatu/wiki/estolista`. Siinä on yksi subi tai suodatin per rivi, ja `#`-alkuiset rivit ohitetaan.
- Subreddit on yksityinen, ja wikin asetus on **mod editing** (`old.reddit.com/r/estotestitatu/about/edit`).
- Käyttöönotto laitteella: paneeli → **Asetukset** → Synkkaus-subreddit → `estotestitatu` → **Tallenna**.
  - Jos tallennus ei jää voimaan, lisää Violentmonkeyssa skriptin **Values**-välilehdelle avain `syncSub` ja arvo `"estotestitatu"`.
- Toiselle Reddit-tilille oikeudet ilman mod-kutsua:
  - `about/contributors`: hyväksytty käyttäjä, jolloin tili näkee subin.
  - `about/wikicontributors`: tili saa muokata wikiä.

## Vianetsintä

- Paneelin tilarivi kertoo "Synkattu klo …" tai virheen tekstin.
- Asetukset → **Synkkauksen vianetsintä** testaa molemmat yhteystavat. Skripti kokeilee ensin sivun omaa hakua ja sitten Violentmonkeyn pyyntöä old.reddit.comiin, ja muistaa niistä sen, joka toimi.

## Tekniset päätökset (muistiinpanoja jatkokehitykseen)

- **Postausten tunnistus:**
  - Uusi Reddit ja mobiili: `shreddit-post[subreddit-prefixed-name]`, kääreenä `article`.
  - old.reddit: `.thing.link[data-subreddit]`.
- **Piilotus:** postaus litistetään 0 pikselin korkuiseksi eikä sille käytetä `display: none` -tyyliä. Redditin loputon scrollaus lataa lisää vasta, kun loppupään postaus tulee näkyviin, joten `display: none` pysäytti syötteen.
- **Asetukset sivulla eikä prompt-ikkunoissa:** `prompt()` ei toiminut Android-Firefoxissa.
- **Synkkaus jonottaa muutokset** (`pendingAdd`/`pendingRemove`) ja yhdistää ne wikin listaan. Jos kaksi laitetta muokkaa yhtä aikaa, Reddit palauttaa 409-vastauksen ja skripti yrittää uudelleen. Puuttuva wikisivu ei tyhjennä paikallista listaa.
- **Mainosselektorit:** `shreddit-ad-post`, `shreddit-comments-page-ad`, `shreddit-comment-tree-ad`, `shreddit-sidebar-ad` ja old.redditin `.promoted`-luokat. Näitä ei ole tarkistettu oikealta Redditiltä, joten ne voivat vaatia päivitystä.
- **"Avaa sovelluksessa" -popupin selektorit** (`#xpromo-bottom-sheet`, `[id^="xpromo-"]`, `.rpl-bottom-sheet`, luokat `rpl-scroll-lock`/`scroll-disabled`/`m-blurred`) ovat peräisin [uBlockOrigin/uAssets-issuesta #32706](https://github.com/uBlockOrigin/uAssets/issues/32706), ei omasta havainnosta — selaimen reddit.com-automaatio oli estetty, joten koodia ei päästy testaamaan oikealla sivulla. Reddit A/B-testaa popupia, joten selektorit voivat muuttua.

## Versiohistoria

| Versio | Muutos |
|---|---|
| 1.0 | Piilotus ✕-napilla, Peru, estolistan muokkaus |
| 1.1 | Laskuripaneeli |
| 1.2 | Synkkaus wikisivun kautta |
| 1.3 | Jokerimerkkisuodattimet |
| 1.4 | Kaksi yhteystapaa, tilarivi, vianetsintä |
| 1.5 | Asetukset paneeliin (Android-korjaus) |
| 1.6 | Korjaus: syöte ei enää pysähdy |
| 1.7 | Mainosten piilotus |
| 1.7.1 | Korjaus: wikiin kirjoitus 404 (www.reddit.com ei tunne vanhaa wiki-rajapintaa → varareitti old.redditiin) |
| 1.8.0 | "Avaa sovelluksessa" -popupin ja scroll-lukituksen poisto |

## Jatkoideoita

- Piilotus myös hakutuloksista ja suosituksista.
- Avainsanasuodatus postausten otsikoista.
