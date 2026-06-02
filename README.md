# Quiz Patente AB PWA

App statica mobile friendly per simulare la scheda teorica della patente AB.

## Dati

La banca dati viene dal Portale dell'Automobilista, sezione pubblica "Quiz per le patenti AM, B, superiori e CQC".

- Fonte: https://ilportaledellautomobilista.it/web/portale-automobilista/-/quiz-per-le-patenti-am-b-superiori-e-cqc
- PDF usato: `data/source/domande-ab-italiano-2025.pdf`
- Dataset generato: 7.085 domande usabili, 3.954 con figura, 409 immagini uniche.

Le domande grafiche senza associazione immagine sicura vengono escluse durante la generazione, per evitare schede con riferimenti a figure mancanti.

La fonte ministeriale non include spiegazioni testuali per le singole risposte. Nel riepilogo l'app può generare spiegazioni AI, salvandole su Supabase per riusarle senza rigenerarle.

Con Supabase e Resend configurati, l'app abilita anche un accesso passwordless via codice email e salva le simulazioni completate per mostrare i progressi dell'utente.

## Backend leggero

Variabili richieste:

```bash
cp .env.example .env.local
```

Poi compila `.env.local` e sincronizza le env production su Vercel:

```bash
node scripts/sync_vercel_env.mjs
```

Prima del deploy, crea le tabelle con `supabase/schema.sql` nel SQL Editor di Supabase. Puoi verificare che siano raggiungibili con:

```bash
node scripts/check_ai_setup.mjs
```

## Avvio locale

```bash
python3 -m http.server 4173
```

Poi apri `http://localhost:4173`.

## Rigenerare il dataset

```bash
/Users/fg/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/build_dataset.py
```
