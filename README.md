# server-pdf

Serviciu HTTP intern pentru generarea documentelor PDF A4 din pagini web, folosind Express, Puppeteer și Google Chrome.

## Arhitectură de producție

Aplicația rulează ca utilizatorul Linux `pdf`, exclusiv din:

```text
/home/pdf/server
├── server.js
├── key-store.js
├── package.json
├── package-lock.json
├── node_modules/
├── environment
├── master-key.json
├── apikeys.json
├── api-key-metadata.json
├── .deployed-commit
├── logs/
└── postman/
```

Unitatea systemd este `/etc/systemd/system/html2pdf.service`, iar portul implicit este `8214`. Datele aplicației nu sunt stocate în `/opt/html2pdf` sau `/etc/html2pdf`.

## Instalare nouă

`install.sh` este destinat exclusiv serverelor noi. Sunt suportate Debian/Ubuntu și AlmaLinux/Rocky Linux/RHEL 8–9 pe `x86_64`. Installerul detectează distribuția din `/etc/os-release`, folosește `apt` sau `dnf`, instalează Node.js 22 și Google Chrome Stable, creează utilizatorul `pdf`, generează cheile inițiale și pornește serviciul:

```bash
sudo git clone https://github.com/stempora/server-pdf.git /home/pdf/server
cd /home/pdf/server
sudo ./install.sh
```

Cheia master este afișată numai atunci când este generată prima dată. Salvați-o imediat într-un manager de secrete. Fișierele cu chei sunt create cu owner `pdf:pdf` și permisiuni `0600`.

Configurația implicită din `/home/pdf/server/environment` este:

```env
PORT=8214
CHROME_PATH=/usr/bin/google-chrome-stable
API_KEYS_FILE=/home/pdf/server/apikeys.json
MASTER_KEY_FILE=/home/pdf/server/master-key.json
API_KEY_METADATA_FILE=/home/pdf/server/api-key-metadata.json
LOG_DIR=/home/pdf/server/logs
METRICS_DB_FILE=/home/pdf/server/data/metrics.sqlite
METRICS_ENABLED=true
METRICS_FLUSH_INTERVAL_MS=2000
METRICS_FLUSH_MAX_EVENTS=100
METRICS_MAX_PENDING_EVENTS=10000
PDF_REQUEST_TIMEOUT_MS=60000
PDF_TIMEOUT_CLEANUP_MS=3000
BROWSER_MAX_REQUESTS=5000
BROWSER_MAX_UPTIME_SECONDS=21600
WATCHDOG_URL=http://127.0.0.1:8214/health
WATCHDOG_TIMEOUT_SECONDS=10
WATCHDOG_FAILURE_THRESHOLD=2
WATCHDOG_RESTART_COOLDOWN_SECONDS=60
```

`PDF_REQUEST_TIMEOUT_MS` limitează întregul ciclu al unei cereri, inclusiv singura reîncercare permisă după o eroare recuperabilă Chrome. Cleanup-ul are un buget separat și strict, `PDF_TIMEOUT_CLEANUP_MS`; implicit răspunsul este limitat la 60 s de procesare plus maximum 3 s de cleanup. La timeout pagina este închisă, iar dacă închiderea Chrome se blochează procesul afectat primește `SIGKILL` înainte ca slotul să fie eliberat și clientul să primească `504`. Erorile obișnuite ale paginii, URL-urile invalide, timeout-urile și anulările nu sunt reîncercate.

Chrome este reciclat controlat după `BROWSER_MAX_REQUESTS` documente sau după `BROWSER_MAX_UPTIME_SECONDS`, fără a închide pagini active. Valoarea `0` dezactivează limita respectivă. La `SIGTERM`/`SIGINT`, cererile noi și cele încă în coadă primesc `503`, cererile active sunt lăsate să termine, apoi browserul este închis. `SHUTDOWN_TIMEOUT_MS` rămâne limita forțată de oprire.

## Cheia master

Formatul `/home/pdf/server/master-key.json` este:

```json
{
  "key": "CHEIA_MASTER_COMPLETA",
  "created_at": "2026-08-17T00:00:00.000Z"
}
```

Pentru o instalare de producție existentă care nu are încă acest fișier, generați-l controlat înaintea primului update:

