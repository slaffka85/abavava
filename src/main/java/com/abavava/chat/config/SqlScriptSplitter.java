package com.abavava.chat.config;

import java.util.ArrayList;
import java.util.List;

/**
 * Минимально достаточный разбор SQL-скрипта на отдельные statements.
 *
 * <p>Нужен потому, что Spring ScriptUtils не поддерживает PostgreSQL
 * dollar-quoting ($$ ... $$ в телах функций) и режет такие миграции по первому
 * внутреннему ';'. Здесь учитываются:
 * <ul>
 *   <li>строки в одинарных кавычках ('' — экранирование) и E'...' с бэкслэшами;</li>
 *   <li>идентификаторы в двойных кавычках;</li>
 *   <li>строчные (--) и блочные (/* *​/) комментарии;</li>
 *   <li>dollar-quoted строки вида $$...$$ и $tag$...$tag$.</li>
 * </ul>
 */
public final class SqlScriptSplitter {

    private SqlScriptSplitter() {
    }

    public static List<String> split(String script) {
        List<String> statements = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        int i = 0;
        int n = script.length();
        while (i < n) {
            char c = script.charAt(i);
            char next = i + 1 < n ? script.charAt(i + 1) : '\0';

            if (c == '-' && next == '-') {
                int end = script.indexOf('\n', i);
                if (end < 0) {
                    end = n;
                }
                current.append(script, i, end);
                i = end;
                continue;
            }
            if (c == '/' && next == '*') {
                int end = script.indexOf("*/", i + 2);
                if (end < 0) {
                    end = n;
                } else {
                    end += 2;
                }
                current.append(script, i, end);
                i = end;
                continue;
            }
            if (c == '\'') {
                i = consumeQuoted(script, i, '\'', current);
                continue;
            }
            if (c == '"') {
                i = consumeQuoted(script, i, '"', current);
                continue;
            }
            if (c == '$') {
                int dollarEnd = dollarQuoteTagEnd(script, i);
                if (dollarEnd > i) {
                    String tag = script.substring(i, dollarEnd);
                    int close = script.indexOf(tag, dollarEnd);
                    int end = close < 0 ? n : close + tag.length();
                    current.append(script, i, end);
                    i = end;
                    continue;
                }
            }
            if (c == ';') {
                String statement = current.toString().trim();
                if (!statement.isEmpty()) {
                    statements.add(statement);
                }
                current.setLength(0);
                i++;
                continue;
            }
            current.append(c);
            i++;
        }
        String tail = current.toString().trim();
        if (!tail.isEmpty()) {
            statements.add(tail);
        }
        return statements;
    }

    private static int consumeQuoted(String script, int start, char quote, StringBuilder out) {
        out.append(quote);
        int i = start + 1;
        int n = script.length();
        boolean backslash = start > 0 && script.charAt(start - 1) == 'E' && quote == '\'';
        while (i < n) {
            char c = script.charAt(i);
            out.append(c);
            if (backslash && c == '\\' && i + 1 < n) {
                out.append(script.charAt(i + 1));
                i += 2;
                continue;
            }
            if (c == quote) {
                if (i + 1 < n && script.charAt(i + 1) == quote) {
                    out.append(quote);
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i++;
        }
        return n;
    }

    /** Если начиная с позиции start идёт $tag$, вернуть позицию после закрывающего $. */
    private static int dollarQuoteTagEnd(String script, int start) {
        int i = start + 1;
        int n = script.length();
        while (i < n) {
            char c = script.charAt(i);
            if (c == '$') {
                return i + 1;
            }
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
            if (!ok) {
                return -1;
            }
            i++;
        }
        return -1;
    }
}
