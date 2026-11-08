#!/usr/bin/env node
/**
 * signaling-check.mjs — ЧАСТИЧНАЯ проверка без браузера: реальный стек
 * (REST + WebSocket) от регистрации до завершения звонка, включая транзит
 * SDP/ICE через `call.signal` в обе стороны.
 *
 * ЧТО ЭТО ДОКАЗЫВАЕТ:
 *   серверная и транспортная часть сценария звонка 1:1 работает: два клиента
 *   получают call.created / call.incoming / call.updated, а payload'ы
 *   offer/answer/candidate реально доезжают от одного участника к другому.
 *
 * ЧТО ЭТО НЕ ДОКАЗЫВАЕТ (и не пытается):
 *   сам факт передачи медиа. Здесь нет RTCPeerConnection, нет getUserMedia и нет
 *   RTP — это проверяет только tools/media-check.mjs в настоящем браузере.
 *   Результат этого скрипта НЕЛЬЗЯ выдавать за подтверждение медиа.
 *
 * Запуск: node tools/signaling-check.mjs   (или npm run signaling:check)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.join(HERE, 'media-check-artifacts');
const BASE_URL = (process.env.ABV_BASE_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
const API_URL = `${BASE_URL}/api/v1`;
const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/api/v1/ws`;
const PASSWORD = 'password123';
const RUN_ID = Date.now().toString(36);

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
  console.log(`    [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(condition);
}

async function api(route, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) throw new Error(`${method} ${route} → HTTP ${response.status}: ${parsed?.error?.message ?? text}`);
  return parsed;
}

/** Тонкая обёртка над WebSocket: очередь событий + ожидание конкретного типа. */
function connectWs(user) {
  const url = `${WS_URL}?token=${encodeURIComponent(user.accessToken)}`;
  const socket = new WebSocket(url);
  const events = [];
  const waiters = [];

  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    events.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  });

  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`WS error для ${user.label}`)));
    setTimeout(() => reject(new Error(`WS не открылся за 10 с (${user.label})`)), 10_000);
  });

  return {
    user,
    socket,
    events,
    open,
    send(type, data) {
      socket.send(JSON.stringify({ v: 1, type, id: crypto.randomUUID(), ts: new Date().toISOString(), data }));
    },
    waitFor(match, { timeoutMs = 10_000, label = '' } = {}) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`не дождались события ${label || '?'} (${timeoutMs} мс); получено: ${events.map((e) => e.type).join(', ')}`));
        }, timeoutMs);
        waiters.push({ match, resolve, timer });
      });
    },
    close() {
      try {
        socket.close(1000, 'done');
      } catch {
        /* ignore */
      }
    },
  };
}