```bash
sudo ./scripts/create-master-key.sh
```

Scriptul nu înlocuiește o cheie existentă și o afișează numai la creare.

> Cheia master oferă acces la toate cheile API, inclusiv valorile complete. Nu o includeți în Git, loguri, capturi sau tichete.

## Endpointuri

### Health

```bash
curl http://127.0.0.1:8214/health
```

### Generare PDF

Autentificarea existentă este păstrată atât prin header, cât și prin query string:

```bash
curl --get 'http://127.0.0.1:8214/pdf' \
  --data-urlencode 'url=https://example.com' \
  -H 'X-API-Key: CHEIA_API' \
  --output pagina.pdf
```

```bash
curl --get 'http://127.0.0.1:8214/pdf' \
  --data-urlencode 'url=https://example.com' \
  --data-urlencode 'apikey=CHEIA_API' \
  --output pagina.pdf
```

### Creare cheie API

```bash
curl -X POST http://127.0.0.1:8214/admin/create-key \
  -H 'Authorization: Bearer CHEIA_MASTER' \
  -H 'Content-Type: application/json' \
  -d '{"name":"main-app"}'
```

### Listare chei API

```bash
curl http://127.0.0.1:8214/admin/list-keys \
  -H 'Authorization: Bearer CHEIA_MASTER'
```

`list-keys` returnează intenționat cheile complete, nemascate. Cheile vechi fără metadata sunt listate ca active, cu `name` și `created_at` egale cu `null`.

### Dezactivare

```bash
curl -X POST 'http://127.0.0.1:8214/admin/disable-key/CHEIA_API' \
  -H 'Authorization: Bearer CHEIA_MASTER'
```

### Reactivare

```bash
curl -X POST 'http://127.0.0.1:8214/admin/enable-key/CHEIA_API' \
  -H 'Authorization: Bearer CHEIA_MASTER'
```

### Ștergere

```bash
curl -X DELETE 'http://127.0.0.1:8214/admin/delete-key/CHEIA_API' \
  -H 'Authorization: Bearer CHEIA_MASTER'
```

Dezactivarea, reactivarea și ștergerea au efect imediat, fără restart.

## Update sigur în producție

Repository-ul Git și aplicația instalată sunt același director: `/home/pdf/server`. `update.sh` validează direct fișierele aduse de `git pull`; nu copiază aplicația din alt checkout. Nu instalează Node.js sau Chrome, nu creează utilizatori, nu schimbă systemd și nu înlocuiește configurația, cheile sau logurile.

Fluxul de update este:

```bash
cd /home/pdf/server
git pull --ff-only
sudo ./scripts/create-master-key.sh   # numai la prima migrare
sudo ./update.sh
```

După primul health check reușit, commitul activ este salvat în `.deployed-commit`. La prima actualizare a unei instalări vechi, updaterul folosește `ORIG_HEAD` numai dacă este un strămoș valid al lui `HEAD`; dacă această bază nu este disponibilă, commitul aflat anterior în producție trebuie furnizat explicit:

```bash
sudo DEPLOYED_COMMIT=SHA_COMMIT_ANTERIOR ./update.sh
```

Update-ul refuză un repository Git murdar, validează fișierele și JSON-urile deja actualizate, creează un backup în `/home/pdf/server-backups/TIMESTAMP`, rulează `npm ci --omit=dev --ignore-scripts` numai când manifestele diferă între commituri, repornește serviciul și verifică `/health`.

## Backup și rollback

Dacă validarea, instalarea dependențelor, restartul sau health check-ul eșuează, `update.sh` revine cu `git reset --hard` la commitul din `.deployed-commit`, restaurează `node_modules` când a fost modificat și verifică versiunea veche. Fișierele ignorate — configurația, cheile și logurile — nu sunt șterse și nu se folosește `git clean`.

Rollback-ul automat este recomandat. După un rollback reușit, retry-ul este:

```bash
cd /home/pdf/server
git pull --ff-only
sudo ./update.sh
```

Fișierele `environment`, `master-key.json`, `apikeys.json`, `api-key-metadata.json`, `data/metrics.sqlite` și `logs/` nu sunt înlocuite de updater.

