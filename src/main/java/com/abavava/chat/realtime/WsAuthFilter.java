package com.abavava.chat.realtime;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.contract.UserLookup;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.http.Httpx;
import com.abavava.chat.security.JwtService;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.UUID;

/**
 * Проверка рукопожатия GET /api/v1/ws: токен, существование аккаунта и Origin.
 *
 * <p>Браузерный WebSocket не умеет слать Authorization, поэтому access-токен идёт
 * query-параметром ({@code ?token=}), а заголовок тоже принимается — для
 * мобильных SDK. Токен в URL означает, что соединение можно инициировать со
 * сторонней страницы, поэтому Origin проверяется тем же правилом, что и CORS
 * ({@link Httpx#originAllowed(String, String, java.util.List)}).
 *
 * <p>Отказы отдаются до апгрейда обычным REST-конвертом ошибки
 * ({"error": {"code","message"}}) — клиент обязан обновить токен через
 * /auth/refresh и переподключиться.
 *
 * <p>Путь /api/v1/ws пропускается {@link com.abavava.chat.http.AccessTokenFilter}'ом
 * как публичный: авторизацию рукопожатия целиком выполняет этот фильтр.
 */
public class WsAuthFilter implements Filter {

    private final JwtService jwtService;
    private final UserLookup users;
    private final AbvProperties props;
    private final ObjectMapper mapper;

    public WsAuthFilter(JwtService jwtService, UserLookup users, AbvProperties props, ObjectMapper mapper) {
        this.jwtService = jwtService;
        this.users = users;
        this.props = props;
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

        // 1) Токен: заголовок Authorization либо query-параметр (браузерный WS).
        String token = Httpx.tokenFromRequest(req);
        if (token == null) {
            Httpx.writeError(res, AbvException.unauthorized("token is required"), mapper);
            return;
        }

        // 2) Подпись, срок и тип токена.
        UUID userId;
        try {
            userId = jwtService.verifyAccessToken(token);
        } catch (AbvException e) {
            Httpx.writeError(res, e, mapper);
            return;
        }

        // 3) Аккаунт ещё существует: удалённый пользователь не должен держать
        //    соединение до истечения токена.
        try {
            users.byId(userId);
        } catch (RuntimeException e) {
            Httpx.writeError(res, AbvException.unauthorized("user not found"), mapper);
            return;
        }

        // 4) Origin: пустой — не браузер (мобильные SDK, curl) — доверяем;
        //    иначе список abv.allowed-origins + правило «тот же узел».
        String origin = req.getHeader("Origin");
        if (origin != null && !origin.isBlank()
                && !Httpx.originAllowed(origin, req.getHeader("Host"), props.allowedOriginList())) {
            Httpx.writeError(res, AbvException.forbidden("origin is not allowed"), mapper);
            return;
        }

        chain.doFilter(request, response);
    }
}
