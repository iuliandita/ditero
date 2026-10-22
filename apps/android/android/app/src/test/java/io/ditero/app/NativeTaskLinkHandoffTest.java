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

    @Test public void helloReportsEveryDroppedHeldEntryOnce() {
        NativeTaskLinkHandoff boundToOldPage = new NativeTaskLinkHandoff();
        boundToOldPage.pending.offer(link(), null, "bound", 4);
        boundToOldPage.bindForHello(5, owner -> true);
        assertFalse(boundToOldPage.pending.occupied());
        assertTrue(boundToOldPage.takeRefused());
        assertFalse("reported once", boundToOldPage.takeRefused());

        NativeTaskLinkHandoff refusal = new NativeTaskLinkHandoff();
        refusal.pending.offerRefusal("refused", 4);
        refusal.bindForHello(5, owner -> true);
        assertTrue(refusal.takeRefused());

        NativeTaskLinkHandoff notOwned = new NativeTaskLinkHandoff();
        notOwned.pending.offer(link(), null, "cold", NativeTaskLink.UNBOUND);
        notOwned.bindForHello(5, owner -> false);
        assertTrue(notOwned.takeRefused());
    }

    @Test public void helloBindsAnOwnedColdLinkWithoutANotice() {
        NativeTaskLinkHandoff handoff = new NativeTaskLinkHandoff();
        handoff.pending.offer(link(), null, "cold", NativeTaskLink.UNBOUND);
        handoff.bindForHello(5, owner -> true);
        assertFalse(handoff.takeRefused());
        assertEquals("cold", handoff.pending.current(5, owner -> true).token);
        NativeTaskLinkHandoff empty = new NativeTaskLinkHandoff();
        empty.bindForHello(5, owner -> false);
        assertFalse(empty.takeRefused());
    }
}
