package com.abavava.chat.http;

import com.abavava.chat.config.AbvProperties;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.List;

/**
 * CORS: origin'ы из abv.allowed-origins плюс правило «тот же узел, что и у
 * запроса» (см. Httpx.originAllowed и docs/ARCHITECTURE.md §4). Max-Age
 * preflight-ответа — из abv.cors.max-age.
 */
public class CorsFilter implements Filter {

    private final List<String> allowedOrigins;
    private final int maxAgeSeconds;

    public CorsFilter(AbvProperties props) {
        this.allowedOrigins = props.allowedOriginList();
        this.maxAgeSeconds = props.cors().maxAge();
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest req = (HttpServletRequest) request;
        HttpServletResponse res = (HttpServletResponse) response;

        String origin = req.getHeader("Origin");
        if (origin != null && !origin.isBlank() && Httpx.originAllowed(origin, req.getHeader("Host"), allowedOrigins)) {
            res.setHeader("Access-Control-Allow-Origin", origin.replaceAll("/+$", ""));
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID");
            res.setHeader("Access-Control-Max-Age", String.valueOf(maxAgeSeconds));
        }
        if ("OPTIONS".equalsIgnoreCase(req.getMethod())) {
            res.setStatus(HttpServletResponse.SC_NO_CONTENT);
            return;
        }
        chain.doFilter(request, response);
    }
}
