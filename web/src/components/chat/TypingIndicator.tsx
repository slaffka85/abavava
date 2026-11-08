/** Индикатор «печатает…» — три точки с CSS-анимацией. */
export function TypingIndicator() {
  return (
    <div className="typing" aria-label="Собеседник печатает">
      <span className="typing__dot" />
      <span className="typing__dot" />
      <span className="typing__dot" />
    </div>
  );
}
