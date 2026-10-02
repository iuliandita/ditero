package io.ditero.app;

import static org.junit.Assert.*;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NativeGoogleProviderTest {
    private Map<String,Object> key() throws Exception {
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return NativeRelayProtocol.publicJwk(generator.generateKeyPair().getPublic());
    }
    private Map<String,Object> config(String origin,Map<String,Object> key) {
        return Map.of("relayOrigin",origin,"receiptKeys",Map.of("receipt-1",key));
    }
    @Test public void unconfiguredProviderIsUnavailableAndRetirementDoesNotRegisterOrUnregister() throws Exception {
        NativePushProvider provider=new NativeGooglePushProvider(null,null,null);
        assertEquals("google",provider.id()); assertFalse(provider.available());
        assertNull(provider.relayOrigin()); assertTrue(provider.receiptKeys().isEmpty());
        provider.retire(new NativePushStore.Owner("old-owner",null));
        assertThrows(IllegalStateException.class,provider::appCheck);
    }
    @Test public void packagedPinsAreCopiedAndImmutable() throws Exception {
        Map<String,Object> jwk=new HashMap<>(key());
        Map<String,Object> pins=new HashMap<>(); pins.put("receipt-1",jwk);
        NativeGoogleConfiguration config=NativeGoogleConfiguration.parse(Map.of("relayOrigin","https://relay.example.test","receiptKeys",pins));
        assertNotNull(config); jwk.put("x","changed"); pins.clear();
        assertEquals("https://relay.example.test",config.relayOrigin); assertEquals(1,config.receiptKeys.size());
        assertThrows(UnsupportedOperationException.class,()->config.receiptKeys.clear());
        @SuppressWarnings("unchecked") Map<String,Object> pin=(Map<String,Object>)config.receiptKeys.get("receipt-1");
        assertNotEquals("changed",pin.get("x")); assertThrows(UnsupportedOperationException.class,()->pin.clear());
    }
    @Test public void configRejectsNavigationOriginsAndPrivateOrUnsupportedKeys() throws Exception {
        Map<String,Object> jwk=key();
        for(String origin:new String[]{"http://relay.example.test","https://user@relay.example.test","https://relay.example.test/",
                "https://relay.example.test/path","https://relay.example.test?query","https://relay.example.test#fragment",
                "https://Relay.example.test","https://relay.example.test:443","https://relay.example.test:0","https://relay.example.test:70000"}) {
            assertNull(origin,NativeGoogleConfiguration.parse(config(origin,jwk)));
        }
        Map<String,Object> privateKey=new HashMap<>(jwk); privateKey.put("d","secret");
        assertNull(NativeGoogleConfiguration.parse(config("https://relay.example.test",privateKey)));
        Map<String,Object> unsupported=new HashMap<>(jwk); unsupported.put("crv","P-384");
        assertNull(NativeGoogleConfiguration.parse(config("https://relay.example.test",unsupported)));
        assertNull(NativeGoogleConfiguration.parse(Map.of("relayOrigin","https://relay.example.test","receiptKeys",Map.of())));
        assertNull(NativeGoogleConfiguration.parse(Map.of("relayOrigin","https://relay.example.test","receiptKeys",Map.of("bad.kid",jwk))));
    }
}
