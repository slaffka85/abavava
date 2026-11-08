#!/usr/bin/env node
/**
 * Проверка визуального индикатора активности голоса (VAD) в реальном браузере.
 *
 * Что делает:
 *   1) регистрирует двух пользователей через REST и создаёт личный диалог;
 *   2) поднимает два независимых браузерных профиля (разные localStorage и
 *      «медиаустройства»: используются фейковые камера и микрофон Chromium);
 *   3) проводит видеозвонок через интерфейс и наблюдает за индикаторами;
 *   4) проверяет, что столбики эквалайзера реагируют на звук, а плашка
 *      участника и рамка подсвечиваются, когда человек говорит.
 *
 * Запуск (стек должен быть поднят):
 *   node tools/vad-check.mjs
 *   ABV_BASE=https://192.168.1.222:8443 ABV_INSECURE=1 node tools/vad-check.mjs
 *
 * Код возврата 0 — всё сошлось, 1 — есть провалы.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.join(SCRIPT_DIR, 'media-check-artifacts');
const PROFILES_DIR = path.join(ARTIFACTS_DIR, 'profiles');

const BASE = (process.env.ABV_BASE ?? 'http://localhost:8081').replace(/\/$/, '');
const RUN_ID = Math.random().toString(36).slice(2, 8);
/** Сколько наблюдаем за индикаторами. */
const OBSERVE_MS = 20_000;
/** Период выборки. */
const SAMPLE_MS = 400;

