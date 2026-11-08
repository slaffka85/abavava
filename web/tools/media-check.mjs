#!/usr/bin/env node
/**
 * media-check.mjs — сквозная проверка того, что приложение chat-abavava РЕАЛЬНО
 * передаёт медиа в звонке 1:1, в настоящем браузере (Chromium) с фейковыми
 * медиаустройствами.
 *
 * Что делает:
 *   1) регистрирует двух пользователей через REST API и создаёт direct-диалог;
 *   2) поднимает два независимых browser context (разные localStorage/профили);
 *   3) кладёт токены (abv.access/abv.refresh) в localStorage до загрузки приложения;
 *   4) A открывает диалог с B и инициирует видеозвонок;
 *   5) B принимает входящий;
 *   6) ждёт состояния connected и снимает ДОКАЗАТЕЛЬСТВА передачи медиа:
 *        - getStats() по каждому RTCPeerConnection (inbound-rtp bytesReceived/
 *          framesDecoded/packetsReceived, outbound-rtp bytesSent, candidate-pair);
 *        - дельты счётчиков между двумя замерами (трафик растёт во времени);
 *        - DOM-независимая проверка <video>: readyState/videoWidth/currentTime;
 *      обе стороны (двусторонность);
 *   7) завершает звонок кнопкой в оверлее, проверяет закрытие оверлея и
 *      появление терминального звонка в GET /api/v1/calls;
 *   8) сохраняет скриншоты и JSON-отчёт в tools/media-check-artifacts/.
 *
 * ВАЖНО: приложение (web/src) и backend не меняются. Доступ к RTCPeerConnection
 * даётся тестовой инъекцией через context.addInitScript (обёртка конструктора),
 * сам код приложения при этом не трогается.
 *
 * Запуск:  node tools/media-check.mjs          (из каталога web/)
 *          npm run media:check
 * Переменные окружения:
 *   ABV_BASE_URL      — базовый URL клиента (по умолчанию http://localhost:8081)
 *   ABV_CHROME_PATH   — путь к chrome.exe/msedge.exe для резервного запуска
 *   ABV_SKIP_SYSTEM_BROWSER=1 — не пробовать системный браузер (только Playwright)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.join(HERE, 'media-check-artifacts');
const PROFILES_DIR = path.join(ARTIFACTS_DIR, 'profiles');

const BASE_URL = (process.env.ABV_BASE_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
const API_URL = `${BASE_URL}/api/v1`;
const ORIGIN = new URL(BASE_URL).origin;

const PASSWORD = 'password123';
const RUN_ID = Date.now().toString(36);

/** Таймауты (мс). */
const T = {
  pageReady: 30_000,
  wsOpen: 30_000,
  callOverlay: 20_000,
  incoming: 40_000,
  connected: 45_000,
  statsSample: 3_000,
  overlayClosed: 25_000,
  global: 300_000,
};

/** Флаги фейковых медиаустройств (требование задачи). */
const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // Только для локального стенда: иначе ICE использует mDNS-имена (.local),
  // которые между двумя отдельными процессами браузера разрешаются ненадёжно.
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

/* ------------------------------------------------------------------ */
/* Логирование и результаты                                           */
/* ------------------------------------------------------------------ */

const results = [];
let stepNo = 0;

