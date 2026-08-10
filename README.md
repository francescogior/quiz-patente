# Quiz Patente AB PWA

App statica mobile friendly per simulare la scheda teorica della patente AB.

## Dati

La banca dati viene dal Portale dell'Automobilista, sezione pubblica "Quiz per le patenti AM, B, superiori e CQC".

- Fonte: https://ilportaledellautomobilista.it/web/portale-automobilista/-/quiz-per-le-patenti-am-b-superiori-e-cqc
- PDF usato: `data/source/domande-ab-italiano-2025.pdf`
- Dataset generato: 7.085 domande usabili, 3.954 con figura, 409 immagini uniche.

Le domande grafiche senza associazione immagine sicura vengono escluse durante la generazione, per evitare schede con riferimenti a figure mancanti.

La fonte ministeriale non include spiegazioni testuali per le singole risposte. L’accesso
anonimo offre una domanda dimostrativa; un account Free sblocca simulazioni complete in
italiano, storico e ripasso; Quiz Patente Plus aggiunge spiegazioni AI e traduzioni. I
contenuti generati vengono salvati per gli utenti Plus e riutilizzati senza rigenerarli.

Con Neon e Resend configurati, l'app abilita anche un accesso passwordless via codice email e salva le simulazioni completate per mostrare i progressi dell'utente.

Quiz Patente crea direttamente le proprie sessioni Stripe Checkout: prezzo,
account, URL di ritorno e branding sono definiti dal server dell’app. Il checkout
usa il nome e l’icona di Quiz Patente e non dipende da proxy o progetti
sperimentali esterni. Il webhook firmato persiste l’accesso Plus anche se la
pagina viene chiusa subito dopo il pagamento; il ritorno dal checkout resta un
percorso idempotente di recupero.

## Backend leggero

Variabili richieste:

```bash
cp .env.example .env.local
```

Poi compila `.env.local` e sincronizza le env production su Vercel:

```bash
node scripts/sync_vercel_env.mjs
```

Il database Neon è provisionato tramite Vercel Marketplace. Prima del deploy, applica `neon/schema.sql` e verifica che le tabelle siano raggiungibili con:

```bash
node scripts/check_ai_setup.mjs
```

Per Plus configura inoltre nello stesso progetto Vercel le variabili
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNT_ID`,
`STRIPE_PLUS_PRODUCT_ID`, `STRIPE_PLUS_PRICE_ID` e `STRIPE_EXPECT_LIVEMODE`.
Il Product deve chiamarsi `Quiz Patente Plus — 30 giorni`, avere metadata
`app_slug=quizpatente` e `product_slug=quizpatente-plus`; il Price deve essere
attivo, una tantum, pari a 3,99 EUR e collegato a quel Product. Product, Price, chiave e
webhook devono appartenere all’account Stripe reaLbit previsto. Il webhook di
produzione richiede `STRIPE_EXPECT_LIVEMODE=true`. Il webhook di
produzione è `https://quizpatente.realb.it/api/stripe-webhook`; ascolta
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`charge.refunded`, `charge.dispute.created` e `charge.dispute.closed`. Il
rimborso revoca l’accesso; una contestazione lo sospende e lo ripristina
automaticamente se Stripe la chiude a favore del cliente. Il checkout accetta soltanto
pagamenti con carta, così i 30 giorni partono dal pagamento verificato senza
metodi differiti.

## Avvio locale

```bash
python3 -m http.server 4173
```

Poi apri `http://localhost:4173`.

## Rigenerare il dataset

```bash
/Users/fg/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/build_dataset.py
```
