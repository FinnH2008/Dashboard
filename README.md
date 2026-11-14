# Heimserver OS — Dashboard, Dateimanager, App Store & Docker

Ein leichtgewichtiger, Docker-fähiger **CasaOS-Ersatz** speziell für Linux-Medien-Homeserver mit **Fotos, Videos, mehreren Festplatten, Portainer-Stacks und Self-Hosted-Apps**.

## Warum als voller CasaOS-Ersatz (inkl. Portainer-Kompatibilität)?

- **Übersicht & Live-Telemetrie**: CPU (gesamt & pro Kern), Load, Temperaturen, RAM/Cache/Swap und Netzwerk-Durchsatz in Echtzeit per Server-Sent Events (SSE), inklusive Glocken-**Warnungen** bei hoher Auslastung, Hitze oder fast vollen Festplatten und globaler **`Ctrl+K`-Suche**.
- **Portainer-freundliche Docker-Verwaltung (`Docker`)**: Alle bestehenden Portainer-Container und Compose-Stacks werden über `/var/run/docker.sock` automatisch erkannt und mit ihrem **Stack-Badge** (`com.docker.compose.project` / `io.portainer.stack.name`) gruppiert angezeigt. Container lassen sich starten, stoppen, neu starten, bearbeiten (Ports/Env/Volumes), per **1-Klick updaten** (Image neu pullen & neu erstellen), per Live-Logs prüfen oder direkt über das integrierte **Browser-Terminal (WebSocket)** bedienen.
- **Multi-Container Compose Stacks & App Store (`App Store`)**: Installiere einzelne Homeserver-Apps (*Immich*, *Jellyfin*, *Plex*, *PhotoPrism*, *Nextcloud*, *Paperless-ngx*, *FileBrowser*, *Syncthing*, *Duplicati*, *Vaultwarden*, *AdGuard Home*, *Nginx Proxy Manager*, *Uptime Kuma*, *Home Assistant*, *qBittorrent*, *Portainer*) oder komplette **Compose Stacks** (z. B. *Immich + Postgres + Redis*, *Paperless + Tika + Gotenberg*) bzw. eigene `docker-compose.yml`-Stacks.
- **Multi-Disk-Speicherverwaltung (`Festplatten`)**: Alle eingebundenen Festplatten (`df`, `lsblk`, `/proc/diskstats`) inklusive **MergerFS-Pool-Erkennung**, eigener Benennung, Lese-/Schreibraten und SMART-Zustand/Temperaturen. Optional lassen sich ungemountete Blockgeräte über das Dashboard **mounten, unmounten oder formatieren** (`ALLOW_STORAGE_ADMIN=true`).
- **Mediathek-Analyse**: Kategorisiert deine Festplatten nach **Fotos & RAW**, **Videos & Filme**, **Musik** und **Dokumenten/Backups** (mit 5-Minuten-Cache, um HDDs nicht unnötig aufzuwecken).
- **Vollständiger Dateimanager (`Dateien`)**: **Grid- & Listen-Ansicht**, direkte Foto-/Video- (HTTP-Range) und Audio-Vorschau, eingebauter **Text-/Config-Editor**, Mehrfachauswahl für **Kopieren, Verschieben, Umbenennen, ZIP-Download**, Drag-and-Drop-Upload und Archiv-Entpackung.
- **Netzwerkfreigaben (`SMB / Samba`)**: Verwalte Windows-/macOS-Freigaben direkt im Dashboard über den `dperson/samba`-Container.
- **Sicherheit & Host-Steuerung**: Optionaler Passwortschutz (`DASHBOARD_PASSWORD` mit HMAC-Signatur) und optionale Host-Power-Steuerung (Neustart / Herunterfahren mit `ALLOW_HOST_POWER=true`).

---

## Deployment mit Portainer

Da du **Portainer** nutzt, kannst du das Dashboard direkt als Portainer-Stack betreiben:

### Option A (Empfohlen): Portainer -> Stacks -> Repository

1. Öffne in Portainer **Stacks** -> **+ Add stack**.
2. Vergib einen Namen (z. B. `homeserver-dashboard`).
3. Wähle **Build method: Repository**.
4. Trage als Repository URL ein:
   ```text
   https://github.com/FinnH2008/Dashboard.git
   ```
   Compose path: `docker-compose.yml`
5. Passe unter **Environment variables** oder im Repo deine Festplattenpfade an und klicke auf **Deploy the stack**.

### Option B: Portainer -> Stacks -> Web Editor