/** Канонический JSON: порядок ключей не важен (сервер гоняет payload через map). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

async function registerUser(label) {
  const email = `signaling-check-${RUN_ID}-${label}@example.com`;
  const response = await api('/auth/register', {
    method: 'POST',
    body: { email, display_name: `SigCheck ${label} ${RUN_ID}`, password: PASSWORD },
  });
  return { label, email, user: response.user, accessToken: response.access_token };
}

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  console.log('='.repeat(72));
  console.log('signaling-check: транзит сигналинга звонка 1:1 (БЕЗ браузера, БЕЗ медиа)');
  console.log(`API: ${API_URL}   WS: ${WS_URL}`);
  console.log('='.repeat(72));

  step('Пользователи, диалог, два WebSocket-соединения');
  const A = await registerUser('A');
  const B = await registerUser('B');
  await api('/conversations', { method: 'POST', body: { kind: 'direct', peer_id: B.user.id }, token: A.accessToken });
  info(`A: ${A.email} (${A.user.id})`);
  info(`B: ${B.email} (${B.user.id})`);

  const wsA = connectWs(A);
  const wsB = connectWs(B);
  try {
    await Promise.all([wsA.open, wsB.open]);
    const helloA = await wsA.waitFor((f) => f.type === 'hello', { label: 'hello A' });
    const helloB = await wsB.waitFor((f) => f.type === 'hello', { label: 'hello B' });
    check('оба WebSocket подключены, пришёл hello', helloA.data.user_id === A.user.id && helloB.data.user_id === B.user.id,
      `A session=${helloA.data.session_id.slice(0, 8)}…, B session=${helloB.data.session_id.slice(0, 8)}…`);

    step('A создаёт видеозвонок (POST /calls, как это делает startCall в web/src/store/call.ts)');
    const created = await api('/calls', {
      method: 'POST',
      body: { callee_id: B.user.id, kind: 'video', conversation_id: undefined },
      token: A.accessToken,
    });
    const callId = created.call.id;
    info(`call_id=${callId}, kind=${created.call.kind}, status=${created.call.status}`);
    const incoming = await wsB.waitFor((f) => f.type === 'call.incoming' && f.data.call.id === callId, { label: 'call.incoming' });
    check('B получил call.incoming', incoming.data.call.callee_id === B.user.id, `status=${incoming.data.call.status}`);

    step('Транзит SDP/ICE: A → B (offer)');
    const offerPayload = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
    wsA.send('call.signal', { call_id: callId, payload: offerPayload });
    const offerAtB = await wsB.waitFor((f) => f.type === 'call.signal' && f.data.call_id === callId, { label: 'call.signal offer' });
    check('offer доехал до B (payload сохранён)', canonical(offerAtB.data.payload) === canonical(offerPayload),
      `from=${offerAtB.data.from}; получено=${JSON.stringify(offerAtB.data.payload)}`);

    step('B принимает звонок (call.accept) — как кнопка «Принять»');
    wsB.send('call.accept', { call_id: callId });
    const acceptedA = await wsA.waitFor((f) => f.type === 'call.updated' && f.data.call.id === callId && f.data.call.status === 'accepted', { label: 'call.updated accepted (A)' });
    const acceptedB = await wsB.waitFor((f) => f.type === 'call.updated' && f.data.call.id === callId && f.data.call.status === 'accepted', { label: 'call.updated accepted (B)' });
    check('оба участника увидели accepted', true, `A.answered_at=${acceptedA.data.call.answered_at}, B.answered_at=${acceptedB.data.call.answered_at}`);

    step('Транзит SDP/ICE: B → A (answer + два ICE-кандидата)');
    const answerPayload = { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
    wsB.send('call.signal', { call_id: callId, payload: answerPayload });
    const answerAtA = await wsA.waitFor((f) => f.type === 'call.signal' && f.data.payload?.type === 'answer', { label: 'call.signal answer' });
    check('answer доехал до A (payload сохранён)', canonical(answerAtA.data.payload) === canonical(answerPayload),
      `from=${answerAtA.data.from}; получено=${JSON.stringify(answerAtA.data.payload)}`);

    for (const index of [0, 1]) {
      wsB.send('call.signal', {
        call_id: callId,
        payload: {
          type: 'candidate',
          candidate: `candidate:${index} 1 udp 2122260223 192.168.0.${index + 1} 54${index}0 typ host`,
          sdp_mid: '0',
          sdp_mline_index: 0,
        },
      });
    }
    const candidatesAtA = [];
    for (const index of [0, 1]) {
      candidatesAtA.push(
        await wsA.waitFor(
          (f) => f.type === 'call.signal' && f.data.payload?.type === 'candidate' && f.data.payload.candidate.includes(`candidate:${index} `),
          { label: `call.signal candidate #${index}` },
        ),
      );
    }
    check('оба ICE-кандидата доехали до A', candidatesAtA.length === 2, candidatesAtA.map((f) => f.data.payload.candidate).join(' | '));

    step('Ошибочный кадр: неизвестный тип события → error, соединение сохраняется');
    wsA.send('definitely.unknown.event', {});
    const errorFrame = await wsA.waitFor((f) => f.type === 'error', { label: 'error' });
    // В docs/WS-PROTOCOL.md обещан код unsupported_type, но фактическое (и покрытое
    // internal/e2e/ws_test.go) поведение — invalid_request.
    check('сервер ответил error без разрыва соединения', ['unsupported_type', 'invalid_request'].includes(errorFrame.data.code),
      `code=${errorFrame.data.code} (docs обещают unsupported_type)`);
    check('соединение A живо после ошибки', wsA.socket.readyState === 1, `readyState=${wsA.socket.readyState}`);

    step('A завершает звонок (call.end, как кнопка «Завершить»)');
    wsA.send('call.end', { call_id: callId, reason: 'hangup' });
    const endedA = await wsA.waitFor((f) => f.type === 'call.updated' && f.data.call.id === callId && ['ended', 'canceled', 'failed'].includes(f.data.call.status), { label: 'call.updated terminal (A)' });
    const endedB = await wsB.waitFor((f) => f.type === 'call.updated' && f.data.call.id === callId && ['ended', 'canceled', 'failed'].includes(f.data.call.status), { label: 'call.updated terminal (B)' });
    check('оба участника увидели завершение', true,
      `A.status=${endedA.data.call.status}/${endedA.data.call.end_reason}, B.status=${endedB.data.call.status}`);

    step('История звонков (GET /calls) для обоих участников');
    const listA = await api('/calls?limit=10', { token: A.accessToken });
    const listB = await api('/calls?limit=10', { token: B.accessToken });
    const itemA = listA.items.find((item) => item.id === callId);
    const itemB = listB.items.find((item) => item.id === callId);
    check('A: звонок в истории, терминальный, принятый', Boolean(itemA) && itemA.status === 'ended' && Boolean(itemA.answered_at),
      itemA ? `status=${itemA.status}, duration=${itemA.duration_seconds}s, peer=${itemA.peer.display_name}` : 'не найден');
    check('B: звонок в истории, терминальный', Boolean(itemB) && itemB.status === 'ended',
      itemB ? `status=${itemB.status}, duration=${itemB.duration_seconds}s` : 'не найден');

    const report = {
      kind: 'signaling-only (БЕЗ проверки медиа)',
      status: results.every((item) => item.passed) ? 'passed' : 'failed',
      callId,
      users: { A: A.user.id, B: B.user.id },
      wsEventsA: wsA.events.map((f) => f.type),
      wsEventsB: wsB.events.map((f) => f.type),
      steps: results,
      generatedAt: new Date().toISOString(),
    };
    const reportPath = path.join(ARTIFACTS_DIR, `signaling-report-${RUN_ID}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    info(`JSON-отчёт: ${reportPath}`);
  } finally {
    wsA.close();
    wsB.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log('\n' + '='.repeat(72));
  console.log(`ИТОГ (только сигналинг, НЕ медиа): проверок ${results.length}, провалено ${failed.length}`);
  for (const item of failed) console.log(`  FAIL: ${item.name} — ${item.detail}`);
  if (!failed.length) {
    console.log('Серверный путь звонка 1:1 (создание/приём/транзит SDP-ICE/завершение/история) работает.');
    console.log('Передача медиа этим скриптом НЕ проверяется — нужен tools/media-check.mjs в браузере.');
  }
  console.log('='.repeat(72));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('\n[signaling-check] ОШИБКА:', error?.stack ?? error);
  process.exitCode = 1;
});
