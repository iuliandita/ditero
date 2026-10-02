package io.ditero.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.JsonReader;
import android.util.JsonToken;
import android.util.Log;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.IOException;
import java.io.StringReader;
import java.net.Proxy;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Native-only credential transport between the bundled web app and a user-selected HTTPS
 * Ditero instance. The session token, the Zero JWT and the PKCE verifier never leave this
 * class; JavaScript only ever holds an opaque auth handle.
 *
 * The only entry point is one dedicated WebViewCompat message listener. There is no
 * addJavascriptInterface fallback and no Capacitor plugin method for credentials. Every
 * network destination is derived from the captured {@link ServerContext}, never from
 * JavaScript.
 */
final class NativeZeroTransport {
    private static final String TAG = "NativeZeroTransport";
    private static final String LISTENER = "NativeDitero";
    private static final String BUNDLED_ORIGIN = "https://localhost";

    private static final int MAX_CONTROL = 8 * 1024;
    private static final int MAX_SEND = 1024 * 1024;
    private static final int MAX_PROTOCOL = 64 * 1024;
    private static final int MAX_URL = 4096;
    private static final int MAX_BODY = 64 * 1024;
    private static final int MAX_SOCKETS = 4;
    // The handle is as long as the longest JWT this class will accept, so the
    // handshake header only ever shrinks when the real token replaces it. Zero chooses
    // embedded or late initConnection from the handle-sized header.
    private static final int HANDLE_BYTES = 576; // base64url -> 768 chars
    private static final int HANDLE_CHARS = 768;
    private static final int MAX_JWT = HANDLE_CHARS;

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_.:-]{1,128}$");
    private static final Pattern CANONICAL_ID = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern BEARER = Pattern.compile("^[A-Za-z0-9\\-._~+/=]{1,512}$");
    private static final Pattern JWT = Pattern.compile("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$");
    private static final Pattern ISO = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T[0-9:.]{5,16}Z$");
    private static final Pattern PROTOCOL = Pattern.compile("^[A-Za-z0-9%._~!*'()-]+$");
    private static final Pattern RAW_QUERY = Pattern.compile("^[A-Za-z0-9%._~=&+*!-]*$");
    private static final Pattern QUERY_KEY = Pattern.compile("^[A-Za-z0-9_.-]{1,64}$");
    private static final Pattern BASE_COOKIE = Pattern.compile("^(?:[0-9a-z]+(?:\\.[0-9a-z]+)?(?:%3[Aa][0-9a-z]+)?)?$");
    private static final Pattern HEADER_NAME = Pattern.compile("^[A-Za-z0-9-]{1,64}$");
    private static final Pattern FRAME_NAME = Pattern.compile("^[A-Za-z]{1,32}$");
    private static final Pattern CREDENTIAL_NAME =
            Pattern.compile("auth|cookie|token|secret|session|bearer|key|jwt|credential|origin", Pattern.CASE_INSENSITIVE);

    private static final String KEY_ALIAS = "io.ditero.app.native.session.v1";
    private static final String PREFS = "ditero_native_session";
    private static final String PREF_SELECTED = "selected";
    private static final MediaType JSON_TYPE = MediaType.get("application/json; charset=utf-8");

    private static final Set<String> MESSAGE_FIELDS = new HashSet<>(Arrays.asList(
            "op", "rid", "cid", "gen", "id", "body", "origin", "url", "protocol", "data", "code", "reason"));

    /** Named encryption operations; each maps to exactly one fixed handler path. */
    private static final class E2ERoute {
        final boolean post;
        final String path;
        final boolean hasId;
        final Set<String> fields;

        E2ERoute(boolean post, String path, boolean hasId, String... fields) {
            this.post = post;
            this.path = path;
            this.hasId = hasId;
            this.fields = new HashSet<>(Arrays.asList(fields));
        }
    }

    private static final Map<String, E2ERoute> E2E = new HashMap<>();

    static {
        String base = "/api/native/e2e";
        E2E.put("e2e.memberKeys", new E2ERoute(false, base + "/members/{id}/keys", true));
        E2E.put("e2e.workspaceRotate", new E2ERoute(true, base + "/workspaces/{id}/rotate", true,
                "previousVersion", "commitment", "grants"));
        E2E.put("e2e.identity", new E2ERoute(false, base + "/identity", false));
        E2E.put("e2e.enroll", new E2ERoute(true, base + "/enroll", false,
                "publicKey", "passphraseWrapped", "recoveryWrapped", "passphraseSalt", "recoverySalt",
                "formatVersion"));
        E2E.put("e2e.recovery", new E2ERoute(false, base + "/identity/recovery", false));
        E2E.put("e2e.rewrap", new E2ERoute(true, base + "/rewrap", false,
                "passphrase", "recovery", "formatVersion"));
        E2E.put("e2e.identityRotate", new E2ERoute(true, base + "/identity/rotate", false,
                "publicKey", "previousPublicKey", "passphraseWrapped", "recoveryWrapped", "passphraseSalt",
                "recoverySalt", "formatVersion", "rewraps"));
        E2E.put("e2e.provisionPending", new E2ERoute(false, base + "/provision/pending", false));
        E2E.put("e2e.provision", new E2ERoute(true, base + "/provision", false,
                "workspaceId", "recipientPublicKey", "commitment", "enc", "ciphertext"));
        E2E.put("e2e.keysMine", new E2ERoute(false, base + "/keys/mine", false));
        E2E.put("e2e.grantsPending", new E2ERoute(false, base + "/grants/pending", false));
        E2E.put("e2e.grantRequest", new E2ERoute(true, base + "/grants/request", false, "workspaceId"));
        E2E.put("e2e.grantsMine", new E2ERoute(false, base + "/grants/mine", false));
        E2E.put("e2e.grantSubmit", new E2ERoute(true, base + "/grants", false,
                "requestId", "recipientPublicKey", "enc", "ciphertext"));
        E2E.put("e2e.grantFail", new E2ERoute(true, base + "/grants/fail", false, "requestId", "reason"));
    }

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final OkHttpClient http;
    private final OkHttpClient wsHttp;
    private final SharedPreferences prefs;

    // Everything below is touched on the main thread only, except Sock internals.
    private boolean closed;
    private boolean ready;
    // The in-flight grant exchange, by identity: hello, forget and drain null it, so a
    // late callback can neither persist credentials nor clear a newer exchange.
    private Exchange exchange;
    // Session whose remote revocation is in flight, by identity.
    private Session revoking;
    private int generation;
    private JavaScriptReplyProxy page;
    // The selected instance and, once config.read succeeded, where its Zero cache lives.
    private ServerContext context;
    private ServerContext.ZeroEndpoint zero;
    private Session session;
    private String handle;
    private String jwt;
    private long jwtExp;
    private Pending pending;
    private final Map<Integer, Sock> socks = new HashMap<>();

    private static final class Exchange {
        final Pending pending;

        Exchange(Pending pending) {
            this.pending = pending;
        }
    }

    private static final class Session {
        final ServerContext context;
        final String token;
        final String sessionId;
        final String userId;
        final String deviceId;
        final String expiresAt;

        Session(ServerContext context, String token, String sessionId, String userId, String deviceId,
                String expiresAt) {
            this.context = context;
            this.token = token;
            this.sessionId = sessionId;
            this.userId = userId;
            this.deviceId = deviceId;
            this.expiresAt = expiresAt;
        }

        String scope() {
            return context.scope(userId);
        }
    }

    private static final class Pending {
        final ServerContext context;
        final String grantId;
        final String verifier;
        final String expiresAt;

        Pending(ServerContext context, String grantId, String verifier, String expiresAt) {
            this.context = context;
            this.grantId = grantId;
            this.verifier = verifier;
            this.expiresAt = expiresAt;
        }
    }

    private static final class Reject extends Exception {
        Reject(String code) {
            super(code);
        }
    }

    private static final class HttpResult {
        final int code;
        // Null when the response exceeded the body bound.
        final String body;

        HttpResult(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    /** Outcome of the grant exchange plus its identity check, computed off the main thread. */
    private static final class Exchanged {
        String error;
        boolean pending;
        boolean dropGrant;
        Session session;
    }

    private interface Reply {
        JSONObject build(int code, String raw) throws Reject, IOException;
    }

    private NativeZeroTransport(Activity activity) {
        this.activity = activity;
        this.prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // No cookie jar, no logging interceptor, no redirects, no system proxy: the
        // bearer token only ever goes to the selected instance's HTTPS origin.
        this.http = new OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .proxy(Proxy.NO_PROXY)
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .build();
        this.wsHttp = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build();
    }

    /**
     * Registers the dedicated listener after BridgeActivity has initialized its WebView.
     * Fails closed: on any problem nothing is registered and no fallback is installed,
     * so JavaScript simply never sees NativeDitero.
     */
    static NativeZeroTransport attach(BridgeActivity activity) {
        try {
            if (activity.getBridge() == null || activity.getBridge().getWebView() == null)
                throw new IllegalStateException("bridge not initialized");
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
                throw new IllegalStateException("WEB_MESSAGE_LISTENER unsupported");
            final NativeZeroTransport transport = new NativeZeroTransport(activity);
            WebViewCompat.addWebMessageListener(
                    activity.getBridge().getWebView(),
                    LISTENER,
                    Collections.singleton(BUNDLED_ORIGIN),
                    new WebViewCompat.WebMessageListener() {
                        @Override
                        public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message,
                                                  @NonNull Uri sourceOrigin, boolean isMainFrame,
                                                  @NonNull JavaScriptReplyProxy replyProxy) {
                            transport.onPost(message, sourceOrigin, isMainFrame, replyProxy);
                        }
                    });
            return transport;
        } catch (RuntimeException e) {
            Log.e(TAG, "native bridge registration failed closed");
            return null;
        }
    }

    /** Activity shutdown: every socket, request and in-memory credential is dropped. */
    void drain() {
        if (closed) return;
        closed = true;
        ready = false;
        generation++;
        for (Sock s : new ArrayList<>(socks.values())) s.detach();
        socks.clear();
        page = null;
        handle = null;
        jwt = null;
        session = null;
        pending = null;
        exchange = null;
        revoking = null;
        context = null;
        zero = null;
        io.shutdownNow();
        http.dispatcher().cancelAll();
        http.connectionPool().evictAll();
    }

    // ---- listener entry -------------------------------------------------------------

    private static boolean isBundledOrigin(Uri origin) {
        if (origin == null) return false;
        String path = origin.getPath();
        return "https".equals(origin.getScheme())
                && "localhost".equals(origin.getHost())
                && origin.getPort() == -1
                && (path == null || path.isEmpty())
                && origin.getQuery() == null
                && origin.getFragment() == null
                && origin.getUserInfo() == null;
    }

    private void onPost(WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy proxy) {
        if (closed) return;
        if (!isMainFrame || !isBundledOrigin(sourceOrigin)) {
            sendToPage(proxy, obj("t", "reply", "ok", false, "code", "refused-frame"));
            return;
        }
        String data = message.getType() == WebMessageCompat.TYPE_STRING ? message.getData() : null;
        if (data == null || data.length() > MAX_SEND + MAX_CONTROL) {
            sendToPage(proxy, obj("t", "reply", "ok", false, "code", "invalid-message"));
            return;
        }
        int rid = 0;
        Integer cid = null;
        try {
            Object parsed = parse(data);
            if (!(parsed instanceof Map)) throw new Reject("invalid-message");
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) parsed;
            rid = smallInt(m.get("rid"), 0, 0x7fffffff, 0);
            cid = m.containsKey("cid") ? smallInt(m.get("cid"), 1, 0x7fffffff, -1) : null;
            if (cid != null && cid < 0) throw new Reject("invalid-socket");
            String op = m.get("op") instanceof String ? (String) m.get("op") : "";
            boolean socketOp = op.equals("ws.send") || op.equals("ws.open");
            boolean e2eOp = op.startsWith("e2e.");
            if (!socketOp && data.length() > (e2eOp ? MAX_BODY + MAX_CONTROL : MAX_CONTROL))
                throw new Reject("invalid-message");
            if (!MESSAGE_FIELDS.containsAll(m.keySet())) throw new Reject("invalid-message");
            switch (op) {
                case "hello":
                    hello(proxy, rid);
                    return;
                case "state.read":
                    if (!ready || page != proxy) throw new Reject("stale-generation");
                    stateRead(proxy, rid);
                    return;
                case "server.select":
                    requireReady(m);
                    serverSelect(proxy, rid, str(m.get("origin")));
                    return;
                case "config.read":
                    requireReady(m);
                    configRead(proxy, rid);
                    return;
                case "session.read":
                    requireReady(m);
                    sessionRead(proxy, rid);
                    return;
                case "profile.read":
                    requireReady(m);
                    profileRead(proxy, rid);
                    return;
                case "bootstrap.ensure":
                    requireReady(m);
                    bootstrapEnsure(proxy, rid);
                    return;
                case "grant":
                    requireReady(m);
                    grant(proxy, rid);
                    return;
                case "browser":
                    requireReady(m);
                    browser(proxy, rid);
                    return;
                case "complete":
                    requireReady(m);
                    complete(proxy, rid);
                    return;
                case "refresh":
                    requireReady(m);
                    refresh(proxy, rid);
                    return;
                case "session.revoke":
                    requireReady(m);
                    revoke(proxy, rid);
                    return;
                case "forget":
                    requireReady(m);
                    forget(proxy, rid);
                    return;
                case "ws.open":
                    requireReady(m);
                    wsOpen(proxy, rid, cid, m);
                    return;
                case "ws.send":
                    requireReady(m);
                    wsSend(proxy, rid, cid, m);
                    return;
                case "ws.close":
                    requireReady(m);
                    wsClose(proxy, rid, cid, m);
                    return;
                default:
                    if (e2eOp) {
                        requireReady(m);
                        e2e(proxy, rid, op, m);
                        return;
                    }
                    throw new Reject("unknown-op");
            }
        } catch (Reject r) {
            sendToPage(proxy, cid == null
                    ? obj("t", "reply", "rid", rid, "ok", false, "code", r.getMessage())
                    : obj("t", "reply", "rid", rid, "cid", cid, "ok", false, "code", r.getMessage()));
        } catch (IOException e) {
            sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", false, "code", "invalid-message"));
        }
    }

    private void requireReady(Map<String, Object> m) throws Reject {
        if (!ready || smallInt(m.get("gen"), 0, 0x7fffffff, -1) != generation) throw new Reject("stale-generation");
    }

    private void sendToPage(JavaScriptReplyProxy proxy, JSONObject json) {
        try {
            proxy.postMessage(json.toString());
        } catch (RuntimeException e) {
            // The page that owned this proxy is gone.
        }
    }

    private void fail(JavaScriptReplyProxy proxy, int rid, String code) {
        sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", false, "code", code));
    }

    /** A callback outlived the context or generation it started in: only the current page hears. */
    private void cancelled(JavaScriptReplyProxy proxy, int rid) {
        if (page == proxy) fail(proxy, rid, "cancelled");
    }

    private boolean current(int g, ServerContext ctx) {
        return !closed && g == generation && context == ctx;
    }

    // ---- ops ------------------------------------------------------------------------

    private void hello(JavaScriptReplyProxy proxy, int rid) {
        // A new page load invalidates everything bound to the previous generation.
        for (Sock s : new ArrayList<>(socks.values())) s.detach();
        socks.clear();
        generation++;
        page = proxy;
        jwt = null;
        jwtExp = 0;
        pending = null;
        exchange = null;
        zero = null;
        context = restoreSelected();
        session = context == null ? null : restoreSession(context);
        handle = session == null ? null : newHandle();
        ready = true;
        JSONObject reply = obj("t", "reply", "rid", rid, "ok", true, "gen", generation,
                "bridge", "native-zero-2", "authReserve", HANDLE_CHARS, "maxSockets", MAX_SOCKETS);
        put(reply, "server", serverMeta());
        put(reply, "session", sessionMeta());
        sendToPage(proxy, reply);
    }

    /** Reads the current page's authority without retiring sockets or rotating its handle. */
    private void stateRead(JavaScriptReplyProxy proxy, int rid) {
        JSONObject reply = obj("t", "reply", "rid", rid, "ok", true, "gen", generation,
                "exchanging", exchange != null, "revoking", revoking != null,
                "grantPending", pending != null && pending.context == context);
        put(reply, "server", serverMeta());
        put(reply, "session", sessionMeta());
        sendToPage(proxy, reply);
    }

    private JSONObject serverMeta() {
        if (context == null) return null;
        return obj("origin", context.origin, "queryUrl", context.queryUrl(), "mutateUrl", context.mutateUrl());
    }

    private JSONObject sessionMeta() {
        if (session == null || handle == null) return null;
        return obj("scope", session.scope(), "userId", session.userId, "deviceId", session.deviceId,
                "authHandle", handle, "expiresAt", session.expiresAt, "tokenReady", jwt != null,
                "jwtExp", jwtExp);
    }

    /**
     * Selecting a different instance retires the old context: the generation moves on, so
     * every callback that captured the old one is dropped. It is refused while sockets or an
     * exchange could still be bound to it.
     */
    private void serverSelect(JavaScriptReplyProxy proxy, int rid, String raw) {
        if (!socks.isEmpty() || exchange != null || revoking != null) {
            fail(proxy, rid, "busy");
            return;
        }
        ServerContext next;
        try {
            next = ServerContext.parse(raw);
        } catch (IllegalArgumentException e) {
            fail(proxy, rid, "invalid-origin");
            return;
        }
        if (context == null || !context.origin.equals(next.origin)) {
            if (!prefs.edit().putString(PREF_SELECTED, next.origin).commit()) {
                fail(proxy, rid, "storage-failed");
                return;
            }
            generation++;
            context = next;
            zero = null;
            pending = null;
            jwt = null;
            jwtExp = 0;
            session = restoreSession(next);
            handle = session == null ? null : newHandle();
        }
        JSONObject reply = obj("t", "reply", "rid", rid, "ok", true, "gen", generation);
        put(reply, "server", serverMeta());
        put(reply, "session", sessionMeta());
        sendToPage(proxy, reply);
    }

    private void configRead(final JavaScriptReplyProxy proxy, final int rid) {
        final ServerContext ctx = context;
        if (ctx == null) {
            fail(proxy, rid, "no-server");
            return;
        }
        final int g = generation;
        final Request request = new Request.Builder().url(ctx.url("/api/config"))
                .header("Accept", "application/json").get().build();
        dispatch(request, new Done() {
            @Override
            public void run(HttpResult result) {
                if (!current(g, ctx)) {
                    cancelled(proxy, rid);
                    return;
                }
                try {
                    if (result == null) throw new Reject("network");
                    if (result.code != 200) throw new Reject("http-" + result.code);
                    if (result.body == null) throw new Reject("invalid-response");
                    String zeroUrl = str(asMap(parse(result.body)).get("zeroURL"));
                    ServerContext.ZeroEndpoint endpoint;
                    try {
                        endpoint = ServerContext.ZeroEndpoint.parse(zeroUrl);
                    } catch (IllegalArgumentException e) {
                        throw new Reject("invalid-config");
                    }
                    zero = endpoint;
                    sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true, "origin", ctx.origin,
                            "zeroURL", endpoint.httpsUrl, "queryUrl", ctx.queryUrl(),
                            "mutateUrl", ctx.mutateUrl()));
                } catch (Reject | IOException e) {
                    fail(proxy, rid, e instanceof Reject ? e.getMessage() : "invalid-response");
                }
            }
        });
    }

    private void sessionRead(JavaScriptReplyProxy proxy, int rid) {
        authed(proxy, rid, false, "/api/native/session", null, true, new Reply() {
            @Override
            public JSONObject build(int code, String raw) throws Reject, IOException {
                if (code != 200) throw new Reject("http-" + code);
                Map<String, Object> out = asMap(parse(raw));
                if (!session.userId.equals(out.get("userId")) || !session.sessionId.equals(out.get("sessionId"))
                        || !session.deviceId.equals(out.get("deviceId")))
                    throw new Reject("invalid-response");
                String expiresAt = str(out.get("expiresAt"));
                if (expiresAt == null || !ISO.matcher(expiresAt).matches()) throw new Reject("invalid-response");
                return obj("ok", true, "scope", session.scope(), "userId", session.userId,
                        "deviceId", session.deviceId, "expiresAt", expiresAt);
            }
        });
    }

    private void profileRead(JavaScriptReplyProxy proxy, int rid) {
        authed(proxy, rid, false, "/api/native/profile", null, true, new Reply() {
            @Override
            public JSONObject build(int code, String raw) throws Reject, IOException {
                if (code != 200) throw new Reject("http-" + code);
                Map<String, Object> out = asMap(parse(raw));
                String id = str(out.get("id"));
                String name = str(out.get("name"));
                String email = str(out.get("email"));
                if (!session.userId.equals(id) || name == null || name.length() > 512
                        || email == null || email.length() > 512)
                    throw new Reject("invalid-response");
                return obj("ok", true, "id", id, "name", name, "email", email);
            }
        });
    }

    private void bootstrapEnsure(JavaScriptReplyProxy proxy, int rid) {
        authed(proxy, rid, true, "/api/native/bootstrap", "{}", true, new Reply() {
            @Override
            public JSONObject build(int code, String raw) throws Reject, IOException {
                if (code != 200) throw new Reject("http-" + code);
                String workspaceId = str(asMap(parse(raw)).get("workspaceId"));
                if (!validId(workspaceId)) throw new Reject("invalid-response");
                return obj("ok", true, "workspaceId", workspaceId);
            }
        });
    }

    /** The fixed encryption handlers behind the native verifier; the name selects path and method. */
    private void e2e(JavaScriptReplyProxy proxy, int rid, String op, Map<String, Object> m) throws Reject {
        E2ERoute route = E2E.get(op);
        if (route == null) throw new Reject("unknown-op");
        String path = route.path;
        if (route.hasId) {
            String id = str(m.get("id"));
            if (!validId(id) || id.equals(".") || id.equals("..")) throw new Reject("invalid-id");
            path = path.replace("{id}", id);
        } else if (m.containsKey("id")) {
            throw new Reject("invalid-message");
        }
        String body = null;
        if (route.post) {
            Object value = m.get("body");
            if (!(value instanceof Map)) throw new Reject("invalid-body");
            @SuppressWarnings("unchecked")
            Map<String, Object> fields = (Map<String, Object>) value;
            if (!route.fields.containsAll(fields.keySet())) throw new Reject("invalid-body");
            body = new JSONObject(fields).toString();
            if (body.getBytes(StandardCharsets.UTF_8).length > MAX_BODY) throw new Reject("invalid-body");
        } else if (m.containsKey("body")) {
            throw new Reject("invalid-body");
        }
        if (session == null) throw new Reject("no-session");
        authed(proxy, rid, route.post, path, body, false, new Reply() {
            @Override
            public JSONObject build(int code, String raw) {
                boolean parseable = true;
                try {
                    parse(raw);
                } catch (IOException e) {
                    parseable = false;
                }
                // A 2xx without a JSON body is not a usable answer.
                boolean success = code >= 200 && code < 300 && parseable;
                JSONObject out = obj("ok", success, "status", code);
                if (!success) put(out, "code", code >= 200 && code < 300 ? "invalid-response" : "http-" + code);
                if (parseable) put(out, "body", raw);
                return out;
            }
        });
    }

    private void grant(final JavaScriptReplyProxy proxy, final int rid) {
        final ServerContext ctx = context;
        if (ctx == null) {
            fail(proxy, rid, "no-server");
            return;
        }
        if (exchange != null) {
            fail(proxy, rid, "busy");
            return;
        }
        final int g = generation;
        final String verifier = b64url(randomBytes(32));
        final String challenge = b64url(sha256(verifier.getBytes(StandardCharsets.US_ASCII)));
        final String body = obj("challenge", challenge, "deviceLabel", "Ditero Android").toString();
        final Request request = new Request.Builder().url(ctx.url("/api/native/grants"))
                .header("Accept", "application/json")
                .post(RequestBody.create(body, JSON_TYPE)).build();
        dispatch(request, new Done() {
            @Override
            public void run(HttpResult result) {
                if (!current(g, ctx)) {
                    cancelled(proxy, rid);
                    return;
                }
                try {
                    if (result == null) throw new Reject("network");
                    if (result.code != 200) throw new Reject("http-" + result.code);
                    if (result.body == null) throw new Reject("invalid-response");
                    Map<String, Object> out = asMap(parse(result.body));
                    String grantId = str(out.get("grantId"));
                    String expiresAt = str(out.get("expiresAt"));
                    if (grantId == null || !CANONICAL_ID.matcher(grantId).matches()
                            || expiresAt == null || !ISO.matcher(expiresAt).matches())
                        throw new Reject("invalid-response");
                    pending = new Pending(ctx, grantId, verifier, expiresAt);
                    sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true,
                            "authorizeUrl", authorizeUrl(pending), "expiresAt", expiresAt));
                } catch (Reject | IOException e) {
                    fail(proxy, rid, e instanceof Reject ? e.getMessage() : "invalid-response");
                }
            }
        });
    }

    private static String authorizeUrl(Pending p) {
        return p.context.url("/native/authorize?grantId=" + p.grantId);
    }

    /** Opens the pending grant's consent URL in the system browser; JavaScript supplies no URL. */
    private void browser(JavaScriptReplyProxy proxy, int rid) {
        if (pending == null || pending.context != context) {
            fail(proxy, rid, "no-pending-grant");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(authorizeUrl(pending)));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            activity.startActivity(intent);
            sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true));
        } catch (ActivityNotFoundException e) {
            fail(proxy, rid, "no-browser");
        }
    }

    private void complete(final JavaScriptReplyProxy proxy, final int rid) {
        final ServerContext ctx = context;
        final Pending p = pending;
        if (p == null || ctx == null || p.context != ctx) {
            fail(proxy, rid, "no-pending-grant");
            return;
        }
        if (exchange != null || revoking != null) {
            fail(proxy, rid, "busy");
            return;
        }
        final int g = generation;
        final Exchange ex = new Exchange(p);
        exchange = ex;
        final String body = obj("grantId", p.grantId, "verifier", p.verifier).toString();
        io.execute(new Runnable() {
            @Override
            public void run() {
                final Exchanged outcome = exchangeAndVerify(ctx, body);
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (closed) return;
                        if (exchange != ex || g != generation || context != ctx) {
                            // Signed out, retired or replaced meanwhile: nothing may be
                            // persisted or installed.
                            cancelled(proxy, rid);
                            return;
                        }
                        exchange = null;
                        if (outcome.pending) {
                            sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true, "state", "pending"));
                            return;
                        }
                        if (outcome.dropGrant) pending = null;
                        if (outcome.error != null) {
                            fail(proxy, rid, outcome.error);
                            return;
                        }
                        Session next = outcome.session;
                        if (!persistSession(next)) {
                            fail(proxy, rid, "storage-failed");
                            return;
                        }
                        for (Sock s : new ArrayList<>(socks.values())) s.detach(true);
                        socks.clear();
                        session = next;
                        handle = newHandle();
                        jwt = null;
                        jwtExp = 0;
                        pending = null;
                        sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true, "state", "signed-in",
                                "session", sessionMeta()));
                    }
                });
            }
        });
    }

    /**
     * Exchanges the grant, then asks the instance who the new token belongs to. The account
     * that gets persisted is the one the server confirms for that token, not just the one the
     * exchange response claims.
     */
    private Exchanged exchangeAndVerify(ServerContext ctx, String body) {
        Exchanged out = new Exchanged();
        try {
            HttpResult res = call(new Request.Builder().url(ctx.url("/api/native/grants/exchange"))
                    .header("Accept", "application/json")
                    .post(RequestBody.create(body, JSON_TYPE)).build());
            if (res.code == 409) {
                out.pending = true;
                return out;
            }
            if (res.code == 400) out.dropGrant = true;
            if (res.code != 200) throw new Reject("http-" + res.code);
            if (res.body == null) throw new Reject("invalid-response");
            Map<String, Object> m = asMap(parse(res.body));
            String token = str(m.get("token"));
            String sessionId = str(m.get("sessionId"));
            String userId = str(m.get("userId"));
            String deviceId = str(m.get("deviceId"));
            String expiresAt = str(m.get("expiresAt"));
            if (token == null || !BEARER.matcher(token).matches() || !validId(sessionId)
                    || !validId(userId) || !validId(deviceId)
                    || expiresAt == null || !ISO.matcher(expiresAt).matches())
                throw new Reject("invalid-response");
            HttpResult who = call(new Request.Builder().url(ctx.url("/api/native/session"))
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + token).get().build());
            if (who.code != 200 || who.body == null) throw new Reject("verify-failed");
            Map<String, Object> v = asMap(parse(who.body));
            if (!userId.equals(v.get("userId")) || !sessionId.equals(v.get("sessionId"))
                    || !deviceId.equals(v.get("deviceId")))
                throw new Reject("verify-failed");
            out.session = new Session(ctx, token, sessionId, userId, deviceId, expiresAt);
        } catch (Reject e) {
            out.error = e.getMessage();
        } catch (IOException | RuntimeException e) {
            // Plain IOException comes from the strict parser; transport failures are subclasses.
            out.error = e.getClass() == IOException.class ? "invalid-response" : "network";
        }
        return out;
    }

    private void refresh(final JavaScriptReplyProxy proxy, final int rid) {
        authed(proxy, rid, false, "/api/native/token", null, true, new Reply() {
            @Override
            public JSONObject build(int code, String raw) throws Reject, IOException {
                if (code != 200) throw new Reject("http-" + code);
                String token = str(asMap(parse(raw)).get("token"));
                if (token == null || token.length() > MAX_JWT || !JWT.matcher(token).matches())
                    throw new Reject("jwt-rejected");
                jwt = token;
                jwtExp = jwtExpiry(token);
                return obj("ok", true, "refreshedAt", System.currentTimeMillis(), "jwtExp", jwtExp);
            }
        });
    }

    /**
     * Authenticated request to a fixed path of the captured context. Everything the callback
     * needs (context, session, generation) is captured here, so a response that arrives after
     * the account or instance changed can not install anything for the wrong owner.
     */
    private void authed(final JavaScriptReplyProxy proxy, final int rid, boolean post, String path, String body,
                        final boolean clearOnUnauthorized, final Reply reply) {
        final Session s = session;
        final ServerContext ctx = context;
        if (s == null || ctx == null || s.context != ctx) {
            fail(proxy, rid, "no-session");
            return;
        }
        final int g = generation;
        Request.Builder builder = new Request.Builder().url(ctx.url(path))
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + s.token);
        if (post) builder.post(RequestBody.create(body == null ? "{}" : body, JSON_TYPE));
        else builder.get();
        dispatch(builder.build(), new Done() {
            @Override
            public void run(HttpResult result) {
                if (!current(g, ctx) || session != s) {
                    cancelled(proxy, rid);
                    return;
                }
                if (result == null) {
                    fail(proxy, rid, "network");
                    return;
                }
                if (result.code == 401 && clearOnUnauthorized) {
                    dropSession(s);
                    fail(proxy, rid, "unauthorized");
                    return;
                }
                if (result.body == null) {
                    fail(proxy, rid, "invalid-response");
                    return;
                }
                try {
                    JSONObject out = reply.build(result.code, result.body);
                    put(out, "t", "reply");
                    put(out, "rid", rid);
                    sendToPage(proxy, out);
                } catch (Reject | IOException e) {
                    fail(proxy, rid, e instanceof Reject ? e.getMessage() : "invalid-response");
                }
            }
        });
    }

    /**
     * Remote sign-out. Credentials are cleared only after the instance confirms revocation
     * (or says the session is already unusable); any other failure leaves them for a retry.
     */
    private void revoke(final JavaScriptReplyProxy proxy, final int rid) {
        final Session s = session;
        final ServerContext ctx = context;
        if (s == null || ctx == null || s.context != ctx) {
            fail(proxy, rid, "no-session");
            return;
        }
        if (revoking != null || exchange != null) {
            fail(proxy, rid, "busy");
            return;
        }
        final int g = generation;
        revoking = s;
        final Request request = new Request.Builder().url(ctx.url("/api/native/session/revoke"))
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + s.token)
                .post(RequestBody.create("{}", JSON_TYPE)).build();
        dispatch(request, new Done() {
            @Override
            public void run(HttpResult result) {
                if (revoking == s) revoking = null;
                String failure = null;
                boolean remote = false;
                boolean unusable = false;
                if (result == null) {
                    failure = "network";
                } else if (result.code == 401) {
                    unusable = true;
                } else if (result.code != 200 || result.body == null) {
                    failure = result.code != 200 ? "http-" + result.code : "invalid-response";
                } else {
                    try {
                        remote = Boolean.TRUE.equals(asMap(parse(result.body)).get("revoked"));
                    } catch (Reject | IOException e) {
                        remote = false;
                    }
                    if (!remote) failure = "invalid-response";
                }
                if (failure != null) {
                    if (current(g, ctx) && session == s) fail(proxy, rid, failure);
                    else cancelled(proxy, rid);
                    return;
                }
                // Confirmed: the captured namespace goes, whatever page or context is current now.
                boolean cleared = clearPersisted(s);
                boolean live = !closed && sameSession(session, s);
                if (live) dropMemory();
                if (closed || (!live && page != proxy)) return;
                if (!cleared) {
                    sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", false, "code", "storage-failed",
                            "remoteRevoked", remote, "alreadyUnusable", unusable));
                    return;
                }
                sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true, "remoteRevoked", remote,
                        "alreadyUnusable", unusable));
            }
        });
    }

    /** Local sign-out only: drops stored and in-memory credentials, no server revocation. */
    private void forget(JavaScriptReplyProxy proxy, int rid) {
        if (revoking != null) { fail(proxy, rid, "busy"); return; }
        exchange = null;
        revoking = null;
        pending = null;
        Session s = session;
        boolean cleared = s == null || clearPersisted(s);
        dropMemory();
        if (!cleared) {
            fail(proxy, rid, "storage-failed");
            return;
        }
        sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true));
    }

    /** The instance said the token is dead: forget it locally, keep the selected instance. */
    private void dropSession(Session s) {
        clearPersisted(s);
        if (sameSession(session, s)) dropMemory();
    }

    private static boolean sameSession(Session first, Session second) {
        return first != null && second != null && first.scope().equals(second.scope())
                && first.sessionId.equals(second.sessionId);
    }

    private void dropMemory() {
        for (Sock s : new ArrayList<>(socks.values())) s.detach(true);
        socks.clear();
        session = null;
        handle = null;
        jwt = null;
        jwtExp = 0;
    }

    // ---- http -----------------------------------------------------------------------

    private interface Done {
        void run(HttpResult result);
    }

    /** Runs the request off the main thread; the result is null on any transport failure. */
    private void dispatch(final Request request, final Done done) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                HttpResult res = null;
                try {
                    res = call(request);
                } catch (IOException | RuntimeException e) {
                    // reported as network by the callback
                }
                final HttpResult result = res;
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (!closed) done.run(result);
                    }
                });
            }
        });
    }

    private HttpResult call(Request request) throws IOException {
        if (!request.url().isHttps()) throw new IOException("cleartext refused");
        try (Response response = http.newCall(request).execute()) {
            byte[] bytes = response.peekBody(MAX_BODY + 1L).bytes();
            return new HttpResult(response.code(),
                    bytes.length > MAX_BODY ? null : new String(bytes, StandardCharsets.UTF_8));
        }
    }

    // ---- websocket ------------------------------------------------------------------

    private void wsOpen(JavaScriptReplyProxy proxy, int rid, Integer cid, Map<String, Object> m) throws Reject {
        if (cid == null || socks.containsKey(cid) || socks.size() >= MAX_SOCKETS) throw new Reject("invalid-socket");
        if (context == null || zero == null) throw new Reject("no-config");
        if (session == null || handle == null || jwt == null) throw new Reject("no-token");
        String url = str(m.get("url"));
        String protocol = str(m.get("protocol"));
        if (url == null || protocol == null) throw new Reject("invalid-message");
        String target = zeroTarget(url);
        boolean[] embedded = new boolean[1];
        String outProtocol = spliceProtocol(protocol, embedded);
        final Sock sock = new Sock(cid, generation, proxy);
        socks.put(cid, sock);
        Request request = new Request.Builder().url(target)
                .header("Sec-WebSocket-Protocol", outProtocol).build();
        // The page learns the socket was accepted before any event can be queued for it.
        sendToPage(proxy, obj("t", "reply", "rid", rid, "cid", cid, "ok", true,
                "initPath", embedded[0] ? "embedded" : "late"));
        // newWebSocket starts the connection before returning; onOpen may run first.
        WebSocket created = wsHttp.newWebSocket(request, sock);
        boolean cancel;
        synchronized (sock) {
            if (sock.ws == null) sock.ws = created;
            cancel = sock.closeRequested && !sock.opened;
        }
        if (cancel) created.cancel();
    }

    private void wsSend(JavaScriptReplyProxy proxy, int rid, Integer cid, Map<String, Object> m) throws Reject {
        Sock sock = cid == null ? null : socks.get(cid);
        String data = str(m.get("data"));
        if (sock == null || data == null || data.getBytes(StandardCharsets.UTF_8).length > MAX_SEND) throw new Reject("invalid-socket");
        WebSocket ws;
        synchronized (sock) {
            ws = sock.opened && !sock.terminal && !sock.closeRequested ? sock.ws : null;
        }
        if (ws == null) throw new Reject("not-open");
        String out;
        try {
            out = filterFrame(data);
        } catch (Reject r) {
            sock.policyClose();
            throw r;
        }
        if (!ws.send(out)) {
            sock.policyClose();
            throw new Reject("send-failed");
        }
    }

    private void wsClose(JavaScriptReplyProxy proxy, int rid, Integer cid, Map<String, Object> m) throws Reject {
        Sock sock = cid == null ? null : socks.get(cid);
        if (sock == null) throw new Reject("invalid-socket");
        int code = smallInt(m.get("code"), 0, 4999, 1000);
        String reason = m.get("reason") instanceof String ? (String) m.get("reason") : "";
        if (!(code == 1000 || (code >= 3000 && code <= 4999))
                || reason.getBytes(StandardCharsets.UTF_8).length > 123)
            throw new Reject("invalid-close");
        sock.requestClose(code, reason);
    }

    private final class Sock extends WebSocketListener {
        final int cid;
        final int gen;
        final JavaScriptReplyProxy reply;
        WebSocket ws;
        boolean opened;
        boolean terminal;
        boolean detached;
        boolean closeRequested;

        Sock(int cid, int gen, JavaScriptReplyProxy reply) {
            this.cid = cid;
            this.gen = gen;
            this.reply = reply;
        }

        // Caller holds the lock, so posts reach the main queue in event order.
        private void queue(final JSONObject event, final boolean last) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (last && socks.get(cid) == Sock.this) socks.remove(cid);
                    synchronized (Sock.this) {
                        if (detached) return;
                    }
                    if (closed || gen != generation) return;
                    sendToPage(reply, event);
                }
            });
        }

        private JSONObject event(String name) {
            return obj("t", "ws", "gen", gen, "cid", cid, "e", name);
        }

        void detach() {
            detach(false);
        }

        /**
         * Silent for a replaced page (its callbacks stay ignored). For the same page,
         * exactly one terminal event is still delivered: either the one already queued,
         * or a synthetic abnormal close queued here, ahead of nothing else.
         */
        synchronized void detach(boolean notifyPage) {
            if (notifyPage) {
                if (!terminal) {
                    terminal = true;
                    queue(put(put(put(event("close"), "code", 1006), "reason", ""), "clean", false), true);
                }
            } else {
                detached = true;
                terminal = true;
            }
            if (ws != null) ws.cancel();
        }

        void requestClose(int code, String reason) {
            WebSocket target;
            boolean connecting;
            synchronized (this) {
                if (terminal) return;
                closeRequested = true;
                target = ws;
                connecting = !opened;
            }
            if (target == null) return; // wsOpen cancels once newWebSocket returns
            if (connecting) target.cancel();
            else target.close(code, reason);
        }

        void policyClose() {
            WebSocket target;
            synchronized (this) {
                if (terminal) return;
                closeRequested = true;
                target = ws;
            }
            if (target != null) target.close(1008, "policy");
        }

        @Override
        public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            synchronized (this) {
                if (terminal) return;
                if (ws == null) ws = webSocket;
                opened = true;
                queue(event("open"), false);
            }
        }

        @Override
        public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            synchronized (this) {
                if (terminal) return;
                queue(put(event("message"), "data", text), false);
            }
        }

        @Override
        public void onMessage(@NonNull WebSocket webSocket, @NonNull ByteString bytes) {
            // Zero speaks text frames only.
            webSocket.close(1003, "text only");
        }

        @Override
        public void onClosing(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            try {
                webSocket.close(1000, null);
            } catch (RuntimeException e) {
                // already closing
            }
        }

        @Override
        public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            synchronized (this) {
                if (terminal) return;
                terminal = true;
                queue(put(put(put(event("close"), "code", code), "reason", reason), "clean", true), true);
            }
        }

        @Override
        public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable t, Response response) {
            synchronized (this) {
                if (terminal) return;
                terminal = true;
                queue(put(put(event("error"), "status", response == null ? 0 : response.code()),
                        "kind", t.getClass().getSimpleName()), false);
                queue(put(put(put(event("close"), "code", 1006), "reason", ""), "clean", false), true);
            }
        }
    }

    // ---- validation -----------------------------------------------------------------

    /** The destination is rebuilt from the Zero metadata; only the validated query is kept. */
    private String zeroTarget(String url) throws Reject {
        if (url.length() > MAX_URL) throw new Reject("invalid-url");
        URI u;
        try {
            u = new URI(url);
        } catch (java.net.URISyntaxException e) {
            throw new Reject("invalid-url");
        }
        String query = u.getRawQuery();
        int port = u.getPort() == -1 ? 443 : u.getPort();
        if (!"wss".equals(u.getScheme()) || u.getHost() == null || !zero.host.equalsIgnoreCase(u.getHost())
                || port != zero.port
                || u.getRawUserInfo() != null || u.getRawFragment() != null
                || !zero.socketPath.equals(u.getRawPath())
                || (query != null && !RAW_QUERY.matcher(query).matches()))
            throw new Reject("invalid-url");
        if (query != null && !query.isEmpty()) {
            boolean sawBaseCookie = false;
            for (String pair : query.split("&", -1)) {
                int eq = pair.indexOf('=');
                String key = eq < 0 ? pair : pair.substring(0, eq);
                if (key.equals("baseCookie")) {
                    // Zero's sync cursor is separate from native authentication.
                    String value = eq < 0 ? "" : pair.substring(eq + 1);
                    if (sawBaseCookie || eq < 0 || value.length() > 128 || !BASE_COOKIE.matcher(value).matches())
                        throw new Reject("invalid-url");
                    sawBaseCookie = true;
                    continue;
                }
                if (!QUERY_KEY.matcher(key).matches() || CREDENTIAL_NAME.matcher(key).find())
                    throw new Reject("invalid-url");
            }
        }
        return zero.socketUrl(query);
    }

    /**
     * Decodes Zero's Sec-WebSocket-Protocol, validates it, and replaces only the opaque
     * handle with the JWT by splicing the original text, so initConnectionMessage stays
     * byte-for-byte whole (embedded path) or absent (late path).
     */
    private String spliceProtocol(String protocol, boolean[] embedded) throws Reject {
        if (protocol.isEmpty() || protocol.length() > MAX_PROTOCOL || !PROTOCOL.matcher(protocol).matches())
            throw new Reject("invalid-protocol");
        String json;
        try {
            String b64 = URLDecoder.decode(protocol, "UTF-8");
            byte[] bytes = Base64.decode(b64, Base64.NO_WRAP);
            if (!Base64.encodeToString(bytes, Base64.NO_WRAP).equals(b64)) throw new Reject("invalid-protocol");
            json = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (IllegalArgumentException | java.io.UnsupportedEncodingException
                 | java.nio.charset.CharacterCodingException e) {
            throw new Reject("invalid-protocol");
        }
        Map<String, Object> map;
        try {
            map = asMap(parse(json));
        } catch (IOException e) {
            throw new Reject("invalid-protocol");
        }
        for (String key : map.keySet())
            if (!key.equals("initConnectionMessage") && !key.equals("authToken")) throw new Reject("invalid-protocol");
        if (!(map.get("authToken") instanceof String) || !handle.equals(map.get("authToken")))
            throw new Reject("invalid-auth-handle");
        String suffix = "\"authToken\":\"" + handle + "\"}";
        if (!json.endsWith(suffix)) throw new Reject("invalid-protocol");
        String prefix = json.substring(0, json.length() - suffix.length());
        if (map.containsKey("initConnectionMessage")) {
            if (!prefix.startsWith("{\"initConnectionMessage\":") || !prefix.endsWith(",")) throw new Reject("invalid-protocol");
            validateInit(map.get("initConnectionMessage"));
            embedded[0] = true;
        } else {
            if (!prefix.equals("{")) throw new Reject("invalid-protocol");
            embedded[0] = false;
        }
        String out = prefix + "\"authToken\":\"" + jwt + "\"}";
        String b64 = Base64.encodeToString(out.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        return b64.replace("+", "%2B").replace("/", "%2F").replace("=", "%3D");
    }

    private String filterFrame(String text) throws Reject {
        Object value;
        try {
            value = parse(text);
        } catch (IOException e) {
            throw new Reject("invalid-frame");
        }
        if (!(value instanceof List) || ((List<?>) value).isEmpty() || !(((List<?>) value).get(0) instanceof String))
            throw new Reject("invalid-frame");
        List<?> frame = (List<?>) value;
        String name = (String) frame.get(0);
        if (!FRAME_NAME.matcher(name).matches()) throw new Reject("invalid-frame");
        if (name.equals("updateAuth")) {
            // Only the opaque handle is accepted; caller JWTs and other handles are refused.
            if (jwt == null || !text.equals("[\"updateAuth\",{\"auth\":\"" + handle + "\"}]"))
                throw new Reject("invalid-auth-update");
            return "[\"updateAuth\",{\"auth\":\"" + jwt + "\"}]";
        }
        if (name.equals("initConnection")) validateInit(frame);
        return text;
    }

    private void validateInit(Object message) throws Reject {
        if (!(message instanceof List)) throw new Reject("invalid-callback");
        List<?> list = (List<?>) message;
        if (list.size() != 2 || !"initConnection".equals(list.get(0)) || !(list.get(1) instanceof Map))
            throw new Reject("invalid-callback");
        Map<?, ?> body = (Map<?, ?>) list.get(1);
        requireUrl(body, "userPushURL", context.mutateUrl());
        requireUrl(body, "userQueryURL", context.queryUrl());
        requireHeaders(body, "userPushHeaders");
        requireHeaders(body, "userQueryHeaders");
    }

    private static void requireUrl(Map<?, ?> body, String key, String expected) throws Reject {
        if (body.containsKey(key) && !expected.equals(body.get(key))) throw new Reject("invalid-callback");
    }

    private void requireHeaders(Map<?, ?> body, String key) throws Reject {
        if (!body.containsKey(key)) return;
        if (!(body.get(key) instanceof Map)) throw new Reject("invalid-callback");
        Map<?, ?> headers = (Map<?, ?>) body.get(key);
        if (headers.size() > 8) throw new Reject("invalid-callback");
        for (Map.Entry<?, ?> e : headers.entrySet()) {
            if (!(e.getKey() instanceof String) || !(e.getValue() instanceof String)) throw new Reject("invalid-callback");
            String name = (String) e.getKey();
            String value = (String) e.getValue();
            if (!HEADER_NAME.matcher(name).matches() || CREDENTIAL_NAME.matcher(name).find()
                    || value.length() > 256 || value.matches(".*[\\x00-\\x1f\\x7f].*")
                    || value.toLowerCase(Locale.ROOT).startsWith("bearer ")
                    || (handle != null && value.contains(handle)) || (jwt != null && value.contains(jwt)))
                throw new Reject("invalid-callback");
        }
    }

    // ---- credential storage ---------------------------------------------------------

    private static String blobKey(String scope) {
        return "s." + hex(sha256(scope.getBytes(StandardCharsets.UTF_8)));
    }

    private static String pointerKey(ServerContext ctx) {
        return "a." + hex(sha256(ctx.origin.getBytes(StandardCharsets.UTF_8)));
    }

    private SecretKey storeKey() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            gen.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    private static byte[] aad(String scope) {
        return ("ditero-native-session-v2\n" + scope).getBytes(StandardCharsets.UTF_8);
    }

    /** One checked commit writes the encrypted session and the selected-account pointer. */
    private boolean persistSession(Session s) {
        try {
            String scope = s.scope();
            String plain = obj("token", s.token, "sessionId", s.sessionId, "userId", s.userId,
                    "deviceId", s.deviceId, "expiresAt", s.expiresAt).toString();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, storeKey());
            cipher.updateAAD(aad(scope));
            byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            String blob = "v2." + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                    + "." + Base64.encodeToString(ct, Base64.NO_WRAP);
            SharedPreferences.Editor editor = prefs.edit().putString(blobKey(scope), blob)
                    .putString(pointerKey(s.context), s.userId);
            String previousUser = prefs.getString(pointerKey(s.context), null);
            if (previousUser != null && validId(previousUser) && !previousUser.equals(s.userId))
                editor.remove(blobKey(s.context.scope(previousUser)));
            return editor.commit();
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            return false;
        }
    }

    /** Removes exactly the captured namespace; the pointer only if it still names this account. */
    private boolean clearPersisted(Session s) {
        try {
            SharedPreferences.Editor editor = prefs.edit().remove(blobKey(s.scope()));
            if (s.userId.equals(prefs.getString(pointerKey(s.context), null)))
                editor.remove(pointerKey(s.context));
            return editor.commit();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private ServerContext restoreSelected() {
        String origin = prefs.getString(PREF_SELECTED, null);
        if (origin == null) return null;
        try {
            ServerContext ctx = ServerContext.parse(origin);
            if (ctx.origin.equals(origin)) return ctx;
        } catch (IllegalArgumentException e) {
            // fall through: a malformed selection is dropped, nothing else is touched
        }
        prefs.edit().remove(PREF_SELECTED).commit();
        return null;
    }

    /**
     * Restores the one namespace the stored pointer selects for this instance. Undecryptable
     * or tampered data removes only that namespace; an unavailable keystore removes nothing.
     */
    private Session restoreSession(ServerContext ctx) {
        String userId = prefs.getString(pointerKey(ctx), null);
        if (!validId(userId)) return null;
        String scope = ctx.scope(userId);
        String blob = prefs.getString(blobKey(scope), null);
        if (blob == null) return null;
        SecretKey key;
        try {
            key = storeKey();
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            return null;
        }
        try {
            String[] parts = blob.split("\\.", -1);
            if (parts.length != 3 || !parts[0].equals("v2")) throw new Reject("format");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)));
            cipher.updateAAD(aad(scope));
            String plain = new String(cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            Map<String, Object> m = asMap(parse(plain));
            String token = str(m.get("token"));
            if (token == null || !BEARER.matcher(token).matches() || !userId.equals(m.get("userId"))
                    || !validId(str(m.get("sessionId"))) || !validId(str(m.get("deviceId")))
                    || str(m.get("expiresAt")) == null || !ISO.matcher(str(m.get("expiresAt"))).matches())
                throw new Reject("fields");
            return new Session(ctx, token, str(m.get("sessionId")), userId, str(m.get("deviceId")),
                    str(m.get("expiresAt")));
        } catch (BadPaddingException | IllegalBlockSizeException
                 | IllegalArgumentException | IOException | Reject e) {
            prefs.edit().remove(blobKey(scope)).remove(pointerKey(ctx)).commit();
            return null;
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    // ---- helpers --------------------------------------------------------------------

    private String newHandle() {
        return b64url(randomBytes(HANDLE_BYTES));
    }

    private byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        random.nextBytes(b);
        return b;
    }

    private static String b64url(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static byte[] sha256(byte[] in) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(in);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    private static long jwtExpiry(String token) {
        try {
            byte[] payload = Base64.decode(token.split("\\.")[1], Base64.URL_SAFE | Base64.NO_WRAP);
            Object exp = asMap(parse(new String(payload, StandardCharsets.UTF_8))).get("exp");
            return exp instanceof Double ? ((Double) exp).longValue() : 0;
        } catch (IOException | RuntimeException | Reject e) {
            return 0;
        }
    }

    private static boolean validId(String v) {
        return v != null && ID.matcher(v).matches();
    }

    private static String str(Object v) {
        return v instanceof String ? (String) v : null;
    }

    private static int smallInt(Object v, int min, int max, int fallback) {
        if (!(v instanceof Double)) return fallback;
        double d = (Double) v;
        return d == Math.rint(d) && d >= min && d <= max ? (int) d : fallback;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) throws Reject {
        if (!(v instanceof Map)) throw new Reject("invalid-response");
        return (Map<String, Object>) v;
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        for (int i = 0; i < kv.length; i += 2) put(o, (String) kv[i], kv[i + 1]);
        return o;
    }

    private static JSONObject put(JSONObject o, String key, Object value) {
        try {
            o.put(key, value == null ? JSONObject.NULL : value);
        } catch (org.json.JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    // Strict JSON: no leniency, no duplicate keys, bounded depth.
    private static Object parse(String s) throws IOException {
        JsonReader r = new JsonReader(new StringReader(s));
        r.setLenient(false);
        Object v = readValue(r, 0);
        if (r.peek() != JsonToken.END_DOCUMENT) throw new IOException("trailing");
        return v;
    }

    private static Object readValue(JsonReader r, int depth) throws IOException {
        if (depth > 24) throw new IOException("deep");
        switch (r.peek()) {
            case BEGIN_OBJECT: {
                Map<String, Object> m = new LinkedHashMap<>();
                r.beginObject();
                while (r.hasNext()) {
                    String k = r.nextName();
                    if (m.containsKey(k)) throw new IOException("duplicate");
                    m.put(k, readValue(r, depth + 1));
                }
                r.endObject();
                return m;
            }
            case BEGIN_ARRAY: {
                List<Object> l = new ArrayList<>();
                r.beginArray();
                while (r.hasNext()) l.add(readValue(r, depth + 1));
                r.endArray();
                return l;
            }
            case STRING:
                return r.nextString();
            case NUMBER:
                return r.nextDouble();
            case BOOLEAN:
                return r.nextBoolean();
            case NULL:
                r.nextNull();
                return JSONObject.NULL;
            default:
                throw new IOException("token");
        }
    }
}
