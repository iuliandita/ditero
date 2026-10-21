package io.ditero.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeSettingsTest {
    @Test public void destinationsStayOnTheSelectedHttpsServer() {
        ServerContext server = ServerContext.parse("https://example.test:8443");
        for (String section : new String[]{"notifications", "security", "access-tokens", "calendar-feeds", "data", "danger"})
            assertEquals("https://example.test:8443/settings/" + section, server.settingsUrl(section));
        for (String section : new String[]{null, "", "../native/authorize", "https://other.test", "//other.test", "security?url=x", "security#x", "%73ecurity", "security/"}) {
            try { server.settingsUrl(section); fail("accepted: " + section); }
            catch (IllegalArgumentException expected) { }
        }
    }
}