function step(title) {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${title}`);
  console.log('-'.repeat(72));
}

function info(message) {
  console.log(`    · ${message}`);
}

function check(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`    [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(condition);
}

function fail(message) {
  results.push({ name: message, passed: false, detail: '' });
  console.log(`    [FAIL] ${message}`);
}

function warn(message) {
  console.log(`    [WARN] ${message}`);
}

/* ------------------------------------------------------------------ */
/* REST API                                                           */
/* ------------------------------------------------------------------ */

async function apiFetch(tokensPath, route, init = {}, token = null) {
  const headers = { Accept: 'application/json', ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${route}`, {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message = parsed?.error?.message ?? String(parsed ?? response.statusText);
    throw new Error(`${tokensPath} → HTTP ${response.status}: ${message}`);
  }
  return parsed;
}

async function registerUser(label) {
  const email = `media-check-${RUN_ID}-${label}@example.com`;
  const body = { email, display_name: `MediaCheck ${label} ${RUN_ID}`, password: PASSWORD };
  const response = await apiFetch(`POST /auth/register (${label})`, '/auth/register', {
    method: 'POST',
    body,
  });
  return {
    label,
    email,
    displayName: body.display_name,
    user: response.user,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
  };
}

async function createDirectConversation(tokenA, peerId) {
  return apiFetch('POST /conversations', '/conversations', {
    method: 'POST',
    body: { kind: 'direct', peer_id: peerId },
  }, tokenA);
}

/* ------------------------------------------------------------------ */
/* Тестовая инъекция в страницу (не меняет код приложения)             */
/* ------------------------------------------------------------------ */

function installProbe() {
  const w = window;
  if (w.__abvProbeInstalled) return;
  w.__abvProbeInstalled = true;
  w.__abvPCs = [];
  w.__abvMediaAcquisitions = [];

  const Original = w.RTCPeerConnection;
  if (typeof Original === 'function') {
    function Wrapped(...args) {
      const pc = new Original(...args);
      try {
        w.__abvPCs.push(pc);
      } catch {
        /* ignore */
      }
      return pc;
    }
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    w.RTCPeerConnection = Wrapped;
  }

  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async function wrappedGetUserMedia(constraints) {
      const stream = await original(constraints);
      try {
        const describe = (track) => ({
          kind: track.kind,
          label: track.label,
          enabled: track.enabled,
          readyState: track.readyState,
          settings: track.getSettings(),
        });
        w.__abvMediaAcquisitions.push({
          constraints: JSON.parse(JSON.stringify(constraints ?? {})),
          audio: stream.getAudioTracks().map(describe),
          video: stream.getVideoTracks().map(describe),
        });
      } catch {
        /* ignore */
      }
      return stream;
    };
  }
}

/** Один замер: все RTCPeerConnection страницы + состояния <video>. */
async function probePage(page) {
  return page.evaluate(async () => {
    const out = { pcCount: 0, connections: [], videos: [], mediaAcquisitions: window.__abvMediaAcquisitions ?? [] };
    const pcs = window.__abvPCs ?? [];
    out.pcCount = pcs.length;
    out.signalingStateSummary = pcs.map((pc) => pc.signalingState);

    for (let index = 0; index < pcs.length; index += 1) {
      const pc = pcs[index];
      const entry = {
        index,
        signalingState: pc.signalingState,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        inbound: {},
        outbound: {},
        remoteInbound: {},
        candidatePair: null,
        path: null,
        transport: null,
        statsError: null,
      };

      let report;
      try {
        report = await pc.getStats();
      } catch (error) {
        entry.statsError = String(error);
        out.connections.push(entry);
        continue;
      }

      const byId = new Map();
      report.forEach((stat) => byId.set(stat.id, stat));

      report.forEach((stat) => {
        if (stat.type === 'inbound-rtp') {
          const kind = stat.kind ?? stat.mediaType ?? 'unknown';
          entry.inbound[kind] = {
            bytesReceived: stat.bytesReceived ?? 0,
            packetsReceived: stat.packetsReceived ?? 0,
            packetsLost: stat.packetsLost ?? 0,
            jitter: stat.jitter ?? null,
            framesDecoded: stat.framesDecoded ?? null,
            framesDropped: stat.framesDropped ?? null,
            frameWidth: stat.frameWidth ?? null,
            frameHeight: stat.frameHeight ?? null,
            audioLevel: stat.audioLevel ?? null,
            totalAudioEnergy: stat.totalAudioEnergy ?? null,
            mimeType: stat.mimeType ?? null,
          };
        } else if (stat.type === 'outbound-rtp') {
          const kind = stat.kind ?? stat.mediaType ?? 'unknown';
          entry.outbound[kind] = {
            bytesSent: stat.bytesSent ?? 0,
            packetsSent: stat.packetsSent ?? 0,
            framesEncoded: stat.framesEncoded ?? null,
            frameWidth: stat.frameWidth ?? null,
            frameHeight: stat.frameHeight ?? null,
            mimeType: stat.mimeType ?? null,
          };
        } else if (stat.type === 'remote-inbound-rtp') {
          const kind = stat.kind ?? stat.mediaType ?? 'unknown';
          entry.remoteInbound[kind] = {
            packetsLost: stat.packetsLost ?? 0,
            roundTripTime: stat.roundTripTime ?? null,
            fractionLost: stat.fractionLost ?? null,
          };
        } else if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
          entry.candidatePair = {
            localCandidateId: stat.localCandidateId,
            remoteCandidateId: stat.remoteCandidateId,
            currentRoundTripTime: stat.currentRoundTripTime ?? null,
            availableOutgoingBitrate: stat.availableOutgoingBitrate ?? null,
            bytesSent: stat.bytesSent ?? null,
            bytesReceived: stat.bytesReceived ?? null,
          };
        } else if (stat.type === 'transport') {
          entry.transport = {
            dtlsState: stat.dtlsState ?? null,
            selectedCandidatePairId: stat.selectedCandidatePairId ?? null,
            bytesSent: stat.bytesSent ?? null,
            bytesReceived: stat.bytesReceived ?? null,
          };
        }
      });

      if (entry.candidatePair) {
        const local = byId.get(entry.candidatePair.localCandidateId) ?? {};
        const remote = byId.get(entry.candidatePair.remoteCandidateId) ?? {};
        entry.path = {
          localType: local.candidateType ?? null,
          localProtocol: local.protocol ?? null,
          localAddress: local.address ?? null,
          localPort: local.port ?? null,
          remoteType: remote.candidateType ?? null,
          remoteProtocol: remote.protocol ?? null,
          remoteAddress: remote.address ?? null,
          remotePort: remote.port ?? null,
        };
      }

      entry.remoteDescriptionTracks = (() => {
        const sdp = pc.remoteDescription?.sdp ?? '';
        return {
          type: pc.remoteDescription?.type ?? null,
          audioLines: (sdp.match(/^m=audio/gm) ?? []).length,
          videoLines: (sdp.match(/^m=video/gm) ?? []).length,
        };
      })();

      out.connections.push(entry);
    }

    out.videos = Array.from(document.querySelectorAll('video')).map((video) => {
      const stream = video.srcObject;
      return {
        className: video.className,
        muted: video.muted,
        paused: video.paused,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        currentTime: video.currentTime,
        hasSrcObject: Boolean(stream),
        srcObjectTracks: stream
          ? stream.getTracks().map((track) => ({ kind: track.kind, label: track.label, readyState: track.readyState, enabled: track.enabled }))
          : [],
      };
    });

    return out;
  });
}

function pickInbound(probe, kind) {
  const merged = { bytesReceived: 0, packetsReceived: 0, framesDecoded: 0, framesDropped: 0, frameWidth: 0, frameHeight: 0, audioLevel: null };
  let found = false;
  for (const connection of probe.connections) {
    const stat = connection.inbound?.[kind];
    if (!stat) continue;
    found = true;
    merged.bytesReceived += stat.bytesReceived ?? 0;
    merged.packetsReceived += stat.packetsReceived ?? 0;
    merged.framesDecoded += stat.framesDecoded ?? 0;
    merged.framesDropped += stat.framesDropped ?? 0;
    merged.frameWidth = Math.max(merged.frameWidth, stat.frameWidth ?? 0);
    merged.frameHeight = Math.max(merged.frameHeight, stat.frameHeight ?? 0);
    if (stat.audioLevel !== null && stat.audioLevel !== undefined) merged.audioLevel = stat.audioLevel;
  }
  merged.found = found;
  return merged;
}

function pickOutbound(probe, kind) {
  const merged = { bytesSent: 0, packetsSent: 0, framesEncoded: 0 };
  let found = false;
  for (const connection of probe.connections) {
    const stat = connection.outbound?.[kind];
    if (!stat) continue;
    found = true;
    merged.bytesSent += stat.bytesSent ?? 0;
    merged.packetsSent += stat.packetsSent ?? 0;
    merged.framesEncoded += stat.framesEncoded ?? 0;
  }
  merged.found = found;
  return merged;
}

/** Удалённое видео: <video> с srcObject и хотя бы одним video-треком, не muted. */
function remoteVideo(probe) {
  return (
    probe.videos.find(
      (video) => video.hasSrcObject && video.srcObjectTracks.some((track) => track.kind === 'video') && !video.muted,
    ) ??
    probe.videos.find((video) => video.className.includes('call-overlay__remote')) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Браузер                                                            */
/* ------------------------------------------------------------------ */

let chromium = null;
async function loadPlaywright() {
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    throw new Error(
      `Playwright не установлен в web/ (${error.message}). Установите: ` +
        `npm install --save-dev playwright && npx playwright install chromium`,
    );
  }
}

function resolveSystemBrowser() {
  const candidates = [
    process.env.ABV_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitForCdp(port, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* порт ещё не слушает */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function readLogTail(logPath, lines = 12) {
  try {
    return fs
      .readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Попытка №1: штатный запуск Playwright (нужен установленный браузер Playwright).
 */
async function openUserViaPlaywright(label) {
  const browser = await chromium.launch({ headless: true, args: FAKE_MEDIA_ARGS });
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
  });
  return {
    mode: 'playwright-launch',
    browser,
    context,
    label,
    close: async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Попытка №2: запустить системный Chromium вручную (spawn со stdio без pipes)
 * и подключиться к нему по CDP. Отдельный процесс + отдельный user-data-dir на
 * каждого пользователя = полностью независимые localStorage и медиаустройства.
 */
async function openUserViaCdp(label, port) {
  const executable = resolveSystemBrowser();
  if (!executable) throw new Error('не найден системный Chromium/Chrome/Edge (задайте ABV_CHROME_PATH)');

  const profileDir = path.join(PROFILES_DIR, `${label}-${RUN_ID}`);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const logPath = path.join(profileDir, 'browser-stderr.log');
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--disable-gpu',
      '--window-size=1280,800',
      ...FAKE_MEDIA_ARGS,
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] },
  );

  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });
  const spawnError = await new Promise((resolve) => {
    child.once('error', resolve);
    setTimeout(() => resolve(null), 1_000);
  });
  fs.closeSync(logFd);
  if (spawnError) {
    throw new Error(`не удалось запустить ${executable}: ${spawnError.code ?? ''} ${spawnError.message}`);
  }

  const version = await waitForCdp(port);
  if (!version) {
    const tail = readLogTail(logPath).join('\n      ');
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw new Error(
      `CDP-эндпоинт не поднялся (exit=${exitCode}). Хвост лога браузера:\n      ${tail || '<пусто>'}`,
    );
  }

  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`);
  const context =
    browser.contexts()[0] ??
    (await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } }));

  try {
    await context.grantPermissions(['camera', 'microphone'], { origin: ORIGIN });
  } catch (error) {
    warn(`grantPermissions недоступен в CDP-режиме (${error.message}); полагаемся на --use-fake-ui-for-media-stream`);
  }

  return {
    mode: `cdp:${path.basename(executable)}`,
    browser,
    context,
    label,
    executable,
    logPath,
    close: async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

async function prepareUser(user, options) {
  const { context } = options;
  const consoleLines = [];

  await context.addInitScript(
    ({ access, refresh, origin }) => {
      try {
        if (location.origin !== origin) return;
        localStorage.setItem('abv.access', access);
        localStorage.setItem('abv.refresh', refresh);
      } catch {
        /* ignore */
      }
    },
    { access: user.accessToken, refresh: user.refreshToken, origin: ORIGIN },
  );
  await context.addInitScript(installProbe);

  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: T.pageReady });
  await page.waitForSelector('.sidebar', { timeout: T.pageReady });
  await page.waitForSelector('.ws-indicator--open', { timeout: T.wsOpen });

  const displayName = await page.locator('.sidebar__name').first().innerText();
  info(`${user.label}: страница загружена, профиль «${displayName}», WebSocket открыт`);

  return { ...user, page, consoleLines };
}

