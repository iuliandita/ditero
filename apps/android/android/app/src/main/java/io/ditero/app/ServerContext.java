package io.ditero.app;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * One selected Ditero instance. Every authenticated request is built from {@link #url}, so the
 * destination is always the canonical HTTPS origin captured at selection time, never a URL,
 * header or method supplied by JavaScript.
 *
 * Instances are immutable and compared by identity: a retired context is simply replaced, and
 * asynchronous callbacks that captured the old instance can tell they are stale.
 */
final class ServerContext {
    private static final int MAX_ORIGIN = 255;
    private static final String ZERO_SOCKET_PATH = "/sync/v51/connect";
    private static final Pattern HOST = Pattern.compile(
            "^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$");
    private static final Pattern ZERO_PATH = Pattern.compile("^(?:/[A-Za-z0-9._~-]+)*$");

    final String origin;

    private ServerContext(String origin) {
        this.origin = origin;
    }

    /** Parses a user-supplied origin into its canonical form, or throws IllegalArgumentException. */
    static ServerContext parse(String raw) {
        if (raw == null || raw.length() > MAX_ORIGIN) throw new IllegalArgumentException("origin");
        requirePlainAscii(raw);
        if (!raw.regionMatches(true, 0, "https://", 0, 8)) throw new IllegalArgumentException("scheme");
        String rest = raw.substring(8);
        if (rest.endsWith("/")) rest = rest.substring(0, rest.length() - 1);
        if (rest.isEmpty() || rest.indexOf('/') >= 0) throw new IllegalArgumentException("path");
        String[] authority = authority(rest);
        return new ServerContext("https://" + authority[0] + (authority[1].isEmpty() ? "" : ":" + authority[1]));
    }

    /** Absolute URL for a fixed application path such as /api/config. */
    String url(String path) {
        if (path == null || !path.startsWith("/")) throw new IllegalArgumentException("path");
        return origin + path;
    }

    String queryUrl() {
        return url("/api/zero/query");
    }

    String mutateUrl() {
        return url("/api/zero/mutate");
    }

    /** Deterministic storage scope: native:[canonicalOrigin,verifiedUserId]. */
    String scope(String userId) {
        return "native:[\"" + origin + "\",\"" + userId + "\"]";
    }

    /** Characters that could make parsers disagree about the authority are rejected, not interpreted. */
    private static void requirePlainAscii(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= ' ' || c >= 0x7f || c == '\\' || c == '@' || c == '?' || c == '#' || c == '%')
                throw new IllegalArgumentException("character");
        }
    }

    /** Returns {lowercase host, explicit non-default port or ""}. IPv6 literals are refused. */
    private static String[] authority(String value) {
        String host = value;
        String port = "";
        int colon = value.indexOf(':');
        if (colon >= 0) {
            host = value.substring(0, colon);
            port = value.substring(colon + 1);
            if (!port.matches("[1-9][0-9]{0,4}") || Integer.parseInt(port) > 65535)
                throw new IllegalArgumentException("port");
            if (port.equals("443")) port = "";
        }
        host = host.toLowerCase(Locale.ROOT);
        if (!HOST.matcher(host).matches()) throw new IllegalArgumentException("host");
        return new String[] {host, port};
    }

    /**
     * Where Zero sync lives, derived only from the HTTPS metadata the instance publishes at
     * /api/config. The websocket origin, authority and path all come from it.
     */
    static final class ZeroEndpoint {
        final String host;
        final int port;
        // Path of the websocket route, including /sync/v51/connect.
        final String socketPath;
        final String httpsUrl;

        private ZeroEndpoint(String host, int port, String basePath, String httpsUrl) {
            this.host = host;
            this.port = port;
            this.socketPath = basePath + ZERO_SOCKET_PATH;
            this.httpsUrl = httpsUrl;
        }

        static ZeroEndpoint parse(String raw) {
            if (raw == null || raw.length() > MAX_ORIGIN) throw new IllegalArgumentException("zero");
            requirePlainAscii(raw);
            if (!raw.regionMatches(true, 0, "https://", 0, 8)) throw new IllegalArgumentException("zero-scheme");
            String rest = raw.substring(8);
            int slash = rest.indexOf('/');
            String authority = slash < 0 ? rest : rest.substring(0, slash);
            String path = slash < 0 ? "" : rest.substring(slash);
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            if (authority.isEmpty() || !ZERO_PATH.matcher(path).matches() || path.contains("/."))
                throw new IllegalArgumentException("zero-path");
            String[] a = authority(authority);
            int port = a[1].isEmpty() ? 443 : Integer.parseInt(a[1]);
            return new ZeroEndpoint(a[0], port, path,
                    "https://" + a[0] + (a[1].isEmpty() ? "" : ":" + a[1]) + path);
        }

        /** wss://authority/path with the caller's already-validated query appended. */
        String socketUrl(String query) {
            return "wss://" + host + (port == 443 ? "" : ":" + port) + socketPath
                    + (query == null || query.isEmpty() ? "" : "?" + query);
        }
    }
}
