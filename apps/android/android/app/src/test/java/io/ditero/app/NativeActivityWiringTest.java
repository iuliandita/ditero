package io.ditero.app;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.junit.Test;

/**
 * The module has no Activity harness, so the two lifecycle call sites are pinned as source: the decisions they
 * pass to are unit-tested elsewhere, and a wrong argument here would defeat them.
 */
public class NativeActivityWiringTest {
    private String activity() throws Exception {
        return new String(Files.readAllBytes(Paths.get("src/main/java/io/ditero/app/MainActivity.java")), StandardCharsets.UTF_8);
    }

    @Test public void destroyTellsTheTransportWhetherTheActivityIsOnlyBeingRecreated() throws Exception {
        assertTrue(activity().contains("zeroTransport.drain(isChangingConfigurations());"));
    }

    @Test public void notificationTapsAreConsumedOnlyFromAFreshLaunch() throws Exception {
        assertTrue(activity().contains("NativeIntentIngress.launchable(savedInstanceState != null, launch.getFlags())"));
    }
}