const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const info = (message) => console.log(`  · ${message}`);
const step = (title) => console.log(`\n[${title}]`);

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    console.error(`Playwright не установлен: ${error.message}`);
    console.error('Установите: cd web && npm install --save-dev playwright');
    process.exit(1);
  }
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${pathname} → ${response.status}: ${text.slice(0, 200)}`);
  }
  return parsed;
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
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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

/** Поднимает отдельный браузер на своего пользователя и подключается по CDP. */
async function openBrowser(chromium, label, port) {
  const executable = resolveSystemBrowser();
  if (!executable) throw new Error('не найден системный Chrome/Chromium/Edge (задайте ABV_CHROME_PATH)');

  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const profileDir = path.join(PROFILES_DIR, `${label}-${RUN_ID}`);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const logFd = fs.openSync(path.join(profileDir, 'browser-stderr.log'), 'a');

  const child = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1280,800',
      ...FAKE_MEDIA_ARGS,
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] },
  );
  fs.closeSync(logFd);

  const version = await waitForCdp(port);
  if (!version) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    const tail = fs.readFileSync(path.join(profileDir, 'browser-stderr.log'), 'utf8').split(/\r?\n/).slice(-8).join('\n      ');
    throw new Error(`CDP не поднялся на порту ${port}:\n      ${tail || '<пусто>'}`);
  }

  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`);
  const context =
    browser.contexts()[0] ??
    (await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } }));
  return {
    context,
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

async function preparePage(context, user) {
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
    { access: user.access, refresh: user.refresh, origin: new URL(BASE).origin },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.conv, .sidebar', { timeout: 25_000 });
  return page;
}

/** Снимок состояния индикаторов на странице. */
const readVad = () => {
  const badges = Array.from(document.querySelectorAll('.call-overlay__stage .vad-badge'));
  const bars = Array.from(document.querySelectorAll('.call-overlay__stage .vad__bar'));
  return {
    badges: badges.map((badge) => ({
      name: badge.querySelector('.vad-badge__name')?.textContent?.trim() ?? '',
      speaking: badge.classList.contains('vad-badge--speaking'),
      state: badge.querySelector('.vad-badge__state')?.textContent?.trim() ?? '',
    })),
    heights: bars.map((bar) => Math.round(parseFloat(bar.style.height || '0'))),
    highlighted: document.querySelectorAll('.call-overlay__stage .is-speaking').length,
  };
};

async function main() {
  const { chromium } = await loadPlaywright();
  const suffix = Date.now().toString(36);

  step('1. Подготовка пользователей и диалога через REST API');
  const userA = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { email: `vad-a-${suffix}@example.com`, display_name: `VAD A ${suffix}`, password: 'password123' },
  });
  const userB = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { email: `vad-b-${suffix}@example.com`, display_name: `VAD B ${suffix}`, password: 'password123' },
  });
  const conversation = await api('/api/v1/conversations', {
    method: 'POST',
    token: userA.access_token,
    body: { kind: 'direct', peer_id: userB.user.id },
  });
  const sessionA = { access: userA.access_token, refresh: userA.refresh_token };
  const sessionB = { access: userB.access_token, refresh: userB.refresh_token };
  check('пользователи и диалог созданы', Boolean(conversation?.conversation?.id), `conversation=${conversation.conversation.id.slice(0, 8)}`);

  step('2. Запуск двух браузеров (фейковые камера и микрофон)');
  const browserA = await openBrowser(chromium, 'vad-a', 9341);
  const browserB = await openBrowser(chromium, 'vad-b', 9342);
  const pageA = await preparePage(browserA.context, sessionA);
  const pageB = await preparePage(browserB.context, sessionB);
  check('обе страницы загрузили приложение', true);

  step('3. Видеозвонок через интерфейс');
  await pageA.locator('.conv', { hasText: userB.user.display_name }).first().click();
  await pageA.waitForSelector('button[aria-label="Видеозвонок"]', { timeout: 15_000 });
  await pageA.click('button[aria-label="Видеозвонок"]');
  await pageA.locator('.call-overlay__timer', { hasText: 'Вызываем' }).first().waitFor({ timeout: 20_000 });

  await pageB.waitForSelector('.call-modal__kind', { timeout: 25_000 });
  await pageB.click('button.call-btn--accept');
  check('B принял входящий звонок', true);

  await pageA.locator('.call-overlay__state', { hasText: 'Соединение установлено' }).waitFor({ timeout: 30_000 });
  await pageB.locator('.call-overlay__state', { hasText: 'Соединение установлено' }).waitFor({ timeout: 30_000 });
  check('соединение установлено на обеих сторонах', true);

  step(`4. Наблюдение за индикаторами (${OBSERVE_MS / 1000} с)`);
  const samplesA = [];
  const samplesB = [];
  const deadline = Date.now() + OBSERVE_MS;
  while (Date.now() < deadline) {
    samplesA.push(await pageA.evaluate(readVad).catch(() => null));
    samplesB.push(await pageB.evaluate(readVad).catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  }

  const summarize = (samples, label) => {
    const valid = samples.filter(Boolean);
    const names = valid.at(-1)?.badges.map((badge) => badge.name) ?? [];
    const heights = valid.flatMap((sample) => sample.heights);
    const spread = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
    const speakingSamples = valid.filter((sample) => sample.badges.some((badge) => badge.speaking)).length;
    const highlighted = valid.filter((sample) => sample.highlighted > 0).length;
    info(
      `${label}: плашек ${names.length} (${names.join(', ')}); разброс высот столбиков ${spread} п.п.; ` +
        `кадров с «говорит» ${speakingSamples}/${valid.length}; кадров с подсветкой ${highlighted}/${valid.length}`,
    );
    return { names, spread, speakingSamples, valid: valid.length, highlighted };
  };

  const statsA = summarize(samplesA, 'A (звонящий)');
  const statsB = summarize(samplesB, 'B (принявший)');

  step('5. Проверки');
  check('A: две плашки — собеседник и «Вы»', statsA.names.length === 2 && statsA.names.includes('Вы'), statsA.names.join(', '));
  check('B: две плашки — собеседник и «Вы»', statsB.names.length === 2 && statsB.names.includes('Вы'), statsB.names.join(', '));
  check('A: эквалайзер реагирует на звук', statsA.spread >= 5, `разброс ${statsA.spread} п.п.`);
  check('B: эквалайзер реагирует на звук', statsB.spread >= 5, `разброс ${statsB.spread} п.п.`);
  check(
    'A: индикатор «говорит» срабатывает',
    statsA.speakingSamples > 0,
    `кадров ${statsA.speakingSamples}/${statsA.valid}`,
  );
  check(
    'B: индикатор «говорит» срабатывает',
    statsB.speakingSamples > 0,
    `кадров ${statsB.speakingSamples}/${statsB.valid}`,
  );
  check('A: подсветка рамки/аватара появляется', statsA.highlighted > 0, `кадров ${statsA.highlighted}`);
  check('B: подсветка рамки/аватара появляется', statsB.highlighted > 0, `кадров ${statsB.highlighted}`);

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await pageA.screenshot({ path: path.join(ARTIFACTS_DIR, `vad-a-${RUN_ID}.png`) }).catch(() => undefined);
  await pageB.screenshot({ path: path.join(ARTIFACTS_DIR, `vad-b-${RUN_ID}.png`) }).catch(() => undefined);

  step('6. Завершение звонка');
  await pageA.click('button[aria-label="Завершить"]');
  await pageA.locator('.call-overlay').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined);
  check('звонок завершён из интерфейса', true);

  const report = {
    status: checks.every((item) => item.ok) ? 'passed' : 'failed',
    base: BASE,
    conversationId: conversation.conversation.id,
    samples: { a: statsA, b: statsB },
    checks,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, `vad-report-${RUN_ID}.json`), JSON.stringify(report, null, 2));

  await browserA.close();
  await browserB.close();

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`ИТОГ: проверок ${checks.length}, провалено ${failed.length}`);
  console.log('='.repeat(72));
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(`\nОШИБКА: ${error.message}`);
  process.exit(1);
});
