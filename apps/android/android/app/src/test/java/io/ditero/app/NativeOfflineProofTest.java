package io.ditero.app;

import static org.junit.Assert.*;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import android.content.SharedPreferences;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.ProtocolException;
import java.net.SocketException;
import java.net.UnknownServiceException;
import java.util.ArrayList;
import java.util.List;
import javax.net.ssl.SSLHandshakeException;
import okhttp3.MediaType;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;
import okio.Okio;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NativeOfflineProofTest {
    private final Class<?> sessionType = Class.forName("io.ditero.app.NativeZeroTransport$Session");

    public NativeOfflineProofTest() throws Exception {}

    private Object session(String expiry) throws Exception {
        return session(expiry, "session-1");
    }

    private Object session(String expiry, String id) throws Exception {
        Constructor<?> ctor = sessionType.getDeclaredConstructors()[0];
        ctor.setAccessible(true);
        return ctor.newInstance(ServerContext.parse("https://example.test"), "private-token", id,
                "user-1", "device-1", expiry);
    }

    private Map<String, Object> proof(String user, String endpoint) {
        Map<String, Object> out = new HashMap<>();
        out.put("verified", true);
        out.put("profile", Map.of("id", user, "name", "User", "email", "user@example.test"));
        out.put("zeroUrl", endpoint);
        out.put("workspaceId", "workspace-1");
        return out;
    }

    private boolean ready(Object session, Map<String, Object> proof) throws Exception {
        Method restore = NativeZeroTransport.class.getDeclaredMethod("restoreProof", sessionType, Map.class);
        restore.setAccessible(true);
        restore.invoke(null, session, proof);
        Method ready = NativeZeroTransport.class.getDeclaredMethod("offlineReady", sessionType);
        ready.setAccessible(true);
        return (boolean) ready.invoke(null, session);
    }

    @Test public void proofRequiresMatchingProfileAndValidHttpsConfiguration() throws Exception {
        assertTrue(ready(session("2099-01-01T00:00:00.000Z"), proof("user-1", "https://zero.example.test")));
        assertFalse(ready(session("2099-01-01T00:00:00Z"), proof("user-2", "https://zero.example.test")));
        assertFalse(ready(session("2099-01-01T00:00:00Z"), proof("user-1", "http://zero.example.test")));
        assertFalse(ready(session("2099-01-01T00:00:00Z"), Map.of()));
        Map<String, Object> missingBootstrap = proof("user-1", "https://zero.example.test");
        missingBootstrap.remove("workspaceId");
        assertFalse(ready(session("2099-01-01T00:00:00Z"), missingBootstrap));
    }

    @Test public void expiryAndKnownRefusalCannotUnlockOfflineRows() throws Exception {
        Map<String, Object> proof = proof("user-1", "https://zero.example.test");
        assertFalse(ready(session("2000-01-01T00:00:00Z"), proof));
        assertFalse(ready(session("2099-02-30T00:00:00Z"), proof));
        assertFalse(ready(session("2099-01-01T00:00:00Zgarbage"), proof));
        Object refused = session("2099-01-01T00:00:00Z");
        Field field = sessionType.getDeclaredField("refused");
        field.setAccessible(true);
        field.setBoolean(refused, true);
        assertFalse(ready(refused, proof));
    }
    @Test public void refusalMarkerSurvivesFailedCredentialDeletion() throws Exception {
        Class<?> unsafeType = Class.forName("sun.misc.Unsafe");
        Field singleton = unsafeType.getDeclaredField("theUnsafe");
        singleton.setAccessible(true);
        Object transport = unsafeType.getMethod("allocateInstance", Class.class)
                .invoke(singleton.get(null), NativeZeroTransport.class);
        Field verification = NativeZeroTransport.class.getDeclaredField("verification");
        verification.setAccessible(true);
        verification.set(transport, new HashMap<>());
        Field pendingLink = NativeZeroTransport.class.getDeclaredField("pendingLink");
        pendingLink.setAccessible(true);
        pendingLink.set(transport, new NativeTaskLink.Slot<>());
        Map<String, Object> durable = new HashMap<>();
        final boolean[] failCommit = {false};
        SharedPreferences.Editor editor = (SharedPreferences.Editor) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[]{SharedPreferences.Editor.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("putBoolean")) durable.put((String) args[0], args[1]);
                    if (method.getName().equals("remove") && !failCommit[0]) durable.remove((String) args[0]);
                    if (method.getName().equals("commit")) return !failCommit[0];
                    return proxy;
                });
        SharedPreferences prefs = (SharedPreferences) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[]{SharedPreferences.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("edit")) return editor;
                    if (method.getName().equals("getString")) return null;
                    throw new AssertionError(method.getName());
                });
        Field prefsField = NativeZeroTransport.class.getDeclaredField("prefs");
        prefsField.setAccessible(true);
        prefsField.set(transport, prefs);
        Object owner = session("2099-01-01T00:00:00Z");
        assertTrue(ready(owner, proof("user-1", "https://zero.example.test")));
        Method begin = NativeZeroTransport.class.getDeclaredMethod("beginCheck", sessionType);
        begin.setAccessible(true);
        assertTrue((boolean) begin.invoke(transport, owner));
        Method finish = NativeZeroTransport.class.getDeclaredMethod("finishCheck", sessionType, boolean.class);
        finish.setAccessible(true);
        Method key = NativeZeroTransport.class.getDeclaredMethod("checkKey", sessionType);
        key.setAccessible(true);
        // The settled network result of a stale request preserves verified proof and clears its marker.
        assertTrue((boolean) finish.invoke(transport, owner, true));
        assertFalse(durable.containsKey(key.invoke(transport, owner)));
        assertTrue(ready(owner, Map.of()));
        assertTrue((boolean) begin.invoke(transport, owner));
        Object late = session("2099-01-01T00:00:00Z");
        assertTrue(ready(late, proof("user-1", "https://zero.example.test")));
        assertTrue((boolean) begin.invoke(transport, late));
        Field refusedField = sessionType.getDeclaredField("refused");
        refusedField.setAccessible(true);
        refusedField.setBoolean(owner, true);
        assertFalse((boolean) finish.invoke(transport, owner, false));
        failCommit[0] = true;
        Method clear = NativeZeroTransport.class.getDeclaredMethod("clearPersisted", sessionType);
        clear.setAccessible(true);
        assertFalse((boolean) clear.invoke(transport, owner));
        // A pre-reload object's later network result cannot clear newer refusal knowledge.
        assertFalse((boolean) finish.invoke(transport, late, true));
        assertEquals(true, durable.get(key.invoke(transport, owner)));
        assertFalse(ready(owner, proof("user-1", "https://zero.example.test")));
    }

    @Test public void suppressedAndNestedPolicyRefusalsAreNeverOfflineFailures() throws Exception {
        Method classify = NativeZeroTransport.class.getDeclaredMethod("offlineFailure", IOException.class);
        classify.setAccessible(true);
        assertTrue((boolean) classify.invoke(null, new ConnectException("offline")));
        ConnectException routes = new ConnectException("first route failed");
        IOException nested = new IOException("second route");
        nested.addSuppressed(new SSLHandshakeException("certificate refused"));
        routes.addSuppressed(nested);
        assertFalse((boolean) classify.invoke(null, routes));
        assertFalse((boolean) classify.invoke(null, new IOException("wrapped", new ProtocolException("bad HTTP"))));
        assertFalse((boolean) classify.invoke(null, new UnknownServiceException("cleartext refused")));
        IOException first = new IOException("a"), second = new IOException("b");
        first.initCause(second);
        second.initCause(first);
        assertTrue((boolean) classify.invoke(null, first));
    }

    @Test public void truncatedUnauthorizedBodyRetainsStatusWithoutConfirmingRefusal() throws Exception {
        ResponseBody body = new ResponseBody() {
            @Override public MediaType contentType() { return MediaType.get("application/json"); }
            @Override public long contentLength() { return -1; }
            @Override public BufferedSource source() {
                return Okio.buffer(Okio.source(new InputStream() {
                    @Override public int read() throws IOException { throw new SocketException("body reset"); }
                }));
            }
        };
        try (Response response = new Response.Builder().request(new Request.Builder().url("https://example.test").build())
                .protocol(Protocol.HTTP_1_1).code(401).message("Unauthorized").body(body).build()) {
            Method read = NativeZeroTransport.class.getDeclaredMethod("readResponse", Response.class);
            read.setAccessible(true);
            Object result = read.invoke(null, response);
            assertNotNull(result);
            Field status = result.getClass().getDeclaredField("code"), raw = result.getClass().getDeclaredField("body");
            status.setAccessible(true);
            raw.setAccessible(true);
            assertEquals(401, status.getInt(result));
            assertNull(raw.get(result));
            Method refused = NativeZeroTransport.class.getDeclaredMethod("instanceUnauthorized", result.getClass());
            refused.setAccessible(true);
            assertFalse((boolean) refused.invoke(null, result));
        }
    }

    @Test public void capturedRefusalCannotEraseTheReplacementSession() throws Exception {
        Class<?> unsafeType = Class.forName("sun.misc.Unsafe");
        Field singleton = unsafeType.getDeclaredField("theUnsafe");
        singleton.setAccessible(true);
        Object transport = unsafeType.getMethod("allocateInstance", Class.class)
                .invoke(singleton.get(null), NativeZeroTransport.class);
        List<String> removed = new ArrayList<>();
        SharedPreferences.Editor editor = (SharedPreferences.Editor) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[]{SharedPreferences.Editor.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("remove")) removed.add((String) args[0]);
                    if (method.getName().equals("commit")) return true;
                    return proxy;
                });
        SharedPreferences prefs = (SharedPreferences) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[]{SharedPreferences.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("edit")) return editor;
                    throw new AssertionError(method.getName());
                });
        Field prefsField = NativeZeroTransport.class.getDeclaredField("prefs");
        prefsField.setAccessible(true);
        prefsField.set(transport, prefs);
        Field live = NativeZeroTransport.class.getDeclaredField("session");
        live.setAccessible(true);
        Object replacement = session("2099-01-01T00:00:00Z", "session-2");
        live.set(transport, replacement);
        Object captured = session("2099-01-01T00:00:00Z");
        Method drop = NativeZeroTransport.class.getDeclaredMethod("dropSession", sessionType);
        drop.setAccessible(true);
        drop.invoke(transport, captured);
        assertSame(replacement, live.get(transport));
        Method key = NativeZeroTransport.class.getDeclaredMethod("checkKey", sessionType);
        key.setAccessible(true);
        assertEquals(List.of(key.invoke(transport, captured)), removed);
    }

}
