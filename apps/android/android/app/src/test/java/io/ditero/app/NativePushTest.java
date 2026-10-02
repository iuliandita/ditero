package io.ditero.app;

import static org.junit.Assert.*;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NativePushTest {
    private byte[] json(String value) {return value.getBytes(StandardCharsets.UTF_8);}
    private String valid="{\"version\":\"1\",\"notificationId\":\"notification-1\",\"registrationId\":\"registration-1\"}";
    @Test public void onlyDecryptedExactOpaquePayloadIsAccepted() {
        assertEquals("notification-1",NativePushCoordinator.payload(json(valid),true).get("notificationId"));
        assertNull(NativePushCoordinator.payload(json(valid),false));
        assertNull(NativePushCoordinator.payload(json(valid.replace("\"1\"","1")),true));
        assertNull(NativePushCoordinator.payload(json(valid.replace("\"1\"","\"2\"")),true));
    }
    @Test public void duplicateAdditionalFieldsAndCallerNavigationAreRejected() {
        assertNull(NativePushCoordinator.payload(json(valid.replace("registrationId","notificationId")),true));
        assertNull(NativePushCoordinator.payload(json(valid.replace("}",",\"url\":\"https://example.test\"}")),true));
        assertNull(NativePushCoordinator.payload(json(valid.replace("notification-1","https://example.test")),true));
        assertNull(NativePushCoordinator.payload(json(valid+"{}"),true));
        assertNull(NativePushCoordinator.payload(json("\f"+valid),true));
        assertNotNull(NativePushCoordinator.payload(json(valid.replace(",",",\n")),true));
        assertNull(NativePushCoordinator.payload(json(valid.replace("notification-1","\\u0061")),true));
    }
    @Test public void malformedUtf8OversizeAndEmptyMessagesAreRejected() {
        assertNull(NativePushCoordinator.payload(new byte[]{(byte)0xc3,(byte)0x28},true));
        assertNull(NativePushCoordinator.payload(new byte[1025],true));
        assertNull(NativePushCoordinator.payload(new byte[0],true));
        assertNull(NativePushCoordinator.payload(null,true));
        assertNotNull(NativePushCoordinator.payload(json(" { \"registrationId\":\"r\", \"version\":\"1\", \"notificationId\":\"n\" } "),true));
    }
    private final Map<String,Object> durable=new HashMap<>();
    private boolean failCommit;
    private SharedPreferences prefs() {
        return (SharedPreferences)Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{SharedPreferences.class},(proxy,method,args)-> {
            switch(method.getName()) {
                case "getString": return durable.getOrDefault(args[0],args[1]);
                case "getBoolean": return durable.getOrDefault(args[0],args[1]);
                case "getAll": return new HashMap<>(durable);
                case "contains": return durable.containsKey(args[0]);
                case "edit":
                    Map<String,Object> puts=new HashMap<>(); java.util.Set<String> removes=new java.util.HashSet<>();
                    return Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{SharedPreferences.Editor.class},(editor,m,a)-> {
                        switch(m.getName()) {
                            case "putString": case "putBoolean": puts.put((String)a[0],a[1]); return editor;
                            case "remove": removes.add((String)a[0]); return editor;
                            case "commit": if(failCommit) return false; removes.forEach(durable::remove); durable.putAll(puts); return true;
                            default: throw new AssertionError(m.getName());
                        }
                    });
                default: throw new AssertionError(method.getName());
            }
        });
    }
    @Test public void retirementCommitsBeforeCleanupAndSurvivesStoreRecreation() {
        durable.put("active","old"); durable.put("old.blob","ciphertext");
        NativePushStore store=new NativePushStore(prefs(),null);
        assertTrue(store.retire());
        assertFalse(durable.containsKey("active"));
        assertEquals(true,durable.get("old.retired"));
        assertEquals("ciphertext",durable.get("old.blob"));
        NativePushStore reopened=new NativePushStore(prefs(),null);
        durable.put("active","replacement"); durable.put("replacement.blob","replacement ciphertext");
        assertTrue(reopened.clear("old"));
        assertEquals("replacement",durable.get("active"));
        assertEquals("replacement ciphertext",durable.get("replacement.blob"));
        assertFalse(durable.containsKey("old.retired"));
    }
    @Test public void failedRetirementAndCleanupPreserveRetryEvidence() {
        durable.put("active","old"); durable.put("old.blob","ciphertext");
        NativePushStore store=new NativePushStore(prefs(),null);
        failCommit=true; assertFalse(store.retire()); assertEquals("old",durable.get("active"));
        failCommit=false; assertTrue(store.retire());
        failCommit=true; assertFalse(store.clear("old"));
        assertEquals(true,durable.get("old.retired")); assertEquals("ciphertext",durable.get("old.blob"));
    }
    @Test public void dedupIsDurableBoundedAndIsolatedByEpoch() {
        NativePushStore.Owner old=new NativePushStore.Owner("old",null), replacement=new NativePushStore.Owner("new",null);
        NativePushStore store=new NativePushStore(prefs(),null);
        assertFalse(store.seen(old,"n-1"));
        assertTrue(new NativePushStore(prefs(),null).seen(old,"n-1"));
        assertFalse(store.seen(replacement,"n-1"));
        for(int i=2;i<=130;i++) assertFalse(store.seen(old,"n-"+i));
        assertFalse(store.seen(old,"n-1"));
        failCommit=true; assertTrue(store.seen(old,"n-failed"));
        assertFalse(durable.get("old.seen").toString().contains("n-failed"));
    }
}
