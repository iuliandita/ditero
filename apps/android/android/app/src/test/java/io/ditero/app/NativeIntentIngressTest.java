package io.ditero.app;

import static org.junit.Assert.*;
import android.content.Intent;
import org.junit.Test;

public class NativeIntentIngressTest {
    @Test public void onlyAFreshLaunchIsConsumed() {
        assertTrue(NativeIntentIngress.launchable(false, 0));
        assertTrue(NativeIntentIngress.launchable(false, Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Test public void recreatedOrRecentsRelaunchedActivitiesDoNotReplayTheLaunchIntent() {
        assertFalse(NativeIntentIngress.launchable(true, 0));
        assertFalse(NativeIntentIngress.launchable(false, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY));
        assertFalse(NativeIntentIngress.launchable(true, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY));
    }
}
