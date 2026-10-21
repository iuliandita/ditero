package io.ditero.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeTaskLinkHandoffTest {
    private NativeTaskLink link() {
        return NativeTaskLink.parse(NativeTaskLink.ACTION,
                "ditero://task?origin=https%3A%2F%2Fexample.test&taskId=task-1", false);
    }

    @Test public void configurationRecreationKeepsOnlyPreHandshakeIngress() {
        NativeTaskLinkHandoff handoff = new NativeTaskLinkHandoff();
        handoff.pending.offer(link(), null, "cold", NativeTaskLink.UNBOUND);
        handoff.refused = true;
        handoff.retire(true, false);
        assertTrue(handoff.pending.unbound());
        assertTrue(handoff.refused);
        assertTrue(handoff.pending.rebind(1, owner -> true));
        assertEquals("cold", handoff.pending.current(1, owner -> true).token);
        handoff.retire(true, true);
        assertFalse("a page-bound link never transfers to a replacement page", handoff.pending.occupied());
        assertTrue("the replacement page receives only an unavailable notice", handoff.refused);
    }

    @Test public void shutdownAndFinalDestructionDiscardUnboundLinksAndRefusals() {
        for (boolean finalDestruction : new boolean[]{false, true}) {
            NativeTaskLinkHandoff handoff = new NativeTaskLinkHandoff();
            handoff.pending.offer(link(), null, "cold", NativeTaskLink.UNBOUND);
            handoff.refused = true;
            if (finalDestruction) handoff.onCleared();
            else handoff.retire(false, false);
            assertFalse(handoff.pending.occupied());
            assertFalse(handoff.refused);
        }
    }
}
