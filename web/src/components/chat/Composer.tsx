import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { UUID } from '../../lib/types';
import { useChatStore } from '../../store/chat';
import { IconSend } from '../Icons';

/** Лимит контракта: текст сообщения ≤ 4000 символов. */
const MAX_LENGTH = 4000;
const COUNTER_VISIBLE_FROM = 3600;
const MAX_TEXTAREA_HEIGHT = 160;

interface ComposerProps {
  conversationId: UUID;
}

export function Composer({ conversationId }: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const noteLocalTyping = useChatStore((state) => state.noteLocalTyping);

  // Черновик не переносим между диалогами.
  useEffect(() => {
    setValue('');
    textareaRef.current?.focus();
  }, [conversationId]);

  // Автовысота textarea.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  const submit = (): void => {
    const text = value.trim();
    if (!text) return;
    void sendMessage(conversationId, text);
    setValue('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return;
    // Enter — отправить, Shift+Enter — перенос строки.
    if (event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const handleChange = (next: string): void => {
    setValue(next);
    if (next.trim().length > 0) noteLocalTyping(conversationId);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        className="composer__input"
        value={value}
        rows={1}
        maxLength={MAX_LENGTH}
        placeholder="Написать сообщение…"
        aria-label="Текст сообщения"
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="composer__side">
        {value.length >= COUNTER_VISIBLE_FROM ? (
          <span className={`composer__counter${value.length >= MAX_LENGTH ? ' composer__counter--limit' : ''}`}>
            {value.length}/{MAX_LENGTH}
          </span>
        ) : null}
        <button
          type="submit"
          className="composer__send"
          disabled={value.trim().length === 0}
          aria-label="Отправить"
          title="Отправить (Enter)"
        >
          <IconSend size={19} />
        </button>
      </div>
    </form>
  );
}
