package com.abavava.chat.http;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.domain.AbvException;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Скользящее окно в памяти процесса: защита /auth/* от перебора. Параметры
 * окна — abv.auth-rate-limit (по умолчанию 30 запросов за 60 с, как
 * httpx.RateLimit(30, time.Minute) в Go). При масштабировании заменяется
 * Redis-вариантом без изменения фильтра.
 */
public class AuthRateLimitFilter implements Filter {

    private final Map<String, Deque<Long>> hits = new ConcurrentHashMap<>();
    private final int limit;
    private final long windowSeconds;
    private final ObjectMapper mapper;

    public AuthRateLimitFilter(AbvProperties props, ObjectMapper mapper) {
        this.limit = props.authRateLimit().limit();
        this.windowSeconds = props.authRateLimit().window().getSeconds();
        this.mapper = mapper;
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest req = (HttpServletRequest) request;
        HttpServletResponse res = (HttpServletResponse) response;
        if ("OPTIONS".equalsIgnoreCase(req.getMethod())) {
            chain.doFilter(request, response);
            return;
        }
        String key = Httpx.clientIp(req);
        if (!allow(key)) {
            res.setHeader("Retry-After", Long.toString(windowSeconds));
            Httpx.writeError(res, new AbvException(AbvException.Code.RATE_LIMITED,
                    "too many requests, slow down", null, null), mapper);
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean allow(String key) {
        long now = Instant.now().getEpochSecond();
        long cutoff = now - windowSeconds;
        Deque<Long> window = hits.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && window.peekFirst() <= cutoff) {
                window.pollFirst();
            }
            if (window.size() >= limit) {
                return false;
            }
            window.addLast(now);
            return true;
        }
    }
}
