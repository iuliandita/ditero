package io.ditero.app;

import static io.ditero.app.NativeTaskLink.Standing.*;
import static io.ditero.app.NativeTaskLinkPolicy.Intake.*;
import static org.junit.Assert.*;
import org.junit.Test;

public class NativeTaskLinkPolicyTest {
    @Test public void closedTransportIgnoresEverything() {
        for (boolean live : new boolean[]{false, true})
            for (boolean fenced : new boolean[]{false, true})
                for (boolean signedIn : new boolean[]{false, true})
                    assertEquals(IGNORE, NativeTaskLinkPolicy.intake(true, live, fenced, signedIn));
    }

    @Test public void fencedIngressIsRefusedVisiblyOnlyWhenAPageCanHearIt() {
        assertEquals(REFUSE, NativeTaskLinkPolicy.intake(false, true, true, true));
        assertEquals(REFUSE, NativeTaskLinkPolicy.intake(false, true, true, false));
        assertEquals(IGNORE, NativeTaskLinkPolicy.intake(false, false, true, true));
    }

    @Test public void signedOutLivePageRefusesInsteadOfStayingSilent() {
        assertEquals(REFUSE, NativeTaskLinkPolicy.intake(false, true, false, false));
        assertEquals(PROCEED, NativeTaskLinkPolicy.intake(false, true, false, true));
    }

    @Test public void coldStartProceedsWhateverTheSessionIs() {
        assertEquals(PROCEED, NativeTaskLinkPolicy.intake(false, false, false, false));
        assertEquals(PROCEED, NativeTaskLinkPolicy.intake(false, false, false, true));
    }

    @Test public void failedVerificationWithNoCheckPendingIsStaleNotUnverified() {
        assertEquals(STALE, NativeTaskLinkPolicy.standing(true, true, true, false, false, () -> true));
        assertEquals(UNVERIFIED, NativeTaskLinkPolicy.standing(true, true, true, false, true, () -> true));
    }

    @Test public void standingIsStaleWhenTheHostMovedOnOrTheAccountDiffers() {
        assertEquals(STALE, NativeTaskLinkPolicy.standing(false, true, true, true, false, () -> true));
        assertEquals(STALE, NativeTaskLinkPolicy.standing(true, false, true, true, false, () -> true));
        assertEquals(STALE, NativeTaskLinkPolicy.standing(true, true, false, true, true, () -> true));
    }

    @Test public void verifiedSessionIsOwnedOnlyWhenTheStoredRecordAgrees() {
        assertEquals(OWNED, NativeTaskLinkPolicy.standing(true, true, true, true, false, () -> true));
        assertEquals(STALE, NativeTaskLinkPolicy.standing(true, true, true, true, false, () -> false));
    }

    @Test public void storedRecordIsReadOnlyForAVerifiedSession() {
        NativeTaskLinkPolicy.standing(true, true, true, false, true, () -> {
            throw new AssertionError("an unverified session must not consult the vault");
        });
    }

    @Test public void noticesAreCoalescedPerGenerationAndWindow() {
        NativeTaskLinkPolicy.NoticeThrottle throttle = new NativeTaskLinkPolicy.NoticeThrottle();
        assertTrue(throttle.allow(3, 1_000));
        assertFalse("a repeat inside the window is dropped", throttle.allow(3, 1_001));
        assertFalse(throttle.allow(3, 1_000 + NativeTaskLinkPolicy.NOTICE_WINDOW_MS - 1));
        assertTrue("the window reopens", throttle.allow(3, 1_000 + NativeTaskLinkPolicy.NOTICE_WINDOW_MS));
        assertTrue("a new page generation hears its first notice", throttle.allow(4, 1_000 + NativeTaskLinkPolicy.NOTICE_WINDOW_MS + 1));
    }
}
