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
├── logs/
└── postman/
```

Unitatea systemd este `/etc/systemd/system/html2pdf.service`, iar portul implicit este `8214`. Datele aplicației nu sunt stocate în `/opt/html2pdf` sau `/etc/html2pdf`.

## Instalare nouă

`install.sh` este destinat exclusiv serverelor noi. Sunt suportate Debian/Ubuntu și AlmaLinux/Rocky Linux/RHEL 8–9 pe `x86_64`. Installerul detectează distribuția din `/etc/os-release`, folosește `apt` sau `dnf`, instalează Node.js 22 și Google Chrome Stable, creează utilizatorul `pdf`, generează cheile inițiale și pornește serviciul:

```bash
git clone https://github.com/stempora/server-pdf.git
cd server-pdf
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
```

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

`update.sh` actualizează numai o instalare existentă. Nu instalează Node.js sau Chrome, nu creează utilizatori, nu schimbă systemd și nu înlocuiește configurația, cheile sau logurile.

Din checkout-ul Git destinat deploymentului:

```bash
git fetch origin
git switch BRANCH_APROBAT
git pull --ff-only origin BRANCH_APROBAT
git status --short
sudo ./scripts/create-master-key.sh   # numai la prima migrare
sudo ./update.sh
```

Update-ul refuză un checkout Git murdar, validează sursa și JSON-urile înainte de copiere, creează un backup în `/home/pdf/server-backups/TIMESTAMP`, rulează `npm ci --omit=dev` numai când manifestele s-au schimbat, repornește serviciul și verifică `/health`.

## Backup și rollback

Dacă instalarea, restartul sau health check-ul eșuează după începerea copierii, `update.sh` restaurează automat fișierele aplicației și `node_modules` din backup, apoi repornește versiunea anterioară. Backup-ul este păstrat și locația sa este afișată.

Pentru rollback manual, înlocuiți `BACKUP_TIMESTAMP` cu directorul afișat de updater:

```bash
sudo systemctl stop html2pdf
sudo cp -a /home/pdf/server-backups/BACKUP_TIMESTAMP/server.js /home/pdf/server/server.js
sudo cp -a /home/pdf/server-backups/BACKUP_TIMESTAMP/key-store.js /home/pdf/server/key-store.js
sudo cp -a /home/pdf/server-backups/BACKUP_TIMESTAMP/package.json /home/pdf/server/package.json
sudo cp -a /home/pdf/server-backups/BACKUP_TIMESTAMP/package-lock.json /home/pdf/server/package-lock.json
if sudo test -d /home/pdf/server-backups/BACKUP_TIMESTAMP/node_modules; then
  sudo rm -rf /home/pdf/server/node_modules
  sudo cp -a /home/pdf/server-backups/BACKUP_TIMESTAMP/node_modules /home/pdf/server/node_modules
fi
sudo chown -R pdf:pdf /home/pdf/server
sudo systemctl start html2pdf
curl --fail http://127.0.0.1:8214/health
```

Fișierele `environment`, `master-key.json`, `apikeys.json`, `api-key-metadata.json` și `logs/` nu sunt înlocuite de updater.

## Postman

Importați:

- `postman/server-pdf.postman_collection.json`
- `postman/server-pdf.local.postman_environment.json`

Selectați environmentul `server-pdf local` și completați local `master_key`. Valorile secrete sunt goale în Git. Folderul `Admin Keys` creează o cheie, o salvează automat în `api_key`, verifică listarea, disable, refuzul accesului PDF, enable și delete.

## Teste

```bash
node --check server.js
node --check key-store.js
npm test
```

Fișierele Postman și manifestele npm sunt validate ca JSON în suita de teste și de scripturile de instalare/update.
