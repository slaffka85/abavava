# Deployment (Java backend)

Production layout for one VPS with Nginx already installed:

- Nginx serves `web/dist` and terminates HTTPS using the certificate already configured on the host.
- Nginx proxies `/api/`, including WebSocket `/api/v1/ws`, to Java on `127.0.0.1:8082`.
- PostgreSQL runs from Compose and is published only on `127.0.0.1:5433`.
- Android connects to the public HTTPS origin (for example `https://chat.example.com`).

## Backend runtime

The backend is compiled for **Java 26** (`pom.xml` sets `maven.compiler.release=26`). Install a Java 26 runtime on the VPS, or build the JAR on a machine with JDK 26 and install Java 26 JRE on the VPS.

Create a server-only environment file with at least:

```dotenv
ABV_ENV=production
ABV_HTTP_ADDR=127.0.0.1:8082
ABV_DATABASE_URL=jdbc:postgresql://127.0.0.1:5433/abavava?sslmode=disable
ABV_DATABASE_USERNAME=abavava
ABV_DATABASE_PASSWORD=REPLACE_WITH_RANDOM_PASSWORD
ABV_JWT_SECRET=REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
ABV_ALLOWED_ORIGINS=https://chat.example.com
ABV_FCM_SERVICE_ACCOUNT_FILE=/etc/abavava/firebase-service-account.json
```

Keep this file and Firebase service-account JSON outside Git and restrict their permissions. Use the same database password for the PostgreSQL container. The Compose file binds the database port to loopback only.

Build and upload `target/abavava-0.1.0-SNAPSHOT.jar`, start PostgreSQL with `docker compose up -d postgres`, then run the JAR under a dedicated `systemd` service account. Set its working directory to the deployment directory so Spring can load its server-side `.env` if that configuration style is used. Configure `systemd` to restart the service after failure and on reboot.

## Nginx

Add these directives inside the existing HTTPS `server` block. Keep your existing certificate and domain configuration. The application needs the original Host header, forwarded HTTPS scheme, and WebSocket upgrade support.

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8082;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

Serve the web build from `web/dist` with SPA fallback (`try_files $uri $uri/ /index.html`). Since browser and API share an origin, leave `VITE_API_BASE` empty in the web build. Rebuild the Android APK with the public HTTPS origin selected in the app.

## Calls and notifications

HTTPS is required for browser/WebView camera and microphone access. WebRTC media is peer-to-peer when possible; configure a TURN server (`ABV_TURN_URL`, `ABV_TURN_USERNAME`, `ABV_TURN_CREDENTIAL`) for clients behind restrictive NATs. Open the TURN server's configured UDP/TCP ports separately from Nginx.

FCM notifications require the server-side Firebase service account file. The Android `google-services.json` is client configuration and belongs to the Android app; the service-account JSON is a private server credential and must never be committed.

## Backups and exposure

Expose only SSH, HTTP/HTTPS, and the explicitly configured TURN ports. Do not expose PostgreSQL or Java's `8082` directly. Back up the PostgreSQL volume regularly and store encrypted copies off the VPS. Verify restoration before relying on the backups.