# Продакшен-деплой Abavava на VPS

Все части приложения работают в Docker Compose: `web` (React и Nginx со
статическими файлами), `api` (Java) и `postgres`. PostgreSQL доступен только
внутри Docker-сети. Frontend опубликован на `127.0.0.1:18080`, API — на
`127.0.0.1:18082`; существующий Nginx на хосте завершает TLS и проксирует
запросы в эти два контейнера.

## Nginx на хосте

Замените `root`/`try_files` в HTTPS-блоке на proxy locations ниже. Сохраните
существующие `listen`, сертификаты и параметры TLS. Пример целиком для указанного
домена:

```nginx
server {
    listen 127.0.0.1:8443 ssl http2;
    server_name abavava.tssv85.com;

    ssl_certificate /etc/nginx/ssl/abavava.tssv85.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/abavava.tssv85.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # REST API и WebSocket идут в Java-контейнер.
    location /api/ {
        proxy_pass http://127.0.0.1:18082;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    # Остальные запросы и SPA-маршруты идут в web-контейнер.
    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name abavava.tssv85.com;

    # Оставьте этот location, если Certbot использует webroot /var/www/html.
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

`proxy_pass` без завершающего `/` сохраняет исходный путь `/api/...`. Это важно
для маршрутов API и WebSocket `/api/v1/ws`. Убедитесь, что внешний TLS-proxy,
если он у вас есть, направляет HTTPS на `127.0.0.1:8443`: этот listener привязан
только к loopback. Если этот Nginx сам принимает публичный HTTPS напрямую,
используйте его фактический `listen` на публичном интерфейсе/порту вместо
`127.0.0.1:8443`.

После запуска контейнеров проверьте и перечитайте конфигурацию:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Подготовьте VPS

1. Установите Docker Engine и Compose plugin. Проверьте `docker compose version`.
2. Создайте deploy-пользователя с доступом к Docker и правом записи в
   `/opt/abavava`. Членство в группе `docker` фактически даёт права root;
   ограничьте SSH-ключ и workflow, которым разрешён деплой.
3. Подготовьте каталог от администратора, заменив `deploy` на имя пользователя:

   ```bash
   install -d -o deploy -g deploy -m 0755 /opt/abavava
   ```

4. С локального клона скопируйте пример и заполните его на VPS:

   ```bash
   scp .env.production.example deploy@<VPS_HOST>:/opt/abavava/.env.production
   ssh deploy@<VPS_HOST>
   chmod 600 /opt/abavava/.env.production
   nano /opt/abavava/.env.production
   ```

   Укажите `ABV_DOMAIN=abavava.tssv85.com`. Сгенерируйте уникальные секреты:

   ```bash
   openssl rand -hex 32
   openssl rand -base64 48
   ```

   Первое значение задайте как `ABV_DATABASE_PASSWORD`, второе как
   `ABV_JWT_SECRET`. Храните заполненный файл только на сервере. Пароль БД
   должен оставаться неизменным после создания volume, если вы отдельно не
   меняете пароль в PostgreSQL.

## GitHub Actions и деплой

В репозитории откройте **Settings → Secrets and variables → Actions → New
repository secret** и добавьте:

| Secret | Значение |
| --- | --- |
| `VPS_HOST` | IP-адрес или SSH hostname сервера |
| `VPS_USER` | deploy-пользователь |
| `VPS_SSH_PRIVATE_KEY` | приватный SSH-ключ deploy-пользователя |
| `VPS_KNOWN_HOSTS` | проверенная строка SSH host key сервера |
| `GHCR_READ_USER` | GitHub username с доступом к пакетам |
| `GHCR_READ_TOKEN` | classic PAT только с `read:packages` |

Установите публичную часть ключа в
`/home/<deploy-user>/.ssh/authorized_keys`. Host key сохраните в
`VPS_KNOWN_HOSTS` после проверки через доверенный административный канал.
Workflow запускается при push в `main` или вручную через **Actions → Build and
deploy to VPS → Run workflow**. Он запускает backend-тесты, собирает два Docker-
образа (`abavava-api` и `abavava-web`), отправляет их в GHCR и обновляет Compose
на VPS. Оба контейнера получают тег commit SHA.

PAT используется VPS для скачивания приватных образов; GitHub Actions публикует
их с `GITHUB_TOKEN`. Настройте срок действия и ротацию PAT.

Проверьте `https://abavava.tssv85.com/` и
`https://abavava.tssv85.com/api/v1/readyz`. Статус контейнеров и логи:

```bash
cd /opt/abavava
docker compose --env-file .env.production --env-file .deploy.env \
  -f compose.prod.yaml ps
docker compose --env-file .env.production --env-file .deploy.env \
  -f compose.prod.yaml logs -f web api postgres
```

## Откат, данные и дополнительные настройки

В `/opt/abavava/.deploy.env` указаны полные теги обоих образов. Для отката
замените их тегами предыдущего commit SHA и выполните:

```bash
docker compose --env-file .env.production --env-file .deploy.env \
  -f compose.prod.yaml pull
docker compose --env-file .env.production --env-file .deploy.env \
  -f compose.prod.yaml up -d
```

Перед откатом проверьте совместимость старого backend с миграциями, уже
применёнными к БД. Регулярно резервируйте volume PostgreSQL `pgdata`, храните
зашифрованные копии вне VPS и проверяйте восстановление.

Android push включается отдельно: смонтируйте серверный Firebase service-account
JSON и задайте `ABV_FCM_SERVICE_ACCOUNT_FILE` для API-сервиса в Compose. Не
путайте его с Android `google-services.json`. Для звонков за строгим NAT задайте
`ABV_TURN_URL`, `ABV_TURN_USERNAME` и `ABV_TURN_CREDENTIAL` в
`.env.production`, затем пересоздайте API-контейнер. PostgreSQL не публикуется;
порты `18080` и `18082` доступны только с loopback.
