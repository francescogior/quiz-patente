# Quiz Patente AB PWA

App statica mobile friendly per simulare la scheda teorica della patente AB.

## Dati

La banca dati viene dal Portale dell'Automobilista, sezione pubblica "Quiz per le patenti AM, B, superiori e CQC".

- Fonte: https://ilportaledellautomobilista.it/web/portale-automobilista/-/quiz-per-le-patenti-am-b-superiori-e-cqc
- PDF usato: `data/source/domande-ab-italiano-2025.pdf`
- Dataset generato: 7.085 domande usabili, 3.954 con figura, 409 immagini uniche.

Le domande grafiche senza associazione immagine sicura vengono escluse durante la generazione, per evitare schede con riferimenti a figure mancanti.

## Avvio locale

```bash
python3 -m http.server 4173
```

Poi apri `http://localhost:4173`.

## Rigenerare il dataset

```bash
/Users/fg/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/build_dataset.py
```
