package com.abavava.chat.http;

import com.abavava.chat.domain.AbvException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Единый формат ошибок для всех контроллеров: доменные ошибки — по коду,
 * битый JSON — invalid_request, несуществующий путь — not_found,
 * остальное — 500 internal без деталей.
 */
@RestControllerAdvice
public class ErrorHandler {

    private static final Logger log = LoggerFactory.getLogger(ErrorHandler.class);

    @ExceptionHandler(AbvException.class)
    public ResponseEntity<Httpx.ErrorEnvelope> handleAbv(AbvException e) {
        if (e.code() == AbvException.Code.INTERNAL) {
            log.error("request failed", e.getCause());
        }
        return ResponseEntity.status(e.code().httpStatus()).body(Httpx.envelope(e));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Httpx.ErrorEnvelope> handleUnreadable(HttpMessageNotReadableException e) {
        AbvException err = AbvException.invalid("malformed json");
        return ResponseEntity.status(err.code().httpStatus()).body(Httpx.envelope(err));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Httpx.ErrorEnvelope> handleNoResource(NoResourceFoundException e) {
        AbvException err = AbvException.notFound("no such endpoint: /%s", e.getResourcePath());
        return ResponseEntity.status(err.code().httpStatus()).body(Httpx.envelope(err));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Httpx.ErrorEnvelope> handleOther(Exception e) {
        log.error("unhandled request error", e);
        AbvException err = AbvException.internal(e);
        return ResponseEntity.status(err.code().httpStatus()).body(Httpx.envelope(err));
    }
}