## Watchdog systemd

Instalarea nouă activează watchdog-ul numai după ce serviciul principal a trecut health check-ul. Pentru o instalare existentă, după actualizarea validată a aplicației, unitățile se instalează separat:

```bash
cd /home/pdf/server
sudo ./scripts/install-watchdog.sh
```

Acest script activează doar `html2pdf-watchdog.timer`; nu repornește și nu pornește `html2pdf.service`. Timerul verifică la 30 de secunde răspunsul HTTP `200` și JSON-ul `{"status":"ok","browser":"connected"}`. După două eșecuri consecutive repornește serviciul, apoi verifică din nou. Cooldown-ul implicit este 60 de secunde, iar starea și lock-ul sunt exclusiv în `/run/html2pdf-watchdog`.

Diagnostic:

```bash
systemctl status html2pdf-watchdog.timer
journalctl -u html2pdf-watchdog.service -n 100 --no-pager
sudo systemctl start html2pdf-watchdog.service
```

Rollback-ul codului prin `update.sh` nu modifică unitățile instalate. Pentru a dezactiva watchdog-ul fără a afecta serviciul PDF:

```bash
sudo systemctl disable --now html2pdf-watchdog.timer
```

## Statistici SQLite per API key

Statisticile sunt păstrate implicit în `/home/pdf/server/data/metrics.sqlite`, cu owner `pdf:pdf` și mod `0600`. Directorul și baza sunt create automat la startup și explicit prin:

```bash
node scripts/init-metrics-db.js
node scripts/init-metrics-db.js --check
node scripts/init-metrics-db.js --status
```

Schema folosește `PRAGMA user_version`, iar migrările sunt idempotente. SQLite rulează în WAL, cu `synchronous=NORMAL`, `busy_timeout=5000` și foreign keys active. `update.sh` migrează înainte de restart și creează un backup consistent înaintea unei migrări existente; rollback-ul codului nu șterge baza.

SQLite conține numai fingerprintul SHA-256, nu cheia API completă. Evenimentele sunt agregate în memorie și scrise tranzacțional la 2 secunde sau 100 de evenimente. Retry-ul Chrome aparține aceleiași conversii și nu dublează contoarele.

- `request_count`: request `/pdf` cu o cheie validă;
- `started_count`: conversie preluată din coadă;
- `success_count`, `error_count`, `timeout_count`: rezultatul final;
- `queue_rejected_count`: coadă plină;
- `client_aborted_count`: client deconectat înainte de răspuns;
- `validation_error_count`: URL lipsă sau invalid după autentificare.

Durata nu include timpul din coadă, iar statisticile zilnice folosesc UTC. La ștergerea unei chei, statisticile și ultimul nume rămân, dar cheia completă nu este păstrată.

```text
GET /admin/list-keys
GET /admin/metrics?limit=100&offset=0
GET /admin/metrics/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&fingerprint=SHA256
```

Intervalul zilnic este limitat la 366 zile. Metrics este fail-open: SQLite blocat, indisponibil sau corupt nu oprește PDF-ul și nu schimbă starea principală din `/health`; diagnosticul separat este în `health.metrics`. Coada în memorie este limitată, iar pierderile controlate apar în `droppedEvents`.

```bash
sudo -u pdf node scripts/init-metrics-db.js --status
sudo -u pdf node scripts/init-metrics-db.js --check
journalctl -u html2pdf.service | grep METRICS
```

Pentru backup manual consistent folosiți API-ul SQLite backup sau `VACUUM INTO`; nu copiați brutal baza activă separat de WAL.

## Postman

Importați:

- `postman/server-pdf.postman_collection.json`
- `postman/server-pdf.local.postman_environment.json`

Selectați environmentul `server-pdf local` și completați local `master_key`. Valorile secrete sunt goale în Git. Folderul `Admin Keys` creează o cheie, o salvează automat în `api_key`, verifică listarea, disable, refuzul accesului PDF, enable și delete.

## Teste

```bash
node --check server.js
node --check key-store.js
node --check metrics-store.js
node --check scripts/init-metrics-db.js
npm test
```

Fișierele Postman și manifestele npm sunt validate ca JSON în suita de teste și de scripturile de instalare/update.
