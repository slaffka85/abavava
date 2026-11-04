package com.abavava.chat.http;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.List;
import java.util.UUID;

/** X-Request-ID: из запроса или новый; прокидывается в ответ. */
public class RequestIdFilter implements Filter {

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest req = (HttpServletRequest) request;
        HttpServletResponse res = (HttpServletResponse) response;
        String id = req.getHeader("X-Request-ID");
        if (id == null || id.isBlank()) {
            id = UUID.randomUUID().toString();
        }
        req.setAttribute(Httpx.REQUEST_ID_ATTRIBUTE, id);
        res.setHeader("X-Request-ID", id);
        chain.doFilter(request, response);
    }
}
