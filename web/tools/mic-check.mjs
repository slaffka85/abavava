#!/usr/bin/env node
/**
 * Диагностика РЕАЛЬНОГО микрофона на этом компьютере.
 *
 * В отличие от media-check.mjs (он использует фейковые устройства), этот скрипт
 * открывает настоящий Chrome без подмены медиаустройств, перечисляет все
 * устройства ввода и по очереди слушает каждое 3 секунды, измеряя уровень звука.
 *
 * Так сразу видно:
 *   • какие микрофоны вообще есть в системе;
 *   • какое устройство браузер выбрал бы по умолчанию (и слышит ли оно что-то);
 *   • какое устройство реально работает — его и нужно выбрать в звонке.
 *
 * Запуск (стек должен быть поднят, чтобы был защищённый origin localhost):
 *   node tools/mic-check.mjs
 *   ABV_BASE=http://192.168.1.222:8081 node tools/mic-check.mjs
 *
 * Пока идёт замер, говорите в микрофон — молчащий микрофон покажет тишину.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.join(SCRIPT_DIR, 'media-check-artifacts');
const PROFILES_DIR = path.join(ARTIFACTS_DIR, 'profiles');
const BASE = (process.env.ABV_BASE ?? 'http://localhost:8081').replace(/\/$/, '');
/** Сколько слушаем каждое устройство. */
const LISTEN_MS = 5_000;
const RUN_ID = Math.random().toString(36).slice(2, 8);

/** Разрешение на медиа выдаётся автоматически, устройства НЕ подменяются. */
const ARGS = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

const info = (message) => console.log(`  · ${message}`);

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

/**
 * Замер уровня: создаём AudioContext + AnalyserNode и считаем RMS/пик.
 * Отдельная функция — она сериализуется и выполняется внутри страницы.
 */
