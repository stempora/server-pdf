# HTML2PDF service

Serviciu HTTP care generează PDF-uri A4 din pagini web folosind Puppeteer și Google Chrome.

## Instalare automată

Sunt suportate Debian și Ubuntu. Instalarea automată Google Chrome necesită `amd64`; pe altă arhitectură se poate indica un Chromium deja instalat prin `CHROME_PATH`. Pe un server nou:

```bash
git clone https://github.com/stempora/server-pdf.git
cd server-pdf
sudo ./install.sh
```

Installerul instalează Node.js 22 (dacă versiunea disponibilă este mai veche de 18), Google Chrome, dependențele npm și serviciul systemd `html2pdf`. Aplicația este instalată implicit în `/opt/html2pdf`, iar configurația protejată în `/etc/html2pdf`.

La prima instalare este generată și afișată o cheie API. Cheile sunt păstrate la actualizările ulterioare. O cheie proprie poate fi furnizată astfel:

```bash
sudo API_KEY='cheia-mea' ./install.sh
```

Opțiunile pot fi suprascrise prin variabile de mediu, de exemplu:

```bash
sudo PORT=9000 MAX_CONCURRENT_REQUESTS=10 INSTALL_DIR=/srv/html2pdf ./install.sh
```

## Utilizare

```bash
curl --get 'http://localhost:8214/pdf' \
  --data-urlencode 'url=https://example.com' \
  -H 'X-API-Key: CHEIA_API' \
  --output pagina.pdf
```

Verificarea serviciului nu necesită autentificare:

```bash
curl http://localhost:8214/health
systemctl status html2pdf
journalctl -u html2pdf -f
```

Cheile API pot fi administrate în `/etc/html2pdf/apikeys.json`, ca un array JSON de string-uri. După modificare, serviciul trebuie repornit cu `sudo systemctl restart html2pdf`.

## Actualizare

După `git pull`, rulați din nou `sudo ./install.sh`. Configurația și cheile existente sunt păstrate.