/* ------------------------------------------------------------------ */
/* Pre-flight: убеждаемся, что отдаваемый клиентом бандл — тот самый  */
/* ------------------------------------------------------------------ */

/**
 * Быстрая защита от «устаревшего бандла»: проверяем, что отданный по BASE_URL
 * JS-бандл содержит метки/селекторы, по которым работает сценарий. Никаких
 * файлов приложения это не меняет — только чтение по HTTP.
 */
async function preflightBundle() {
  const needles = ['RTCPeerConnection', 'getUserMedia', 'abv.access', 'abv.refresh', 'Видеозвонок', 'Завершить', 'Входящий звонок', 'call-btn--accept'];
  const html = await (await fetch(`${BASE_URL}/`)).text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  if (!asset) return { ok: false, asset: null, missing: needles, reason: 'в index.html не найден JS-бандл' };
  const url = asset.startsWith('http') ? asset : `${BASE_URL}${asset.startsWith('/') ? '' : '/'}${asset}`;
  const bundle = await (await fetch(url)).text();
  const missing = needles.filter((needle) => !bundle.includes(needle));
  return { ok: missing.length === 0, asset: url, missing, bundleBytes: bundle.length };
}

/* ------------------------------------------------------------------ */
/* Основной сценарий                                                  */
/* ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });

  console.log('='.repeat(72));
  console.log('media-check: передача медиа в звонке 1:1 (реальный браузер)');
  console.log(`Клиент: ${BASE_URL}   API: ${API_URL}   Артефакты: ${ARTIFACTS_DIR}`);
  console.log('='.repeat(72));

  await loadPlaywright();

  step('Pre-flight: отдаваемый клиентом бандл содержит код звонка и ожидаемые метки');
  const preflight = await preflightBundle();
  info(`asset: ${preflight.asset} (${preflight.bundleBytes ?? 0} байт)`);
  check(
    'в production-бандле есть WebRTC-код и все селекторы сценария',
    preflight.ok,
    preflight.ok ? 'RTCPeerConnection/getUserMedia/aria-метки/localStorage-ключи найдены' : `не найдено: ${preflight.missing.join(', ')}`,
  );

  /* 1. Пользователи и диалог */
  step('Регистрация двух пользователей и создание direct-диалога (REST API)');
  const userA = await registerUser('A');
  const userB = await registerUser('B');
  info(`A: ${userA.email} (id=${userA.user.id})`);
  info(`B: ${userB.email} (id=${userB.user.id})`);
  const conversation = await createDirectConversation(userA.accessToken, userB.user.id);
  check('caller/callee зарегистрированы', Boolean(userA.user.id && userB.user.id));
  check(
    'direct-диалог создан',
    conversation?.conversation?.kind === 'direct',
    `conversation_id=${conversation?.conversation?.id}`,
  );

  /* 2. Два независимых браузера/контекста */
  step('Запуск двух независимых браузерных контекстов с фейковыми медиаустройствами');
  info(`Флаги: ${FAKE_MEDIA_ARGS.join(' ')}`);
  const browsers = [];
  const notes = [];
  let handles = null;
  let launchError = null;
  try {
    const first = await openUserViaPlaywright('A');
    browsers.push(first);
    const second = await openUserViaPlaywright('B');
    browsers.push(second);
    handles = [first, second];
    info('Режим: штатный chromium.launch() Playwright');
  } catch (error) {
    notes.push(`chromium.launch() недоступен: ${error.message.split('\n')[0]}`);
    warn(`штатный запуск Playwright не удался: ${error.message.split('\n')[0]}`);
    // закрываем всё, что успело подняться, иначе процессы останутся висеть
    for (const handle of browsers.splice(0)) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    warn('пробуем резервный режим: системный Chromium + connectOverCDP');
    try {
      const a = await openUserViaCdp('A', 9411);
      const b = await openUserViaCdp('B', 9412);
      handles = [a, b];
      browsers.push(a, b);
      info(`Режим: ${a.mode}`);
    } catch (cdpError) {
      launchError = cdpError;
    }
  }

  if (!handles) {
    console.log('\n' + '='.repeat(72));
    console.log('БЛОКЕР ОКРУЖЕНИЯ: не удалось запустить ни один браузер.');
    console.log('='.repeat(72));
    for (const note of notes) console.log(`  · ${note}`);
    console.log(`  · ${launchError ? launchError.message : 'причина неизвестна'}`);
    console.log('\nМедиа НЕ проверено — ни один шаг с браузером не выполнялся.');
    const report = {
      status: 'blocked',
      reason: 'browser-launch-failed',
      baseUrl: BASE_URL,
      notes,
      error: launchError ? String(launchError.message) : 'unknown',
      steps: results,
      generatedAt: new Date().toISOString(),
    };
    const reportPath = path.join(ARTIFACTS_DIR, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Отчёт: ${reportPath}`);
    process.exitCode = 1;
    return;
  }

  let pageA;
  let pageB;
  try {
    step('Подготовка страниц: токены в localStorage, загрузка приложения, WS');
    const readyA = await prepareUser(userA, handles[0]);
    const readyB = await prepareUser(userB, handles[1]);
    pageA = readyA.page;
    pageB = readyB.page;
    check('обе страницы авторизованы (sidebar отрисован)', true);
    check('WebSocket подключён у обоих', true, '.ws-indicator--open');

    /* 3. Видеозвонок */
    step('A открывает диалог и инициирует ВИДЕОзвонок');
    await pageA.locator('.conv', { hasText: userB.displayName }).first().click();
    await pageA.waitForSelector('button[aria-label="Видеозвонок"]', { timeout: 15_000 });
    info('диалог открыт, кнопка «Видеозвонок» найдена (aria-label="Видеозвонок")');
    await pageA.click('button[aria-label="Видеозвонок"]');
    await pageA.waitForSelector('.call-overlay', { timeout: T.callOverlay });
    // В фазе outgoing CallOverlay показывает «Вызываем…» в .call-overlay__timer.
    await pageA.locator('.call-overlay__timer', { hasText: 'Вызываем' }).first().waitFor({ timeout: T.callOverlay });
    check('A: оверлей звонка открылся, статус «Вызываем…»', true);

    step('B принимает входящий звонок');
    await pageB.waitForSelector('[aria-label="Входящий звонок"]', { timeout: T.incoming });
    info('B: модалка «Входящий звонок» появилась');
    const incomingKind = await pageB.locator('.call-modal__kind').first().innerText();
    check('B: входящий звонок помечен как видеозвонок', /видео/i.test(incomingKind), `kind="${incomingKind.trim()}"`);
    await pageB.click('button.call-btn--accept');
    check('B: нажата кнопка «Принять»', true);

    step('Ожидание активного соединения (WebRTC connected)');
    await pageA.locator('.call-overlay__state', { hasText: 'Соединение установлено' }).waitFor({ timeout: T.connected });
    await pageB.locator('.call-overlay__state', { hasText: 'Соединение установлено' }).waitFor({ timeout: T.connected });
    const timerA = await pageA.locator('.call-overlay__timer').first().innerText();
    const timerB = await pageB.locator('.call-overlay__timer').first().innerText();
    check('оба клиента сообщают «Соединение установлено»', true, `таймеры: A=${timerA} B=${timerB}`);

    /* 4. Доказательства медиа */
    step('Замер №1 статистики WebRTC и состояния <video>');
    const probeA1 = await probePage(pageA);
    const probeB1 = await probePage(pageB);
    describeProbe('A', probeA1);
    describeProbe('B', probeB1);

    info(`пауза ${T.statsSample} мс для второго замера (проверяем рост счётчиков)`);
    await pageA.waitForTimeout(T.statsSample);
    step('Замер №2 статистики WebRTC (через 3 с)');
    const probeA2 = await probePage(pageA);
    const probeB2 = await probePage(pageB);

    step('Проверки передачи медиа');
    const evidence = {};
    for (const [tag, first, second, name] of [
      ['A', probeA1, probeA2, userB.displayName],
      ['B', probeB1, probeB2, userA.displayName],
    ]) {
      const videoIn1 = pickInbound(first, 'video');
      const videoIn2 = pickInbound(second, 'video');
      const audioIn1 = pickInbound(first, 'audio');
      const audioIn2 = pickInbound(second, 'audio');
      const videoOut = pickOutbound(second, 'video');
      const audioOut = pickOutbound(second, 'audio');
      const remote = remoteVideo(second);

      evidence[tag] = {
        inboundVideoSample1: videoIn1,
        inboundVideoSample2: videoIn2,
        inboundAudioSample1: audioIn1,
        inboundAudioSample2: audioIn2,
        outboundVideo: videoOut,
        outboundAudio: audioOut,
        remoteVideoElement: remote,
        connections: second.connections,
      };

      console.log(`\n    ── участник ${tag} (собеседник: ${name}) ──`);
      check(
        `${tag}: RTCPeerConnection существует (тестовая обёртка)`,
        second.pcCount > 0,
        `pc=${second.pcCount}, connectionState=${second.connections[0]?.connectionState ?? '-'}`,
      );
      check(
        `${tag}: соединение в состоянии connected`,
        second.connections.some((c) => c.connectionState === 'connected'),
        second.connections.map((c) => `ice=${c.iceConnectionState}/${c.connectionState}`).join(', '),
      );
      check(
        `${tag}: входящее ВИДЕО — bytesReceived > 0`,
        videoIn2.bytesReceived > 0,
        `bytesReceived=${videoIn2.bytesReceived} (замер1=${videoIn1.bytesReceived}, Δ=${videoIn2.bytesReceived - videoIn1.bytesReceived})`,
      );
      const framesDelta = (videoIn2.framesDecoded ?? 0) - (videoIn1.framesDecoded ?? 0);
      check(
        `${tag}: входящее ВИДЕО декодируется (framesDecoded растёт)`,
        (videoIn2.framesDecoded ?? 0) > 0 && framesDelta > 0,
        `framesDecoded=${videoIn2.framesDecoded} (Δ=${framesDelta}), ${videoIn2.frameWidth}x${videoIn2.frameHeight}`,
      );
      check(
        `${tag}: входящее АУДИО — bytesReceived > 0`,
        audioIn2.bytesReceived > 0,
        `bytesReceived=${audioIn2.bytesReceived} (Δ=${audioIn2.bytesReceived - audioIn1.bytesReceived}), packets=${audioIn2.packetsReceived}, audioLevel=${audioIn2.audioLevel}`,
      );
      check(
        `${tag}: исходящее ВИДЕО отправляется (bytesSent > 0, framesEncoded > 0)`,
        videoOut.bytesSent > 0 && (videoOut.framesEncoded ?? 0) > 0,
        `bytesSent=${videoOut.bytesSent}, framesEncoded=${videoOut.framesEncoded}`,
      );
      check(
        `${tag}: удалённый <video> реально воспроизводится`,
        Boolean(remote) && remote.readyState >= 2 && remote.videoWidth > 0 && remote.currentTime > 0,
        remote
          ? `readyState=${remote.readyState}, videoWidth=${remote.videoWidth}, videoHeight=${remote.videoHeight}, currentTime=${remote.currentTime.toFixed(2)}`
          : 'удалённый <video> не найден',
      );
    }

    const bidirectionalVideo =
      evidence.A.inboundVideoSample2.bytesReceived > 0 && evidence.B.inboundVideoSample2.bytesReceived > 0;
    check('ДВУСТОРОННОСТЬ: оба участника получают видео собеседника', bidirectionalVideo);
    const pathInfo = evidence.A.connections[0]?.path;
    if (pathInfo) {
      info(
        `ICE-путь A: local=${pathInfo.localType}/${pathInfo.localAddress}:${pathInfo.localPort} → ` +
          `remote=${pathInfo.remoteType}/${pathInfo.remoteAddress}:${pathInfo.remotePort} (${pathInfo.localProtocol})`,
      );
    }

    /* 5. Скриншоты */
    step('Скриншоты обоих участников');
    const shotA = path.join(ARTIFACTS_DIR, `caller-A-${RUN_ID}.png`);
    const shotB = path.join(ARTIFACTS_DIR, `callee-B-${RUN_ID}.png`);
    await pageA.screenshot({ path: shotA });
    await pageB.screenshot({ path: shotB });
    info(shotA);
    info(shotB);
    check('скриншоты сохранены', fs.existsSync(shotA) && fs.existsSync(shotB));

    /* 6. Завершение звонка */
    step('A завершает звонок кнопкой в оверлее');
    await pageA.click('button[aria-label="Завершить"]');
    try {
      await pageA.locator('.call-overlay').waitFor({ state: 'detached', timeout: T.overlayClosed });
      check('A: оверлей звонка закрылся после завершения', true);
    } catch (error) {
      check('A: оверлей звонка закрылся после завершения', false, error.message.split('\n')[0]);
    }
    try {
      await pageB.locator('.call-overlay').waitFor({ state: 'detached', timeout: T.overlayClosed });
      check('B: оверлей закрылся (событие call.updated дошло)', true);
    } catch {
      check('B: оверлей закрылся (событие call.updated дошло)', false, 'оверлей B остался открыт');
    }

    step('История звонков через GET /api/v1/calls');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const historyA = await apiFetch('GET /calls (A)', '/calls?limit=10', {}, userA.accessToken);
    const historyB = await apiFetch('GET /calls (B)', '/calls?limit=10', {}, userB.accessToken);
    const callA = historyA.items.find((item) => item.peer?.id === userB.user.id);
    const callB = historyB.items.find((item) => item.peer?.id === userA.user.id);
    check('A: звонок есть в истории', Boolean(callA), callA ? `id=${callA.id}` : 'не найден');
    check('B: звонок есть в истории', Boolean(callB), callB ? `id=${callB.id}` : 'не найден');
    if (callA) {
      check(
        'A: звонок терминальный (ended/canceled/failed)',
        ['ended', 'canceled', 'failed', 'rejected', 'missed'].includes(callA.status),
        `status=${callA.status}, ended_at=${callA.ended_at}, end_reason=${callA.end_reason}, duration_seconds=${callA.duration_seconds}`,
      );
      check('A: звонок помечен принятым (answered_at заполнен)', Boolean(callA.answered_at), `answered_at=${callA.answered_at}`);
      check('A: kind = video', callA.kind === 'video', `kind=${callA.kind}`);
    }
    if (callB) {
      check(
        'B: звонок терминальный',
        ['ended', 'canceled', 'failed', 'rejected', 'missed'].includes(callB.status),
        `status=${callB.status}, duration_seconds=${callB.duration_seconds}`,
      );
    }

    const report = {
      status: results.every((item) => item.passed) ? 'passed' : 'failed',
      baseUrl: BASE_URL,
      browserMode: handles[0].mode,
      bundleAsset: preflight.asset,
      fakeMediaArgs: FAKE_MEDIA_ARGS,
      users: {
        A: { id: userA.user.id, email: userA.email },
        B: { id: userB.user.id, email: userB.email },
      },
      conversationId: conversation?.conversation?.id ?? null,
      call: callA ? { id: callA.id, status: callA.status, duration_seconds: callA.duration_seconds, end_reason: callA.end_reason } : null,
      evidence,
      screenshots: [shotA, shotB],
      console: { A: readyA.consoleLines, B: readyB.consoleLines },
      steps: results,
      generatedAt: new Date().toISOString(),
    };
    const reportPath = path.join(ARTIFACTS_DIR, `report-${RUN_ID}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    info(`JSON-отчёт: ${reportPath}`);
  } finally {
    for (const handle of browsers) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }

  /* Итог */
  const failed = results.filter((item) => !item.passed);
  console.log('\n' + '='.repeat(72));
  console.log(`ИТОГ: проверок ${results.length}, провалено ${failed.length}`);
  if (failed.length) {
    for (const item of failed) console.log(`  FAIL: ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  } else {
    console.log('Медиа в звонке 1:1 подтверждено: видео и звук идут в обе стороны.');
  }
  console.log('='.repeat(72));
  process.exitCode = failed.length ? 1 : 0;
}

function describeProbe(tag, probe) {
  for (const connection of probe.connections) {
    const inbound = Object.entries(connection.inbound)
      .map(([kind, stat]) => `${kind}(bytes=${stat.bytesReceived}, pkts=${stat.packetsReceived}, frames=${stat.framesDecoded ?? '-'})`)
      .join(' ');
    const outbound = Object.entries(connection.outbound)
      .map(([kind, stat]) => `${kind}(bytes=${stat.bytesSent}, frames=${stat.framesEncoded ?? '-'})`)
      .join(' ');
    info(
      `${tag} pc#${connection.index}: state=${connection.connectionState} ice=${connection.iceConnectionState} ` +
        `remote-sdp(a/v)=${connection.remoteDescriptionTracks.audioLines}/${connection.remoteDescriptionTracks.videoLines} ` +
        `in[${inbound}] out[${outbound}]`,
    );
  }
  for (const video of probe.videos) {
    info(
      `${tag} <video class="${video.className}"> muted=${video.muted} readyState=${video.readyState} ` +
        `${video.videoWidth}x${video.videoHeight} currentTime=${Number(video.currentTime).toFixed(2)} ` +
        `tracks=[${video.srcObjectTracks.map((track) => `${track.kind}:${track.readyState}`).join(',')}]`,
    );
  }
}

/* Глобальный страховочный таймаут, чтобы CI не висел вечно. */
const watchdog = setTimeout(() => {
  console.error(`\n[media-check] ГЛОБАЛЬНЫЙ ТАЙМАУТ ${T.global} мс — тест прерван.`);
  process.exit(1);
}, T.global);
watchdog.unref?.();

main()
  .catch((error) => {
    console.error('\n[media-check] ОШИБКА:', error?.stack ?? error);
    const reportPath = path.join(ARTIFACTS_DIR, 'report.json');
    try {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ status: 'error', error: String(error?.stack ?? error), steps: results, generatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      console.error(`Отчёт: ${reportPath}`);
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
  });