function measureInPage({ deviceId, listenMs }) {
  return (async () => {
    const constraints = deviceId
      ? { audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
      : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      return { ok: false, error: `${error.name}: ${error.message}` };
    }
    try {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      const context = new Ctor();
      await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      let peak = 0;
      let sumSquares = 0;
      let samples = 0;
      let nonZeroSamples = 0;
      let totalValues = 0;
      const deadline = performance.now() + listenMs;

      while (performance.now() < deadline) {
        analyser.getFloatTimeDomainData(buffer);
        let localPeak = 0;
        let localSum = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const value = buffer[i];
          localSum += value * value;
          const abs = Math.abs(value);
          if (abs > localPeak) localPeak = abs;
          if (value !== 0) nonZeroSamples += 1;
          totalValues += 1;
        }
        peak = Math.max(peak, localPeak);
        sumSquares += localSum / buffer.length;
        samples += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }

      const rms = Math.sqrt(sumSquares / Math.max(1, samples));
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      source.disconnect();
      analyser.disconnect();
      await context.close().catch(() => undefined);

      return {
        ok: true,
        rms,
        peak,
        samples,
        // Все отсчёты ровно нулевые: источник отдаёт цифровую тишину (заглушён
        // или выключен), а не «тихую комнату».
        allZero: totalValues > 0 && nonZeroSamples === 0,
        trackMuted: track?.muted ?? null,
        trackState: track?.readyState ?? '',
        sampleRate: settings.sampleRate ?? null,
        channelCount: settings.channelCount ?? null,
        label: track?.label ?? '',
        measuredDeviceId: settings.deviceId ?? deviceId ?? '',
      };
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
  })();
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    console.error(`Playwright не установлен: ${error.message}`);
    process.exit(1);
  }

  const executable = resolveSystemBrowser();
  if (!executable) {
    console.error('не найден системный Chrome/Chromium/Edge (задайте ABV_CHROME_PATH)');
    process.exit(1);
  }

  console.log(`\nmic-check: диагностика реального микрофона (${executable})`);
  console.log(`origin: ${BASE}\n`);

  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const profileDir = path.join(PROFILES_DIR, `mic-${RUN_ID}`);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const logFd = fs.openSync(path.join(profileDir, 'browser-stderr.log'), 'a');

  const port = 9351;
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
      ...ARGS,
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
    console.error('CDP не поднялся — браузер не запустился');
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`);
  const context =
    browser.contexts()[0] ?? (await browser.newContext({ permissions: ['microphone'], viewport: { width: 900, height: 600 } }));

  const page = context.pages()[0] ?? (await context.newPage());
  // Обращаться к микрофону можно только из защищённого контекста: localhost или https.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const secure = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
  }));
  info(`защищённый контекст: ${secure.isSecureContext}; доступ к медиа: ${secure.hasMediaDevices}`);
  if (!secure.hasMediaDevices) {
    console.error('getUserMedia недоступен — микрофон проверить нельзя (нужен https или localhost)');
    await browser.close();
    process.exit(1);
  }

  // Первый запрос нужен, чтобы браузер раскрыл подписи устройств.
  await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => undefined));

  const devices = await page.evaluate(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((device) => device.kind === 'audioinput').map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Микрофон ${index + 1}`,
      isDefault: device.deviceId === 'default',
    }));
  });

  console.log(`Устройства ввода в системе: ${devices.length}\n`);
  if (devices.length === 0) {
    console.error('Система не отдаёт ни одного микрофона — проверьте подключение и разрешения Windows.');
    await browser.close();
    process.exit(1);
  }

  const results = [];

  /**
   * Замер одного устройства. Перед замером даём отсчёт: без него легко получить
   * «тишину» просто потому, что человек не успел ничего сказать.
   */
  const measureWithCountdown = async (label, deviceId) => {
    process.stdout.write(`  ${label}: приготовьтесь говорить — `);
    for (const step of ['3', '2', '1']) {
      process.stdout.write(`${step}… `);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    process.stdout.write(`ГОВОРИТЕ! (${LISTEN_MS / 1000} с) `);
    const measured = await page.evaluate(measureInPage, { deviceId, listenMs: LISTEN_MS });
    console.log('');
    return measured;
  };

  // Сначала — микрофон по умолчанию: именно его берёт приложение и звонок.
  const defaultMeasured = await measureWithCountdown('МИКРОФОН ПО УМОЛЧАНИЮ', null);
  if (defaultMeasured.ok) {
    info(
      `трек: label="${defaultMeasured.label}" state=${defaultMeasured.trackState} muted=${defaultMeasured.trackMuted} ` +
        `sampleRate=${defaultMeasured.sampleRate} каналов=${defaultMeasured.channelCount}`,
    );
  }

  for (const [index, device] of devices.entries()) {
    const measured = await measureWithCountdown(`[${index + 1}/${devices.length}] ${device.label}`, device.deviceId);
    if (!measured.ok) {
      console.log(`    ОШИБКА: ${measured.error}`);
      results.push({ ...device, failed: true, error: measured.error });
      continue;
    }
    const verdict = measured.allZero
      ? 'ЦИФРОВАЯ ТИШИНА (источник заглушён)'
      : measured.peak < 0.005
        ? 'тишина'
        : measured.peak < 0.05
          ? 'очень тихо'
          : 'есть звук';
    console.log(`    ${verdict} (rms ${measured.rms.toFixed(4)}, пик ${measured.peak.toFixed(4)})`);
    results.push({ ...device, ...measured, verdict });
  }

  console.log('\n' + '='.repeat(78));
  const working = results.filter((item) => item.ok && item.peak >= 0.05);
  const allZero = results.filter((item) => item.ok && item.allZero);
  console.log(`Устройств: ${results.length}; со звуком: ${working.length}; с цифровой тишиной: ${allZero.length}`);
  if (working.length > 0) {
    console.log(`Рабочие микрофоны (выбирайте их в звонке): ${working.map((item) => item.label).join(', ')}`);
  }
  if (defaultMeasured.ok) {
    console.log(
      `Микрофон по умолчанию: rms ${defaultMeasured.rms.toFixed(4)}, пик ${defaultMeasured.peak.toFixed(4)} → ` +
        `${defaultMeasured.allZero ? 'источник отдаёт чистые нули: он заглушён или выключен в Windows' : defaultMeasured.peak < 0.05 ? 'звук почти не идёт' : 'звук идёт'}`,
    );
  }
  console.log('Проверьте также: Панель управления → Звук → Запись (не заглушено ли устройство),');
  console.log('и Параметры → Конфиденциальность → Микрофон (доступ разрешён).');
  console.log('='.repeat(78));

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, `mic-report-${RUN_ID}.json`),
    JSON.stringify({ base: BASE, secure, devices: results, default: defaultMeasured, generatedAt: new Date().toISOString() }, null, 2),
  );

  await browser.close();
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

main().catch((error) => {
  console.error(`\nОШИБКА: ${error.message}`);
  process.exit(1);
});
