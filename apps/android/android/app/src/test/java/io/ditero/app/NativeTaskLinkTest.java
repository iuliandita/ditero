package io.ditero.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeTaskLinkTest {
    private static final String LINK="ditero://task?origin=https%3A%2F%2Fexample.test&taskId=task%3A1";
    private NativeTaskLink parse(String value) {return NativeTaskLink.parse(NativeTaskLink.ACTION,value,false);}

    @Test public void onlyTaskIdentityAndCanonicalHttpsOriginAreAccepted() {
        NativeTaskLink link=parse(LINK);
        assertNotNull(link); assertEquals("https://example.test",link.origin); assertEquals("task:1",link.taskId);
    }
    @Test public void encodingCaseFieldOrderAndPortsAreAccepted() {
        assertEquals("task:1",parse(LINK.replace("%3A1","%3a1")).taskId);
        NativeTaskLink swapped=parse("ditero://task?taskId=task-1&origin=https%3A%2F%2Fexample.test%3A8443");
        assertNotNull(swapped); assertEquals("https://example.test:8443",swapped.origin); assertEquals("task-1",swapped.taskId);
        assertEquals("a".repeat(128),parse(LINK.replace("task%3A1","a".repeat(128))).taskId);
        assertEquals("a.b_c:d-e",parse(LINK.replace("task%3A1","a.b_c%3Ad-e")).taskId);
    }
    @Test public void actionExtrasAndMissingInputAreRefused() {
        assertNull(NativeTaskLink.parse(NativePushOpen.ACTION,LINK,false));
        assertNull(NativeTaskLink.parse("android.intent.action.MAIN",LINK,false));
        assertNull(NativeTaskLink.parse(null,LINK,false));
        assertNull(NativeTaskLink.parse(NativeTaskLink.ACTION,LINK,true));
        assertNull(NativeTaskLink.parse(NativeTaskLink.ACTION,null,false));
    }
    @Test public void schemeAuthorityAndFragmentNormalizationAreRefused() {
        for(String value:new String[]{LINK.replace("ditero:","DITERO:"),LINK.replace("ditero:","https:"),LINK.replace("task?","TASK?"),
                LINK.replace("task?","task/?"),LINK.replace("task?","task/x?"),LINK.replace("task?","user@task?"),
                LINK.replace("task?","task:9?"),LINK.replace("task?","other?"),LINK.replace("ditero://","ditero:/"),
                LINK.replace("task?",""),"ditero://task",LINK+"#fragment",LINK+"#",LINK.replace("ditero:","ditero:\\"),
                LINK.replace("&taskId","\\&taskId")}) assertNull(value,parse(value));
    }
    @Test public void unknownDuplicateAndMalformedFieldsAreRefused() {
        for(String value:new String[]{LINK+"&token=secret",LINK+"&taskId=other",LINK+"&origin=https%3A%2F%2Fother.test",
                LINK+"&",LINK+"&x",LINK.replace("&taskId","&&taskId"),"ditero://task?","ditero://task?&",
                "ditero://task?origin=https%3A%2F%2Fexample.test","ditero://task?taskId=task%3A1",
                "ditero://task?origin&taskId=task%3A1","ditero://task?origin=https%3A%2F%2Fexample.test&taskId",
                LINK.replace("taskId","%74askId"),LINK.replace("taskId","taskid"),LINK.replace("origin","Origin"),
                LINK.replace("origin","server"),LINK.replace("taskId","id")}) assertNull(value,parse(value));
    }
    @Test public void nonCanonicalOrCredentialBearingOriginsAreRefused() {
        for(String origin:new String[]{"http%3A%2F%2Fexample.test","https%3A%2F%2Fexample.test%2Fpath","https%3A%2F%2Fexample.test%2F",
                "https%3A%2F%2Fexample.test%3Fq%3Dx","https%3A%2F%2Fexample.test%3A443","https%3A%2F%2FEXAMPLE.test",
                "HTTPS%3A%2F%2Fexample.test","https%3A%2F%2Fuser%40example.test","https%3A%2F%2Fexample.test%3A0",
                "https%3A%2F%2Fexample.test%3A65536","https%3A%2F%2F%5B%3A%3A1%5D","https%3A%2F%2Fexample.test%23x",
                "https%3A%2F%2F","example.test","","https%253A%252F%252Fexample.test"})
            assertNull(origin,parse(LINK.replace("https%3A%2F%2Fexample.test",origin)));
    }
    @Test public void badTaskIdsAndDoubleEncodingAreRefused() {
        for(String id:new String[]{"..",".","","task%253A1","task+1","%FF","%C3%A9","%C3","%00","%0A","%20","%2F","%G0","%0G","%A","%","task%",
                "task%3","a".repeat(129),"task/1","task 1","é"}) assertNull(id,parse(LINK.replace("task%3A1",id)));
    }
    @Test public void invalidUtf8AndControlCharactersInTheOriginAreRefused() {
        for(String origin:new String[]{"https%3A%2F%2Fexample.test%FF","https%3A%2F%2Fexample.test%0A","https%3A%2F%2Fexample.test%00",
                "https%3A%2F%2Fexa%C3%A9mple.test","https%3A%2F%2Fexample.test%C3"})
            assertNull(origin,parse(LINK.replace("https%3A%2F%2Fexample.test",origin)));
    }
    @Test public void whitespaceControlNonAsciiAndOversizeInputAreRefused() {
        for(String value:new String[]{" "+LINK,LINK+" ",LINK+"\n","\n"+LINK,LINK+"\t",LINK+"\u007f",LINK+"\u0000",LINK+"é",
                LINK.replace("example","exa mple"),LINK+"a".repeat(2048),LINK.replace("task%3A1","a".repeat(2048))})
            assertNull(value,parse(value));
        String atLimit=LINK.substring(0,LINK.indexOf("&taskId="))+"&taskId="+"a".repeat(2048-LINK.indexOf("&taskId=")-"&taskId=".length());
        assertEquals(2048,atLimit.length());
        assertNull("id longer than 128",parse(atLimit));
    }
    @Test public void plusIsNeverASpaceAndPercentDecodesOnce() {
        assertNull(parse(LINK.replace("task%3A1","a+b")));
        assertNull(parse(LINK.replace("task%3A1","a%2Bb")));
        assertNull(parse(LINK.replace("task%3A1","%2541")));
        assertNull(parse(LINK.replace("https%3A%2F%2Fexample.test","https%3A%2F%2Fexample%2Etest%2Fx")));
    }

    private static final class Owner {}
    private static final NativeTaskLink.Slot.Owns<Owner> ALWAYS=owner -> true;
    private static final NativeTaskLink.Slot.Owns<Owner> NEVER=owner -> false;

    @Test public void secondLinkIsRefusedAndTheFirstStays() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        Owner owner=new Owner();
        assertFalse(slot.occupied());
        assertTrue(slot.offer(parse(LINK),owner,"first",1));
        assertFalse(slot.offer(parse(LINK.replace("task%3A1","task%3A2")),owner,"second",1));
        NativeTaskLink.Pending<Owner> current=slot.current(1,ALWAYS);
        assertEquals("first",current.token); assertEquals("task:1",current.link.taskId); assertSame(owner,current.owner);
    }
    @Test public void coldLinkIsUnreadableUntilHelloBindsItToTheNewGeneration() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        assertTrue(slot.offer(parse(LINK),new Owner(),"t",NativeTaskLink.UNBOUND));
        assertTrue(slot.occupied());
        assertTrue(slot.rebind(1,ALWAYS));
        assertEquals("t",slot.current(1,ALWAYS).token);
    }
    @Test public void unboundLinkIsNeverReadable() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"t",NativeTaskLink.UNBOUND);
        assertNull(slot.current(1,ALWAYS)); assertFalse(slot.occupied());
    }
    @Test public void helloDropsALinkTheRestoredSessionDoesNotOwn() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"t",NativeTaskLink.UNBOUND);
        assertFalse(slot.rebind(1,NEVER)); assertFalse(slot.occupied());
        assertFalse("nothing pending, nothing kept",slot.rebind(2,ALWAYS));
        assertFalse(slot.occupied());
    }
    @Test public void pageReplacementAndOwnerChangeRetireTheLink() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"t",3);
        assertNull(slot.current(4,ALWAYS)); assertFalse(slot.occupied());
        slot.offer(parse(LINK),new Owner(),"t",3);
        assertNull(slot.current(3,NEVER)); assertFalse(slot.occupied());
        assertTrue(slot.offer(parse(LINK),new Owner(),"again",3));
    }
    @Test public void ownerIsRecheckedOnEveryRead() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"t",1);
        boolean[] owned={true};
        NativeTaskLink.Slot.Owns<Owner> owns=owner -> owned[0];
        assertNotNull(slot.current(1,owns));
        owned[0]=false;
        assertNull(slot.current(1,owns));
        owned[0]=true;
        assertNull("a link retired by a failed recheck does not come back",slot.current(1,owns));
    }
    @Test public void dismissConsumesOnlyTheMatchingTokenOnce() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        assertFalse("nothing pending",slot.dismiss("t"));
        slot.offer(parse(LINK),new Owner(),"t",1);
        assertFalse(slot.dismiss("other")); assertTrue(slot.occupied());
        assertTrue(slot.dismiss("t")); assertFalse(slot.occupied());
        assertFalse(slot.dismiss("t"));
        assertNull(slot.current(1,ALWAYS));
    }
    private static final NativeTaskLink.Slot.Judge<Owner> OWNED=owner -> NativeTaskLink.Standing.OWNED;
    private static final NativeTaskLink.Slot.Judge<Owner> STALE=owner -> NativeTaskLink.Standing.STALE;
    private static final NativeTaskLink.Slot.Judge<Owner> UNVERIFIED=owner -> NativeTaskLink.Standing.UNVERIFIED;

    @Test public void rebindOnlyAttachesAColdLinkAndDropsOneBoundToAnEarlierPage() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"t",1);
        assertFalse("a link delivered to the old page does not reopen on the reload",slot.rebind(2,ALWAYS));
        assertFalse(slot.occupied()); assertNull(slot.current(1,ALWAYS)); assertNull(slot.current(2,ALWAYS));
        slot.offer(parse(LINK),new Owner(),"cold",NativeTaskLink.UNBOUND);
        assertTrue(slot.unbound());
        assertTrue(slot.rebind(2,ALWAYS)); assertFalse(slot.unbound());
        assertNull("the old generation stays invalid",slot.current(1,ALWAYS));
    }
    @Test public void rebindOnceLeavesNoSecondBinding() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"cold",NativeTaskLink.UNBOUND);
        assertTrue(slot.rebind(2,ALWAYS));
        assertFalse("a bound link is not carried to a third page",slot.rebind(3,ALWAYS));
        assertNull(slot.current(3,ALWAYS));
    }
    @Test public void aRefusalIsOneUseNeedsNoOwnerAndDiesWithItsPage() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        assertTrue(slot.offerRefusal("r",2));
        assertFalse("never queued behind or over another entry",slot.offerRefusal("r2",2));
        NativeTaskLink.Pending<Owner> refusal=slot.current(2,NEVER);
        assertNotNull(refusal); assertTrue(refusal.refusal()); assertNull(refusal.taskId()); assertEquals("r",refusal.token);
        assertFalse(slot.dismiss("other")); assertTrue(slot.occupied());
        assertTrue(slot.dismiss("r")); assertNull(slot.current(2,ALWAYS));
        slot.offerRefusal("r3",2);
        assertNull("a reload does not replay an old refusal",slot.current(3,ALWAYS)); assertFalse(slot.occupied());
        slot.offerRefusal("r4",2);
        assertFalse(slot.rebind(3,ALWAYS)); assertFalse(slot.occupied());
    }
    @Test public void dismissIsIdempotentAndAnOldTokenCannotClearANewEntry() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        assertFalse(slot.dismiss("")); assertFalse(slot.dismiss("unknown"));
        slot.offer(parse(LINK),new Owner(),"old",1);
        assertTrue(slot.dismiss("old")); assertFalse("repeat is a no-op",slot.dismiss("old"));
        slot.offer(parse(LINK.replace("task%3A1","task%3A2")),new Owner(),"new",1);
        assertFalse(slot.dismiss("old")); assertFalse(slot.dismiss(""));
        assertEquals("new",slot.current(1,ALWAYS).token);
    }
    @Test public void settleDropsAStaleOwnerSoANewLinkIsAccepted() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"first",1);
        assertFalse(slot.settle(1,STALE,OWNED)); assertFalse(slot.occupied());
        assertTrue(slot.offer(parse(LINK),new Owner(),"second",1));
        assertEquals("second",slot.current(1,ALWAYS).token);
    }
    @Test public void settleKeepsAnOwnedOrMidVerificationLinkAndItsToken() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"first",1);
        assertTrue(slot.settle(1,OWNED,STALE)); assertTrue("a transient check loses nothing",slot.settle(1,UNVERIFIED,STALE));
        assertFalse(slot.offer(parse(LINK),new Owner(),"second",1));
        assertEquals("first",slot.current(1,ALWAYS).token);
    }
    @Test public void settleDropsAnEntryBoundToAnotherPageButKeepsAColdOne() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"old",1);
        assertFalse(slot.settle(2,OWNED,OWNED));
        slot.offer(parse(LINK),new Owner(),"cold",NativeTaskLink.UNBOUND);
        assertTrue(slot.settle(2,STALE,OWNED)); assertTrue(slot.unbound());
        assertFalse("a cold link whose owner went stale is dropped",slot.settle(2,OWNED,STALE));
    }
    @Test public void aColdLinkIsJudgedByTheColdJudgeNotThePageJudge() {
        // Before hello the page judge has no context and reads STALE; that must not drop a still-owned cold link.
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"first",NativeTaskLink.UNBOUND);
        assertTrue(slot.settle(1,STALE,OWNED)); assertFalse(slot.offer(parse(LINK),new Owner(),"second",NativeTaskLink.UNBOUND));
        assertTrue("an in-flight check keeps it",slot.settle(1,STALE,UNVERIFIED));
        assertTrue(slot.rebind(1,ALWAYS));
        assertEquals("the first token survives to hello","first",slot.current(1,ALWAYS).token);
    }
    @Test public void aBoundLinkIsStillJudgedByThePageJudge() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"warm",1);
        assertFalse("the cold judge never rescues a bound link",slot.settle(1,STALE,OWNED));
    }
    @Test public void aLinkRefusedBehindAnotherIsOwedOnlyOnceTheFirstIsConsumed() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"first",1);
        slot.noteBusy();
        assertFalse("not while the first is pending",slot.takeOwedRefusal());
        assertFalse(slot.dismiss("wrong")); assertFalse(slot.takeOwedRefusal());
        assertTrue(slot.dismiss("first"));
        assertTrue(slot.takeOwedRefusal()); assertFalse("owed once",slot.takeOwedRefusal());
        slot.offer(parse(LINK),new Owner(),"again",1);
        slot.noteBusy(); slot.clear();
        assertFalse("a cleared slot owes nothing",slot.takeOwedRefusal());
    }
    @Test public void aDeferredLinkIsNeverReadableUntilPromotedByLiveVerification() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        assertTrue(slot.defer(parse(LINK),"d",2));
        assertTrue(slot.occupied()); assertTrue(slot.deferred());
        assertNull("not delivered meanwhile",slot.current(2,ALWAYS)); assertTrue(slot.deferred());
        assertTrue("an in-flight check is not stale",slot.settle(2,STALE,STALE));
        assertFalse(slot.offer(parse(LINK),new Owner(),"other",2));
        assertFalse(slot.promote(null));
        Owner owner=new Owner();
        assertTrue(slot.promote(owner)); assertFalse(slot.deferred());
        NativeTaskLink.Pending<Owner> open=slot.current(2,ALWAYS);
        assertEquals("d",open.token); assertEquals("task:1",open.taskId()); assertSame(owner,open.owner);
        assertFalse("only a deferred link promotes",slot.promote(new Owner()));
    }
    @Test public void aDeferredLinkThatFailsVerificationBecomesAVisibleRefusalUnderTheSameToken() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        assertFalse(slot.refuseDeferred());
        slot.defer(parse(LINK),"d",2);
        assertTrue(slot.refuseDeferred());
        NativeTaskLink.Pending<Owner> refusal=slot.current(2,NEVER);
        assertTrue(refusal.refusal()); assertNull(refusal.taskId()); assertEquals("d",refusal.token);
    }
    @Test public void aDeferredLinkDoesNotSurviveAnotherPageOrAReload() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.defer(parse(LINK),"d",2);
        assertNull(slot.current(3,ALWAYS)); assertFalse(slot.occupied());
        slot.defer(parse(LINK),"d",2);
        assertFalse(slot.rebind(3,ALWAYS)); assertFalse(slot.occupied());
    }
    @Test public void aSelectorClipOrMimePayloadIsStillRefused() {
        assertNull(NativeTaskLink.parse(NativeTaskLink.ACTION,LINK,true));
        assertNotNull("plain extras are the caller's to ignore",NativeTaskLink.parse(NativeTaskLink.ACTION,LINK,false));
    }
    @Test public void clearDropsThePendingLink() {
        NativeTaskLink.Slot<Owner> slot=new NativeTaskLink.Slot<>();
        slot.offer(parse(LINK),new Owner(),"t",1);
        slot.clear(); assertFalse(slot.occupied()); assertNull(slot.current(1,ALWAYS));
        slot.clear();
    }
}
