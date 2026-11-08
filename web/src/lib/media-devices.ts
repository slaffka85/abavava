/**
 * Работа с устройствами ввода звука.
 *
 * Зачем отдельный модуль: на настольных системах почти всегда несколько
 * микрофонов (веб-камера, гарнитура, «Stereo Mix», виртуальные устройства), и
 * браузер по умолчанию выбирает не тот — собеседник ничего не слышит, хотя
 * видео идёт. Поэтому выбранный микрофон запоминаем и даём переключить его
 * прямо во время звонка.
 */

const MIC_STORAGE_KEY = 'abv.micId';

export interface MicDevice {
  deviceId: string;
  label: string;
}

/** Выбранный ранее микрофон (null — системный по умолчанию). */
export function rememberedMicId(): string | null {
  try {
    return localStorage.getItem(MIC_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Запоминает выбор микрофона между звонками. */
export function rememberMicId(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(MIC_STORAGE_KEY, deviceId);
    else localStorage.removeItem(MIC_STORAGE_KEY);
  } catch {
    // приватный режим браузера — просто не запоминаем
  }
}

/**
 * Список микрофонов. Осмысленные подписи браузер отдаёт только после выдачи
 * разрешения на доступ к медиа, поэтому вызывать это нужно после getUserMedia.
 */
export async function listMicrophones(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Микрофон ${index + 1}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Ограничения для getUserMedia с учётом выбранного устройства ввода.
 * Применяем шумоподавление и эхоподавление: для звонка с колонками это важно.
 */
export function audioTrackConstraints(micId: string | null): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (micId) constraints.deviceId = { exact: micId };
  return constraints;
}

/** Выбранный микрофон исчез или система сообщает, что он сейчас занят. */
export function shouldFallbackToDefaultMic(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : '';
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError';
}

/** Подписывается на подключение/отключение устройств. Возвращает функцию отписки. */
export function onDeviceChange(handler: () => void): () => void {
  const media = navigator.mediaDevices;
  if (!media?.addEventListener) return () => undefined;
  media.addEventListener('devicechange', handler);
  return () => media.removeEventListener('devicechange', handler);
}
