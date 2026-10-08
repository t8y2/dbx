package com.dbx.agent.firebird;

import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Explicit, read-only recovery of legacy text stored as Latin-1 byte containers. */
final class LegacyTextDecoder {
    static Charset charsetFromUrl(String url) {
        int query = url.indexOf('?');
        String charset = null;
        if (query >= 0) {
            for (String parameter : url.substring(query + 1).split("[&;]")) {
                String[] pair = parameter.split("=", 2);
                if (URLDecoder.decode(pair[0], StandardCharsets.UTF_8).equalsIgnoreCase("dataCharset")) {
                    charset = pair.length == 2 ? URLDecoder.decode(pair[1], StandardCharsets.UTF_8).trim() : "";
                }
            }
        }
        return charset == null || charset.isEmpty() ? null : Charset.forName(charset);
    }

    static String jdbcUrl(String url) {
        int query = url.indexOf('?');
        if (query < 0) return url;
        java.util.List<String> parameters = new java.util.ArrayList<>();
        boolean removed = false;
        for (String parameter : url.substring(query + 1).split("[&;]")) {
            String key = URLDecoder.decode(parameter.split("=", 2)[0], StandardCharsets.UTF_8);
            if (key.equalsIgnoreCase("dataCharset")) removed = true;
            else if (!parameter.isEmpty()) parameters.add(parameter);
        }
        if (!removed) return url;
        return url.substring(0, query) + (parameters.isEmpty() ? "" : "?" + String.join("&", parameters));
    }

    static String decode(String value, Charset charset) {
        if (value == null || charset == null) return value;
        boolean highByte = false;
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            // Never truncate Unicode characters or replacement characters into bytes.
            if (character > 255) return value;
            highByte |= character > 127;
        }
        if (!highByte) return value;
        try {
            return charset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(value.getBytes(StandardCharsets.ISO_8859_1))).toString();
        } catch (CharacterCodingException ignored) {
            return value;
        }
    }
}
