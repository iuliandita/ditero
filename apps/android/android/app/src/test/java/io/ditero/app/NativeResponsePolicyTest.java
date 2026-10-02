package io.ditero.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NativeResponsePolicyTest {
    @Test public void onlyTheExactNativeUnauthorizedResponseInvalidatesAuthority() {
        assertTrue(NativeResponsePolicy.confirmsUnauthorized(401, Collections.singletonMap("code", "unauthorized")));
        assertFalse(NativeResponsePolicy.confirmsUnauthorized(200, Collections.singletonMap("code", "unauthorized")));
        assertFalse(NativeResponsePolicy.confirmsUnauthorized(401, null));
        assertFalse(NativeResponsePolicy.confirmsUnauthorized(401, Collections.emptyMap()));
        assertFalse(NativeResponsePolicy.confirmsUnauthorized(401, Collections.singletonMap("code", "gateway-login")));
        Map<String, Object> intermediary = new HashMap<>();
        intermediary.put("code", "unauthorized");
        intermediary.put("login", "https://gateway.example.test");
        assertFalse(NativeResponsePolicy.confirmsUnauthorized(401, intermediary));
    }
}