Wenn du die Compose-Datei direkt in den Portainer **Web Editor** kopierst, kennt Portainer kein lokales `build: .`. Ersetze dort `build: .` einfach durch die Git-Build-URL und nutze idealerweise einen festen Host-Pfad für `/app/data`:

```yaml
services:
  homeserver-dashboard:
    build: https://github.com/FinnH2008/Dashboard.git#main
    container_name: homeserver-dashboard
    restart: unless-stopped
    ports:
      - "3080:3080"
    environment:
      - PORT=3080
      - SERVER_NAME=Mein Homeserver
      - DEMO_MODE=auto
      - MEDIA_PATHS=/mnt/fotos,/mnt/filme,/mnt/serien,/mnt/backup
      - DISK_MOUNTS=/mnt/fotos,/mnt/filme,/mnt/serien,/mnt/backup
      - ALLOW_DOCKER_CONTROL=true
      - ALLOW_FILE_WRITE=true
      - ALLOW_STORAGE_ADMIN=false
      - ALLOW_HOST_POWER=false
      - DASHBOARD_PASSWORD=
      # Optional: Direktverbindung zu Portainer (alternativ unter Einstellungen im Browser eintragen)
      - PORTAINER_URL=https://192.168.178.42:9443
      - PORTAINER_API_KEY=
    volumes:
      - /opt/stacks/homeserver-dashboard/data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /etc/os-release:/host/etc/os-release:ro
      - /etc/hostname:/host/etc/hostname:ro
      # Deine Festplatten:
      # - /mnt/fotos:/mnt/fotos
      # - /mnt/filme:/mnt/filme
```

> **Portainer als Dauerlösung (kein „Limited“-Status):**
> - Hinterlege unter **Einstellungen → Portainer-Anbindung** (oder über `PORTAINER_URL` & `PORTAINER_API_KEY`) deine Portainer-URL und ein API-Token (*Portainer → My account → Access tokens*).
> - Damit siehst du alle **Portainer-Stacks**, kannst sie starten/stoppen, jeden Container per **Portainer ↗**-Link direkt in Portainer öffnen und neue App-Store-Stacks direkt über die Portainer-API deployen.

---

## Von CasaOS umsteigen (ohne Datenverlust)

Alle deine bestehenden CasaOS-Apps laufen bereits als normale Docker-Container. Dieses Dashboard übernimmt sie automatisch über `/var/run/docker.sock`:

1. **Dashboard starten** (via Portainer wie oben beschrieben oder klassisch mit `docker compose up -d --build`).
2. **Im Browser öffnen**:
   ```text
   http://<DEINE-SERVER-IP>:3080
   ```
3. **CasaOS dauerhaft abschalten (sobald alles läuft)**:
   ```bash
   sudo systemctl disable --now casaos
   sudo systemctl disable --now casaos-gateway casaos-app-management casaos-local-storage casaos-user-service
   ```
   *(Deine laufenden Docker-Container, Portainer-Stacks und Dateien auf den Festplatten bleiben dabei vollständig erhalten.)*

---

## Wichtige Umgebungsvariablen

| Variable | Standard | Beschreibung |
| :--- | :--- | :--- |
| `PORT` | `3080` | Web-Port des Dashboards |
| `DEMO_MODE` | `auto` | `auto`, `live` oder `demo` |
| `MEDIA_PATHS` | `/mnt/fotos,...` | Kommagetrennte Pfade für Mediathek & Dateimanager |
| `DISK_MOUNTS` | `/mnt/fotos,...` | Explizite Mountpoints, die immer als Festplatten erscheinen |
| `PORTAINER_URL` | *(leer)* | Optional: Portainer-URL (z. B. `https://192.168.178.42:9443`) |
| `PORTAINER_API_KEY` | *(leer)* | Optional: Portainer Access Token (`ptr_...`) für direkte Stack-API |
| `ALLOW_DOCKER_CONTROL` | `true` | Container steuern, bearbeiten, updaten, Compose Stacks & Terminal |
| `ALLOW_FILE_WRITE` | `true` | Uploads, Text-Editor, Kopieren, Verschieben, Umbenennen & Löschen |
| `ALLOW_STORAGE_ADMIN` | `false` | Mount/Unmount/Format von Festplatten erlauben (erfordert `privileged: true`) |
| `ALLOW_HOST_POWER` | `false` | Host-Neustart & Herunterfahren erlauben (erfordert `privileged: true` + `pid: host`) |
| `DASHBOARD_PASSWORD` | *(leer)* | Optionaler Login-Passwortschutz für die Weboberfläche |

---

## Lokal testen (ohne Docker)

Voraussetzung: Node.js >= 20

```bash
npm start
```