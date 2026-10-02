package io.ditero.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.JsonReader;
import android.util.JsonToken;
import org.json.JSONObject;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;

/** Shared encrypted session codec. No Activity, page, or JavaScript authority. */
final class NativeSessionVault {
    private static final String KEY_ALIAS = "io.ditero.app.native.session.v1";
    static final String PREFS = "ditero_native_session";
    static final String PREF_SELECTED = "selected";
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_.:-]{1,128}$");
    private static final Pattern BEARER = Pattern.compile("^[A-Za-z0-9\\-._~+/=]{1,512}$");
    private static final Pattern ISO = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T[0-9:.]{5,16}Z$");
    private final SharedPreferences prefs;

    NativeSessionVault(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    SharedPreferences preferences() { return prefs; }

    static String blobKey(String scope) { return "s." + hash(scope); }
    static String pointerKey(ServerContext context) { return "a." + hash(context.origin); }
    static String checkKey(String scope, String sessionId) { return "v." + hash(scope + "\n" + sessionId); }
    private static String hash(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte b : bytes) out.append(String.format(Locale.US, "%02x", b & 255));
            return out.toString();
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    static String encode(String scope, String plain) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, storeKey());
        cipher.updateAAD(aad(scope));
        byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return "v2." + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "." + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    static Map<String, Object> decode(String scope, String userId, String blob)
            throws GeneralSecurityException, IOException {
        // Acquire separately: unavailable Keystore must never erase stored credentials.
        SecretKey key;
        try { key = storeKey(); }
        catch (GeneralSecurityException | IOException | RuntimeException e) { throw new KeyUnavailableException(); }
        return decode(scope, userId, blob, key);
    }

    static final class KeyUnavailableException extends GeneralSecurityException {}

    private static Map<String, Object> decode(String scope, String userId, String blob, SecretKey key)
            throws GeneralSecurityException, IOException {
        String[] parts = blob.split("\\.", -1);
        if (parts.length != 3 || !parts[0].equals("v2")) throw new IOException("format");
        byte[] plain = decrypt(scope, Base64.decode(parts[1], Base64.NO_WRAP),
                Base64.decode(parts[2], Base64.NO_WRAP), key);
        Object parsed = parse(new String(plain, StandardCharsets.UTF_8));
        if (!(parsed instanceof Map)) throw new IOException("object");
        @SuppressWarnings("unchecked") Map<String, Object> record = (Map<String, Object>) parsed;
        validate(record, userId);
        return record;
    }

    static byte[] decrypt(String scope, byte[] iv, byte[] ciphertext, SecretKey key)
            throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad(scope));
        return cipher.doFinal(ciphertext);
    }

    static void validate(Map<String, Object> record, String userId) throws IOException {
        Object token = record.get("token");
        if (!(token instanceof String) || !BEARER.matcher((String) token).matches()
                || !userId.equals(record.get("userId"))
                || !validId(record.get("sessionId")) || !validId(record.get("deviceId"))
                || !(record.get("expiresAt") instanceof String)
                || !ISO.matcher((String) record.get("expiresAt")).matches()) throw new IOException("fields");
    }

    private static boolean validId(Object value) { return value instanceof String && ID.matcher((String) value).matches(); }

    static final class Proof {
        final String name, email, zeroUrl, workspaceId;
        private Proof(String name, String email, String zeroUrl, String workspaceId) {
            this.name=name; this.email=email; this.zeroUrl=zeroUrl; this.workspaceId=workspaceId;
        }
    }

    static Proof proof(String userId, Map<String, Object> record) {
        if (!Boolean.TRUE.equals(record.get("verified")) || !(record.get("profile") instanceof Map)) return null;
        Map<?, ?> profile = (Map<?, ?>) record.get("profile");
        Object name=profile.get("name"), email=profile.get("email"), workspace=record.get("workspaceId");
        if (!userId.equals(profile.get("id")) || !(name instanceof String) || ((String) name).length()>512
                || !(email instanceof String) || ((String) email).length()>512 || !validId(workspace)) return null;
        try {
            Object endpoint=record.get("zeroUrl");
            String zero=ServerContext.ZeroEndpoint.parse(endpoint instanceof String ? (String) endpoint : null).httpsUrl;
            return new Proof((String) name,(String) email,zero,(String) workspace);
        } catch (IllegalArgumentException e) { return null; }
    }

    /** Immutable native-only authority for the three fixed push routes. Recheck before dispatch and completion. */
    static final class CapturedOwner {
        final String scope, sessionId, userId, deviceId, expiresAt;
        private final ServerContext context;
        private final String token;
        private CapturedOwner(ServerContext context, Map<String, Object> record) {
            this.context=context; token=(String) record.get("token");
            sessionId=(String) record.get("sessionId"); userId=(String) record.get("userId");
            deviceId=(String) record.get("deviceId"); expiresAt=(String) record.get("expiresAt");
            scope=context.scope(userId);
        }
        Request pushConfigRequest() { return request("/api/native/push/config").get().build(); }
        Request pushRegisterRequest(String body) {
            return request("/api/native/push/register").post(RequestBody.create(body, MediaType.get("application/json; charset=utf-8"))).build();
        }
        Request pushUnregisterRequest() {
            return request("/api/native/push/unregister").post(RequestBody.create("{}", MediaType.get("application/json; charset=utf-8"))).build();
        }
        private Request.Builder request(String path) {
            return new Request.Builder().url(context.url(path)).header("Accept", "application/json")
                    .header("Authorization", "Bearer " + token);
        }
    }

    CapturedOwner capture() {
        String selected=prefs.getString(PREF_SELECTED,null);
        if(selected==null) return null;
        try {
            ServerContext context=ServerContext.parse(selected);
            if(!context.origin.equals(selected)) return null;
            String user=prefs.getString(pointerKey(context),null);
            if(!validId(user)) return null;
            String scope=context.scope(user), blob=prefs.getString(blobKey(scope),null);
            if(blob==null) return null;
            Map<String,Object> record=decode(scope,user,blob);
            return capture(context,record,prefs.getBoolean(checkKey(scope,(String)record.get("sessionId")),false));
        } catch(GeneralSecurityException|IOException|RuntimeException e) {return null;}
    }

    static CapturedOwner capture(ServerContext context, Map<String,Object> record, boolean verificationPending) throws IOException {
        Object user=record.get("userId");
        if(!validId(user)) return null;
        validate(record,(String)user);
        if(verificationPending || !unexpired((String)record.get("expiresAt")) || proof((String)user,record)==null) return null;
        return new CapturedOwner(context,record);
    }

    boolean isCurrent(CapturedOwner owner) {
        CapturedOwner current=capture();
        return sameOwner(owner,current);
    }

    static boolean sameOwner(CapturedOwner first, CapturedOwner second) {
        return first!=null && second!=null && first.scope.equals(second.scope)
                && first.sessionId.equals(second.sessionId) && first.deviceId.equals(second.deviceId)
                && first.token.equals(second.token) && unexpired(first.expiresAt);
    }
    private static SecretKey storeKey() throws GeneralSecurityException, IOException {
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

    static byte[] aad(String scope) {
        return ("ditero-native-session-v2\n" + scope).getBytes(StandardCharsets.UTF_8);
    }

    static boolean unexpired(String value) {
        if (value == null || !value.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z")) return false;
        String normalized = value.length() == 20 ? value.substring(0, 19) + ".000Z" : value;
        SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        parser.setLenient(false);
        parser.setTimeZone(TimeZone.getTimeZone("UTC"));
        ParsePosition position = new ParsePosition(0);
        Date parsed = parser.parse(normalized, position);
        return parsed != null && position.getIndex() == normalized.length()
                && parsed.getTime() > System.currentTimeMillis();
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
