package io.ditero.app;

import static org.junit.Assert.*;
import org.junit.Test;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import android.content.SharedPreferences;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import okhttp3.Request;

public class NativeSessionVaultTest {
    private final ServerContext context = ServerContext.parse("https://example.test");
    private Map<String, Object> record() {
        Map<String, Object> record = new HashMap<>();
        record.put("token", "private-token"); record.put("userId", "user-1");
        record.put("sessionId", "session-1"); record.put("deviceId", "device-1");
        record.put("expiresAt", "2099-01-01T00:00:00Z"); record.put("verified", true);
        record.put("profile", Map.of("id", "user-1", "name", "User", "email", "user@example.test"));
        record.put("zeroUrl", "https://zero.example.test"); record.put("workspaceId", "workspace-1");
        return record;
    }
    @Test public void existingAadBindsCiphertextToExactOriginAndAccount() throws Exception {
        String scope = context.scope("user-1");
        assertArrayEquals(("ditero-native-session-v2\n" + scope).getBytes(StandardCharsets.UTF_8), NativeSessionVault.aad(scope));
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256);
        SecretKey key = generator.generateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(NativeSessionVault.aad(scope));
        byte[] original = "session fixture".getBytes(StandardCharsets.UTF_8);
        byte[] encrypted = cipher.doFinal(original);
        assertArrayEquals(original, NativeSessionVault.decrypt(scope, cipher.getIV(), encrypted, key));
        assertThrows(AEADBadTagException.class, () -> NativeSessionVault.decrypt(context.scope("user-2"), cipher.getIV(), encrypted, key));
        String anotherServer = ServerContext.parse("https://another.example.test").scope("user-1");
        assertThrows(AEADBadTagException.class, () -> NativeSessionVault.decrypt(anotherServer, cipher.getIV(), encrypted, key));
        encrypted[0] ^= 1;
        assertThrows(AEADBadTagException.class, () -> NativeSessionVault.decrypt(scope, cipher.getIV(), encrypted, key));
    }
    @Test public void captureRequiresCompleteExactProofAndNoVerificationMarker() throws Exception {
        Map<String, Object> record = record();
        assertNotNull(NativeSessionVault.capture(context, record, false));
        assertNull(NativeSessionVault.capture(context, record, true));
        record.put("profile", Map.of("id", "user-2", "name", "Other", "email", "other@example.test"));
        assertNull(NativeSessionVault.capture(context, record, false));
        record = record(); record.put("zeroUrl", "http://zero.example.test");
        assertNull(NativeSessionVault.capture(context, record, false));
        record = record(); record.remove("workspaceId"); assertNull(NativeSessionVault.capture(context, record, false));
        record = record(); record.put("expiresAt", "2000-01-01T00:00:00Z"); assertNull(NativeSessionVault.capture(context, record, false));
        record = record(); record.put("expiresAt", "2099-02-30T00:00:00Z"); assertNull(NativeSessionVault.capture(context, record, false));
    }
    @Test public void validationRefusesMalformedCredentialsAndWrongAccount() throws Exception {
        Map<String, Object> record = record(); NativeSessionVault.validate(record, "user-1");
        assertThrows(IOException.class, () -> NativeSessionVault.validate(record, "user-2"));
        record.put("token", "Bearer injected\r\n"); assertThrows(IOException.class, () -> NativeSessionVault.validate(record, "user-1"));
        record.put("token", "private-token"); record.put("deviceId", "invalid id");
        assertThrows(IOException.class, () -> NativeSessionVault.validate(record, "user-1"));
    }
    @Test public void capturedOwnerIsImmutableAndCannotFollowReplacementAuthority() throws Exception {
        Map<String, Object> record = record();
        NativeSessionVault.CapturedOwner captured = NativeSessionVault.capture(context, record, false);
        assertTrue(NativeSessionVault.sameOwner(captured, NativeSessionVault.capture(context, record, false)));
        record.put("token", "replacement-token"); assertFalse(NativeSessionVault.sameOwner(captured, NativeSessionVault.capture(context, record, false)));
        record.put("token", "private-token"); record.put("sessionId", "session-2");
        assertFalse(NativeSessionVault.sameOwner(captured, NativeSessionVault.capture(context, record, false)));
        record.put("sessionId", "session-1"); record.put("deviceId", "device-2");
        assertFalse(NativeSessionVault.sameOwner(captured, NativeSessionVault.capture(context, record, false)));
        assertFalse(NativeSessionVault.sameOwner(captured, null));
        Request config = captured.pushConfigRequest();
        assertEquals("https://example.test/api/native/push/config", config.url().toString());
        assertEquals("Bearer private-token", config.header("Authorization"));
        assertNull(config.header("Cookie")); assertNull(config.header("Origin"));
        assertEquals("POST", captured.pushRegisterRequest("{}").method());
        assertEquals("https://example.test/api/native/push/register", captured.pushRegisterRequest("{}").url().toString());
        assertEquals("https://example.test/api/native/push/unregister", captured.pushUnregisterRequest().url().toString());
        assertEquals("session-1", captured.sessionId);
    }
    @Test public void unavailableKeystoreNeverDeletesEncryptedRecord() throws Exception {
        Class<?> unsafeType = Class.forName("sun.misc.Unsafe");
        Field singleton = unsafeType.getDeclaredField("theUnsafe"); singleton.setAccessible(true);
        Object transport = unsafeType.getMethod("allocateInstance", Class.class).invoke(singleton.get(null), NativeZeroTransport.class);
        AtomicBoolean edited = new AtomicBoolean();
        SharedPreferences prefs = (SharedPreferences) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{SharedPreferences.class}, (proxy, method, args) -> {
            if (method.getName().equals("getString")) return ((String) args[0]).startsWith("a.") ? "user-1" : "v2.unavailable";
            if (method.getName().equals("edit")) { edited.set(true); throw new AssertionError("unavailable keystore must preserve record"); }
            throw new AssertionError(method.getName());
        });
        Field prefsField = NativeZeroTransport.class.getDeclaredField("prefs"); prefsField.setAccessible(true); prefsField.set(transport, prefs);
        Method restore = NativeZeroTransport.class.getDeclaredMethod("restoreSession", ServerContext.class, boolean.class); restore.setAccessible(true);
        assertNull(restore.invoke(transport, context, false)); assertFalse(edited.get());
    }
}
