package io.ditero.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
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
import javax.crypto.IllegalBlockSizeException;

import okhttp3.MediaType;
import okhttp3.Call;
import okhttp3.Callback;
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

    private static final String PREF_SELECTED = NativeSessionVault.PREF_SELECTED;
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
    private final NativeAttachmentTransfers attachments;

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
    private final Map<String, Verification> verification = new HashMap<>();

    private static final class Verification {
        int pending;
        boolean refused;
        boolean invalid;
    }

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
        String expiresAt;
        String profileName;
        String profileEmail;
        String zeroUrl;
        String workspaceId;
        boolean verified;
        boolean refused;

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

    private final NativePushCoordinator push;
    private NativeSessionVault.CapturedOwner pushPermissionOwner;
    private PushOpen pendingPushOpen;
    private static final class PushOpen {
        final NativePushOpen tap;
        final NativeSessionVault.CapturedOwner owner;
        final String token;
        PushOpen(NativePushOpen tap,NativeSessionVault.CapturedOwner owner,String token) {
            this.tap=tap; this.owner=owner; this.token=token;
        }
    }

    private NativeZeroTransport(Activity activity) {
        this.activity = activity;
        this.push = NativePushCoordinator.get(activity);
        this.prefs = new NativeSessionVault(activity).preferences();
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
        this.attachments = new NativeAttachmentTransfers(activity, http);
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
        pendingPushOpen=null;
        pushPermissionOwner=null;
        ready = false;
        attachments.cancelAll();
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
        attachments.shutdown();
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
        if (data == null || data.length() > 2 * 1024 * 1024) {
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
            boolean fileOp = op.startsWith("attachment.") || op.startsWith("upload.")
                    || op.startsWith("download.") || op.startsWith("save.");
            boolean fileChunk = op.equals("upload.write") || op.equals("save.write");
            if (!socketOp && data.length() > (e2eOp ? MAX_BODY + MAX_CONTROL : fileChunk ? MAX_BODY : op.equals("attachment.reserve") ? 2 * 1024 * 1024 : MAX_CONTROL))
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
                case "push.open":
                case "push.dismissOpen":
                    requireReady(m);
                    pushOpenOperation(proxy,rid,op,m);
                    return;
                case "push.state":
                case "push.enable":
                case "push.disable":
                case "push.permission":
                    requireReady(m);
                    pushOperation(proxy,rid,op,m);
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
                    if (fileOp) {
                        requireReady(m);
                        if(page != proxy) throw new Reject("stale-generation");
                        attachment(proxy,rid,op,m);
                        return;
                    }
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

    void pushOpenIntent(Intent intent) {
        NativePushOpen tap;
        try {tap=NativePushOpen.parse(intent.getAction(),intent.getDataString(),intent.getExtras()!=null);}
        catch(RuntimeException e) {return;}
        NativePushStore.Owner owner=push.openOwner(tap,false);
        if(closed || owner==null) return;
        pendingPushOpen=new PushOpen(tap,owner.session,b64url(randomBytes(32)));
        if(ready && page!=null) sendToPage(page,obj("t","push.open","gen",generation));
    }

    private boolean ownsPushOpen(PushOpen open,boolean verified) {
        NativePushStore.Owner owner=push.openOwner(open.tap,verified);
        return owner!=null && NativeSessionVault.sameOwner(open.owner,owner.session);
    }

    private void pushOpenOperation(JavaScriptReplyProxy proxy,int rid,String op,Map<String,Object> m) throws Reject {
        if(page!=proxy || session==null || handle==null || !handle.equals(str(m.get("id")))) throw new Reject("no-session");
        Set<String> fields=new HashSet<>(Arrays.asList("op","rid","gen","id"));
        if(op.equals("push.dismissOpen")) fields.add("body");
        if(!fields.containsAll(m.keySet())) throw new Reject("invalid-message");
        final PushOpen open=pendingPushOpen;
        if(open!=null && (!ownsPushOpen(open,false) || !session.scope().equals(open.owner.scope)
                || !session.sessionId.equals(open.owner.sessionId) || !session.deviceId.equals(open.owner.deviceId))) {
            pendingPushOpen=null;
            throw new Reject("notification-unavailable");
        }
        if(op.equals("push.dismissOpen")) {
            Map<String,Object> body=asMap(m.get("body"));
            if(body.size()!=1 || !body.containsKey("token") || !(body.get("token") instanceof String)) throw new Reject("invalid-message");
            if(open==null || !open.token.equals(body.get("token"))) throw new Reject("notification-unavailable");
            pendingPushOpen=null;
            sendToPage(proxy,obj("t","reply","rid",rid,"ok",true));
            return;
        }
        if(open==null) {sendToPage(proxy,obj("t","reply","rid",rid,"ok",true,"open",null)); return;}
        if(!session.verified || session.refused || !unexpired(session.expiresAt) || revoking!=null || !ownsPushOpen(open,true))
            throw new Reject("no-session");
        authed(proxy,rid,true,"/api/native/push/open",obj("notificationId",open.tap.notificationId,
                "registrationId",open.tap.registrationId).toString(),false,new Reply() {
            @Override public JSONObject build(int code,String raw) throws Reject,IOException {
                if(instanceUnauthorized(new HttpResult(code,raw))) {
                    session.refused=true; dropSession(session); throw new Reject("unauthorized");
                }
                if(pendingPushOpen!=open) throw new Reject("notification-unavailable");
                if(!ownsPushOpen(open,false)) {pendingPushOpen=null; throw new Reject("notification-unavailable");}
                if(code==404) {pendingPushOpen=null; return obj("ok",false,"code","notification-unavailable");}
                if(code!=200) throw new Reject("http-"+code);
                Map<String,Object> response=asMap(parse(raw));
                Map<String,Object> target=asMap(response.get("target"));
                String kind=str(target.get("kind"));
                boolean task="task".equals(kind), workspace="workspace".equals(kind);
                boolean validTaskIds=NativePushOpen.id(str(target.get("listId"))) && NativePushOpen.id(str(target.get("taskId")));
                if(response.size()!=1 || (!task && !workspace) || target.size()!=(task?4:2)
                        || !NativePushOpen.id(str(target.get("workspaceId"))) || (task && !validTaskIds))
                    throw new Reject("invalid-response");
                return obj("ok",true,"open",obj("token",open.token,"target",new JSONObject(target)));
            }
        });
    }

    private void pushOperation(JavaScriptReplyProxy proxy,int rid,String op,Map<String,Object> m) throws Reject {
        if(page!=proxy || session==null || handle==null || !handle.equals(str(m.get("id")))) throw new Reject("no-session");
        if(!new HashSet<>(Arrays.asList("op","rid","gen","id")).containsAll(m.keySet())) throw new Reject("invalid-message");
        if(op.equals("push.disable")) retirePush();
        if(op.equals("push.enable")) {
            if(!push.permitted() && android.os.Build.VERSION.SDK_INT>=33) {
                if(pushPermissionOwner!=null) throw new Reject("busy");
                pushPermissionOwner=new NativeSessionVault(activity).capture();
                if(pushPermissionOwner==null) throw new Reject("no-session");
                activity.requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},7346);
            } else push.enable(activity);
        }
        if(op.equals("push.permission") && !push.permitted() && android.os.Build.VERSION.SDK_INT>=33) {
            if(pushPermissionOwner!=null) throw new Reject("busy");
            activity.requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},7347);
        }
        sendToPage(proxy,obj("t","reply","rid",rid,"ok",true,"state",push.state(),
                "permission",push.permitted()?"granted":"denied","provider","unifiedpush"));
    }

    private boolean retirePush() {pendingPushOpen=null; pushPermissionOwner=null; return push.invalidate();}

    void pushPermissionResult(int requestCode) {
        NativeSessionVault.CapturedOwner captured=pushPermissionOwner;
        pushPermissionOwner=null;
        if(requestCode==7346 && captured!=null && new NativeSessionVault(activity).isCurrent(captured)) {
            if(push.permitted()) push.enable(activity);
            else push.denied();
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
        attachments.cancelAll();
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
        if(pendingPushOpen!=null && !ownsPushOpen(pendingPushOpen,false)) pendingPushOpen=null;
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
            if (!retirePush()) {fail(proxy,rid,"storage-failed"); return;}
            if (!prefs.edit().putString(PREF_SELECTED, next.origin).commit()) {
                fail(proxy, rid, "storage-failed");
                return;
            }
            attachments.cancelAll();
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
        final Session owner = session;
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
                    if (result == null) {
                        if (owner == session && offlineReady(owner)) {
                            zero = ServerContext.ZeroEndpoint.parse(owner.zeroUrl);
                            sendToPage(proxy, obj("t", "reply", "rid", rid, "ok", true, "origin", ctx.origin,
                                    "zeroURL", zero.httpsUrl, "queryUrl", ctx.queryUrl(), "mutateUrl", ctx.mutateUrl()));
                            return;
                        }
                        throw new Reject("network");
                    }
                    if (result.code == -1) throw new Reject("transport-refused");
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
                    if (owner != null && owner == session) {
                        owner.zeroUrl = endpoint.httpsUrl;
                        if (!persistSession(owner)) throw new Reject("storage-failed");
                    }
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
                if (!unexpired(expiresAt)) throw new Reject("invalid-response");
                session.expiresAt = expiresAt;
                markVerified(session);
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
                session.profileName = name;
                session.profileEmail = email;
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
                session.workspaceId = workspaceId;
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

    boolean activityResult(int requestCode, int resultCode, Intent data) {
        return attachments.activityResult(requestCode,resultCode,data);
    }

    private static void fileFields(Map<String,Object> body, String... fields) throws Reject {
        if (!new HashSet<>(Arrays.asList(fields)).containsAll(body.keySet())) throw new Reject("invalid-body");
    }
    private static String fileId(Object value) throws Reject {
        String id=str(value);
        if(id==null || !id.matches("^[A-Za-z0-9_-]{1,128}$"))throw new Reject("invalid-id");
        return id;
    }
    private static boolean thumbnail(Map<String,Object> body) throws Reject {
        if(!(body.get("thumbnail") instanceof Boolean))throw new Reject("invalid-body");
        return (Boolean)body.get("thumbnail");
    }
    private void attachment(final JavaScriptReplyProxy proxy, final int rid, String op, Map<String,Object> m) throws Reject {
        fileFields(m,"op","rid","gen","body");
        final Session s=session;
        final ServerContext ctx=context;
        if(s==null || ctx==null || s.context!=ctx || s.refused || !unexpired(s.expiresAt) || revoking!=null)throw new Reject("no-session");
        final int g=generation;
        final String owner=s.scope()+"\n"+s.sessionId+"\n"+s.deviceId+"\n"+g+"\n"+System.identityHashCode(proxy);
        final Map<String,Object> body=asMap(m.get("body"));
        final NativeAttachmentTransfers.Reply observer = value -> main.post(() -> {
            Object status=value.get("status"), raw=value.get("body");
            if(status instanceof Number && instanceUnauthorized(new HttpResult(((Number)status).intValue(),raw instanceof String?(String)raw:null))) {
                s.refused=true;
                dropSession(s);
            }
        });
        final NativeAttachmentTransfers.Reply reply = value -> main.post(() -> {
            Object status=value.get("status"), raw=value.get("body");
            if(status instanceof Number && instanceUnauthorized(new HttpResult(((Number)status).intValue(),raw instanceof String?(String)raw:null))) {
                s.refused=true;
                dropSession(s);
            }
            if(!current(g,ctx) || session!=s || page!=proxy) {
                Object id=value.containsKey("transferId")?value.get("transferId"):value.get("saveId");
                if(id instanceof String)try { attachments.cancel((String)id,owner); } catch(IllegalArgumentException ignored) {}
                cancelled(proxy,rid); return;
            }
            JSONObject out=new JSONObject(value);
            put(out,"t","reply"); put(out,"rid",rid);
            sendToPage(proxy,out);
        });
        try {
            switch(op) {
                case "attachment.config":
                    fileFields(body);
                    attachmentControl(proxy,rid,false,"/api/native/attachments/config",null); return;
                case "attachment.reserve":
                    fileFields(body,"id","workspaceId","parentKind","parentId","keyVersion","filenameCiphertext","contentTypeCiphertext","dekWrapped","declaredBytes","thumbnailDeclaredBytes");
                    fileId(body.get("id")); fileId(body.get("workspaceId")); fileId(body.get("parentId"));
                    NativeAttachmentTransfers.positiveBytes(body.get("declaredBytes"));
                    NativeAttachmentTransfers.optionalPositiveBytes(body.get("thumbnailDeclaredBytes"),JSONObject.NULL);
                    attachmentControl(proxy,rid,true,"/api/native/attachments/reserve",new JSONObject(body).toString()); return;
                case "attachment.finalize": case "attachment.abort": case "attachment.delete":
                    fileFields(body,"id"); fileId(body.get("id"));
                    attachmentControl(proxy,rid,true,"/api/native/attachments/"+op.substring(11),new JSONObject(body).toString()); return;
                case "upload.begin":
                    fileFields(body,"attachmentId","thumbnail","bytes");
                    attachments.upload(owner,ctx.url(NativeAttachmentTransfers.attachmentPath(fileId(body.get("attachmentId")),thumbnail(body),true)),s.token,NativeAttachmentTransfers.positiveBytes(body.get("bytes")),reply,observer);return;
                case "download.begin":
                    fileFields(body,"attachmentId","thumbnail");
                    attachments.download(owner,ctx.url(NativeAttachmentTransfers.attachmentPath(fileId(body.get("attachmentId")),thumbnail(body),false)),s.token,reply);return;
                case "upload.write": case "save.write":
                    fileFields(body,op.startsWith("save.")?"saveId":"transferId","seq","data");
                    attachments.write(owner,fileId(body.get(op.startsWith("save.")?"saveId":"transferId")),smallInt(body.get("seq"),0,Integer.MAX_VALUE,-1),str(body.get("data")),op.startsWith("save."),reply); return;
                case "upload.finish": case "save.finish":
                    fileFields(body,op.startsWith("save.")?"saveId":"transferId","seq");
                    attachments.finish(owner,fileId(body.get(op.startsWith("save.")?"saveId":"transferId")),smallInt(body.get("seq"),0,Integer.MAX_VALUE,-1),op.startsWith("save."),reply);return;
                case "download.read":
                    fileFields(body,"transferId","seq");
                    attachments.read(owner,fileId(body.get("transferId")),smallInt(body.get("seq"),0,Integer.MAX_VALUE,-1),reply);return;
                case "attachment.cancel": case "save.cancel":
                    fileFields(body,op.equals("save.cancel")?"saveId":"transferId");
                    attachments.cancel(fileId(body.get(op.equals("save.cancel")?"saveId":"transferId")),owner);reply.done(NativeAttachmentTransfers.value("ok",true));return;
                case "save.cancelPending":
                    fileFields(body); attachments.cancelPending(owner);reply.done(NativeAttachmentTransfers.value("ok",true));return;
                case "save.pick":
                    fileFields(body,"filename"); attachments.pick(owner,str(body.get("filename")),reply);return;
                default: throw new Reject("unknown-op");
            }
        } catch(IllegalArgumentException error) { throw new Reject(error.getMessage()); }
    }
    private void attachmentControl(JavaScriptReplyProxy proxy, int rid, boolean post, String path, String body) throws Reject {
        if(body!=null && body.getBytes(StandardCharsets.UTF_8).length>(path.endsWith("/reserve")?2*1024*1024:MAX_CONTROL))throw new Reject("invalid-body");
        authed(proxy,rid,post,path,body,true,(code,raw) -> {
            boolean parseable=false;
            try { parse(raw); parseable=true; } catch(IOException ignored) {}
            return obj("ok",code>=200 && code<300 && parseable,"status",code,"body",raw,
                    "code",code>=200 && code<300 ? "invalid-response" : "http-"+code);
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
                        if (closed) {
                            if (outcome.session != null) revokeAbandoned(outcome.session.context, outcome.session.token);
                            return;
                        }
                        if (exchange != ex || g != generation || context != ctx) {
                            if (outcome.session != null) revokeAbandoned(outcome.session.context, outcome.session.token);
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
                        if(!retirePush()) {
                            revokeAbandoned(next.context,next.token);
                            fail(proxy,rid,"storage-failed");
                            return;
                        }
                        if (!persistSession(next)) {
                            revokeAbandoned(next.context, next.token);
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
        String mintedToken = null;
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
            if (token != null && BEARER.matcher(token).matches()) mintedToken = token;
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
        if (out.session == null && mintedToken != null) revokeAbandoned(ctx, mintedToken);
        return out;
    }

    // A successfully exchanged token that was never installed must not become an orphan.
    private void revokeAbandoned(ServerContext ctx, String token) {
        Request request = new Request.Builder().url(ctx.url("/api/native/session/revoke"))
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + token)
                .post(RequestBody.create("{}", JSON_TYPE)).build();
        http.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException error) {
                Log.w(TAG, "abandoned session revocation failed");
            }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response ignored = response) {
                    if (response.code() != 200)
                        Log.w(TAG, "abandoned session revocation refused");
                }
            }
        });
    }

    private static boolean instanceUnauthorized(HttpResult result) {
        if (result == null || result.code != 401 || result.body == null) return false;
        try {
            return NativeResponsePolicy.confirmsUnauthorized(result.code, asMap(parse(result.body)));
        } catch (Reject | IOException error) {
            return false;
        }
    }

    private void refresh(final JavaScriptReplyProxy proxy, final int rid) {
        authed(proxy, rid, false, "/api/native/token", null, true, new Reply() {
            @Override
            public JSONObject build(int code, String raw) throws Reject, IOException {
                if (code != 200) throw new Reject("http-" + code);
                String token = str(asMap(parse(raw)).get("token"));
                if (token == null || token.length() > MAX_JWT || !JWT.matcher(token).matches())
                    throw new Reject("jwt-rejected");
                long expiry = jwtExpiry(token);
                if (expiry <= System.currentTimeMillis() / 1000) throw new Reject("jwt-rejected");
                jwt = token;
                jwtExp = expiry;
                markVerified(session);
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
        if (clearOnUnauthorized && !beginCheck(s)) {
            fail(proxy, rid, "storage-failed");
            return;
        }
        Request.Builder builder = new Request.Builder().url(ctx.url(path))
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + s.token);
        if (post) builder.post(RequestBody.create(body == null ? "{}" : body, JSON_TYPE));
        else builder.get();
        dispatch(builder.build(), new Done() {
            boolean settled;
            private boolean settle(boolean usable) {
                if (!clearOnUnauthorized || settled) return true;
                settled = true;
                return finishCheck(s, usable);
            }
            @Override
            public void run(HttpResult result) {
                boolean ownsPage = current(g, ctx) && session == s && page == proxy;
                if (instanceUnauthorized(result) && clearOnUnauthorized) {
                    s.refused = true;
                    settle(false);
                    dropSession(s);
                    if (ownsPage) fail(proxy, rid, "unauthorized");
                    else cancelled(proxy, rid);
                    return;
                }
                if (!ownsPage) {
                    settle(result == null);
                    cancelled(proxy, rid);
                    return;
                }
                if (result == null) {
                    boolean cached = clearOnUnauthorized && offlineReady(s);
                    if (!settle(true)) {
                        fail(proxy, rid, "storage-failed");
                        return;
                    }
                    if (cached && cachedReply(proxy, rid, path, s)) return;
                    fail(proxy, rid, "network");
                    return;
                }
                if (result.code == -1 || result.body == null) {
                    settle(false);
                    fail(proxy, rid, result.code == -1 ? "transport-refused" : "invalid-response");
                    return;
                }
                try {
                    JSONObject out = reply.build(result.code, result.body);
                    if (clearOnUnauthorized && !persistSession(s)) throw new Reject("storage-failed");
                    if (!settle(true)) {
                        fail(proxy, rid, "storage-failed");
                        return;
                    }
                    put(out, "t", "reply");
                    put(out, "rid", rid);
                    sendToPage(proxy, out);
                } catch (Reject | IOException e) {
                    settle(false);
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
        if (!retirePush()) {fail(proxy,rid,"storage-failed"); return;}
        if (!beginCheck(s)) {
            fail(proxy, rid, "storage-failed");
            return;
        }
        final int g = generation;
        attachments.cancelAll();
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
                } else if (instanceUnauthorized(result)) {
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
                    boolean restored = finishCheck(s, result == null);
                    if (!restored && result == null) failure = "storage-failed";
                    if (current(g, ctx) && session == s) fail(proxy, rid, failure);
                    else cancelled(proxy, rid);
                    return;
                }
                s.refused = true;
                finishCheck(s, false);
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
        if (!retirePush()) {fail(proxy,rid,"storage-failed"); return;}
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
        if(sameSession(session,s)) retirePush();
        clearPersisted(s);
        if (sameSession(session, s)) {
            String refusedHandle = handle;
            dropMemory();
            if (ready && page != null) sendToPage(page, obj("t", "session-refused", "gen", generation,
                    "authHandle", refusedHandle));
        }
    }

    private static boolean sameSession(Session first, Session second) {
        return first != null && second != null && first.scope().equals(second.scope())
                && first.sessionId.equals(second.sessionId);
    }

    private void dropMemory() {
        attachments.cancelAll();
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

    /** Only an unavailable transport before any response may use cached startup proof. */
    private void dispatch(final Request request, final Done done) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                HttpResult res;
                try {
                    res = call(request);
                } catch (IOException e) {
                    res = offlineFailure(e) ? null : new HttpResult(-1, null);
                } catch (RuntimeException e) {
                    res = new HttpResult(-1, null);
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

    private static boolean offlineFailure(IOException error) {
        List<Throwable> pending = new ArrayList<>();
        Set<Throwable> seen = new HashSet<>();
        pending.add(error);
        for (int i = 0; i < pending.size(); i++) {
            Throwable current = pending.get(i);
            if (!seen.add(current)) continue;
            if (current instanceof javax.net.ssl.SSLException || current instanceof java.net.ProtocolException
                    || current instanceof java.net.UnknownServiceException) return false;
            if (current.getCause() != null) pending.add(current.getCause());
            pending.addAll(Arrays.asList(current.getSuppressed()));
        }
        return true;
    }

    private HttpResult call(Request request) throws IOException {
        if (!request.url().isHttps())
            throw new IOException("cleartext refused", new java.net.UnknownServiceException("cleartext refused"));
        Response response;
        try {
            response = http.newCall(request).execute();
        } catch (IOException error) {
            if (!offlineFailure(error)) throw new IOException("transport refused", error);
            throw error;
        }
        try (Response received = response) {
            return readResponse(received);
        }
    }

    private static HttpResult readResponse(Response response) {
        int status = response.code();
        try {
            byte[] bytes = response.peekBody(MAX_BODY + 1L).bytes();
            return new HttpResult(status,
                    bytes.length > MAX_BODY ? null : new String(bytes, StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException error) {
            // A received status is never a transport outage, even when its body is truncated.
            return new HttpResult(status, null);
        }
    }

    // ---- websocket ------------------------------------------------------------------

    private void wsOpen(final JavaScriptReplyProxy proxy, final int rid, final Integer cid,
                        final Map<String, Object> m) throws Reject {
        if (cid == null || socks.containsKey(cid) || socks.size() >= MAX_SOCKETS) throw new Reject("invalid-socket");
        if (context == null || zero == null) throw new Reject("no-config");
        if (session == null || handle == null || !unexpired(session.expiresAt)) throw new Reject("no-session");
        String url = str(m.get("url")), protocol = str(m.get("protocol"));
        if (url == null || protocol == null) throw new Reject("invalid-message");
        zeroTarget(url);
        final Session owner = session;
        final ServerContext ctx = context;
        final int g = generation;
        final Sock sock = new Sock(cid, g, proxy);
        socks.put(cid, sock);
        if (jwt != null && jwtExp > System.currentTimeMillis() / 1000) {
            try {
                openSocket(proxy, rid, sock, url, protocol);
            } catch (Reject e) {
                socks.remove(cid);
                throw e;
            }
            return;
        }
        if (!beginCheck(owner)) {
            socks.remove(cid);
            throw new Reject("storage-failed");
        }
        final Request request = new Request.Builder().url(ctx.url("/api/native/token"))
                .header("Accept", "application/json").header("Authorization", "Bearer " + owner.token).get().build();
        dispatch(request, new Done() {
            boolean settled;
            private boolean settle(boolean usable) {
                if (settled) return true;
                settled = true;
                return finishCheck(owner, usable);
            }
            @Override public void run(HttpResult result) {
                boolean stopped;
                synchronized (sock) {
                    stopped = sock.closeRequested || sock.detached || sock.terminal;
                }
                boolean ownsSocket = current(g, ctx) && session == owner && page == proxy
                        && socks.get(cid) == sock && !stopped;
                if (instanceUnauthorized(result)) {
                    owner.refused = true;
                    settle(false);
                    dropSession(owner);
                    if (ownsSocket) sendToPage(proxy, obj("t", "reply", "rid", rid, "cid", cid,
                            "ok", false, "code", "unauthorized"));
                    else if (page == proxy) sendToPage(proxy, obj("t", "reply", "rid", rid, "cid", cid,
                            "ok", false, "code", "cancelled"));
                    return;
                }
                if (!ownsSocket) {
                    settle(result == null);
                    if (socks.get(cid) == sock) socks.remove(cid);
                    if (page == proxy) sendToPage(proxy, obj("t", "reply", "rid", rid, "cid", cid,
                            "ok", false, "code", "cancelled"));
                    return;
                }
                try {
                    if (result == null) {
                        if (!settle(true)) throw new Reject("storage-failed");
                        throw new Reject("network");
                    }
                    if (result.code != 200 || result.body == null)
                        throw new Reject(result.code == -1 ? "transport-refused" : "invalid-response");
                    String token = str(asMap(parse(result.body)).get("token"));
                    if (token == null || token.length() > MAX_JWT || !JWT.matcher(token).matches())
                        throw new Reject("jwt-rejected");
                    long expiry = jwtExpiry(token);
                    if (expiry <= System.currentTimeMillis() / 1000) throw new Reject("jwt-rejected");
                    markVerified(owner);
                    if (!persistSession(owner)) throw new Reject("storage-failed");
                    if (!settle(true)) throw new Reject("storage-failed");
                    jwt = token;
                    jwtExp = expiry;
                    openSocket(proxy, rid, sock, str(m.get("url")), str(m.get("protocol")));
                } catch (Reject | IOException e) {
                    // A transport failure keeps offline authority; a server/protocol refusal does not.
                    if (result != null) settle(false);
                    if (socks.get(cid) == sock) socks.remove(cid);
                    sendToPage(proxy, obj("t", "reply", "rid", rid, "cid", cid, "ok", false,
                            "code", e instanceof Reject ? e.getMessage() : "invalid-response"));
                }
            }
        });
    }

    private void openSocket(JavaScriptReplyProxy proxy, int rid, Sock sock, String url, String protocol) throws Reject {
        String target = zeroTarget(url);
        boolean[] embedded = new boolean[1];
        String outProtocol = spliceProtocol(protocol, embedded);
        Request request = new Request.Builder().url(target)
                .header("Sec-WebSocket-Protocol", outProtocol).build();
        sendToPage(proxy, obj("t", "reply", "rid", rid, "cid", sock.cid, "ok", true,
                "initPath", embedded[0] ? "embedded" : "late"));
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

    private static String blobKey(String scope) { return NativeSessionVault.blobKey(scope); }
    private static String pointerKey(ServerContext ctx) { return NativeSessionVault.pointerKey(ctx); }
    private static boolean unexpired(String value) { return NativeSessionVault.unexpired(value); }

    private static void restoreProof(Session restored, Map<String, Object> m) throws Reject {
        NativeSessionVault.Proof proof = NativeSessionVault.proof(restored.userId, m);
        if (proof == null) return;
        restored.zeroUrl = proof.zeroUrl;
        restored.profileName = proof.name;
        restored.profileEmail = proof.email;
        restored.workspaceId = proof.workspaceId;
        restored.verified = true;
    }

    private static boolean offlineReady(Session s) {
        return s != null && !s.refused && s.verified && unexpired(s.expiresAt)
                && s.profileName != null && s.profileEmail != null && s.zeroUrl != null && s.workspaceId != null;
    }

    private String checkKey(Session s) {
        return NativeSessionVault.checkKey(s.scope(), s.sessionId);
    }

    // Mark verification durably before sending: a refused response cannot resurrect a cached session
    // even if removing its encrypted record subsequently fails. Interrupted verification fails closed.
    private void markVerified(Session s) {
        Verification state = verification.get(checkKey(s));
        if (state != null && state.refused) return;
        s.verified = true;
        if (state != null) state.invalid = false;
    }

    private boolean beginCheck(Session s) {
        String key = checkKey(s);
        Verification state = verification.get(key);
        if (s.refused || (state != null && state.refused)
                || !prefs.edit().putBoolean(key, true).commit()) return false;
        if (state == null) {
            state = new Verification();
            verification.put(key, state);
        }
        state.pending++;
        return true;
    }

    private boolean finishCheck(Session s, boolean usable) {
        String key = checkKey(s);
        Verification state = verification.get(key);
        if (state == null) return usable && !s.refused;
        if (!usable) {
            s.verified = false;
            state.invalid = true;
        }
        if (s.refused) state.refused = true;
        if (state.refused) s.refused = true;
        if (state.pending > 0) state.pending--;
        if (!usable || state.refused || state.invalid || !s.verified || state.pending != 0)
            return usable && !state.refused;
        boolean cleared = prefs.edit().remove(key).commit();
        if (cleared) {
            verification.remove(key);
            if(push!=null) push.verificationAccepted();
        }
        return cleared;
    }

    private boolean cachedReply(JavaScriptReplyProxy proxy, int rid, String path, Session s) {
        JSONObject out;
        switch (path) {
            case "/api/native/session":
                out = obj("ok", true, "scope", s.scope(), "userId", s.userId,
                        "deviceId", s.deviceId, "expiresAt", s.expiresAt);
                break;
            case "/api/native/profile":
                out = obj("ok", true, "id", s.userId, "name", s.profileName,
                        "email", s.profileEmail);
                break;
            case "/api/native/bootstrap":
                out = obj("ok", true, "workspaceId", s.workspaceId);
                break;
            case "/api/native/token":
                fail(proxy, rid, "offline-ready");
                return true;
            default: return false;
        }
        put(out, "t", "reply");
        put(out, "rid", rid);
        sendToPage(proxy, out);
        return true;
    }

    /** One checked commit writes the encrypted session and the selected-account pointer. */
    private boolean persistSession(Session s) {
        try {
            String scope = s.scope();
            String plain = obj("token", s.token, "sessionId", s.sessionId, "userId", s.userId,
                    "deviceId", s.deviceId, "expiresAt", s.expiresAt, "profile", s.profileName == null ? null
                    : obj("id", s.userId, "name", s.profileName, "email", s.profileEmail),
                    "zeroUrl", s.zeroUrl, "workspaceId", s.workspaceId, "verified", s.verified).toString();
            String blob = NativeSessionVault.encode(scope, plain);
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
            Session stored = session != null && session.scope().equals(s.scope())
                    ? session : restoreSession(s.context, true);
            if (stored != null && stored.scope().equals(s.scope()) && !sameSession(stored, s))
                return prefs.edit().remove(checkKey(s)).commit();
            if (stored == null && prefs.getString(blobKey(s.scope()), null) != null) return false;
            SharedPreferences.Editor editor = prefs.edit().remove(blobKey(s.scope())).remove(checkKey(s));
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
        return restoreSession(ctx, false);
    }

    private Session restoreSession(ServerContext ctx, boolean allowExpired) {
        String userId = prefs.getString(pointerKey(ctx), null);
        if (!validId(userId)) return null;
        String scope = ctx.scope(userId);
        String blob = prefs.getString(blobKey(scope), null);
        if (blob == null) return null;
        try {
            Map<String, Object> m = NativeSessionVault.decode(scope, userId, blob);
            String token = str(m.get("token"));
            Session restored = new Session(ctx, token, str(m.get("sessionId")), userId, str(m.get("deviceId")),
                    str(m.get("expiresAt")));
            Verification known = verification.get(checkKey(restored));
            if (!allowExpired && known != null && known.refused) return null;
            if (!allowExpired && !unexpired(restored.expiresAt)) return null;
            restoreProof(restored, m);
            // Keep credentials available for a live recheck, but never unlock cached rows
            // after interrupted verification or a known refusal whose deletion failed.
            if (prefs.getBoolean(checkKey(restored), false)) restored.verified = false;
            return restored;
        } catch (NativeSessionVault.KeyUnavailableException e) {
            return null;
        } catch (BadPaddingException | IllegalBlockSizeException
                 | IllegalArgumentException | IOException | Reject e) {
            if (!allowExpired) prefs.edit().remove(blobKey(scope)).remove(pointerKey(ctx)).commit();
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
    static Object parse(String s) throws IOException {
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
