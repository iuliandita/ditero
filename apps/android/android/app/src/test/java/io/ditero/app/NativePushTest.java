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

    private NativeSessionVault.CapturedOwner captured(String session) throws Exception {
        Map<String,Object> record=new HashMap<>();
        record.put("token","private-token"); record.put("sessionId",session); record.put("userId","user-1");
        record.put("deviceId","device-1"); record.put("expiresAt","2099-01-01T00:00:00Z"); record.put("verified",true);
        record.put("profile",Map.of("id","user-1","name","User","email","user@example.test"));
        record.put("zeroUrl","https://zero.example.test"); record.put("workspaceId","workspace-1");
        return NativeSessionVault.capture(ServerContext.parse("https://example.test"),record,false);
    }
    private final class FlowStore extends NativePushStore {
        final Owner owner;
        NativeSessionVault.CapturedOwner selection;
        boolean verified=true, unavailable;
        final Map<String,Map<String,Object>> records=new HashMap<>();
        FlowStore() throws Exception {
            super(prefs(),null);
            selection=captured("session-1"); owner=new Owner("11111111-1111-4111-8111-111111111111",selection);
            durable.put("active",owner.instance); durable.put("state","active");
            durable.put(owner.instance+".registration","registration-1");
            records.put(owner.instance+".blob",new HashMap<>());
        }
        @Override Owner active() {return owner.instance.equals(durable.get("active"))?owner:null;}
        @Override Owner load(String instance) {return unavailable?null:owner;}
        @Override boolean keysUnavailable() {return unavailable;}
        @Override NativeSessionVault.CapturedOwner selectedOwner() {return unavailable?null:selection;}
        @Override NativeSessionVault.CapturedOwner verifiedOwner() {return verified && !unavailable?selection:null;}
        @Override Map<String,Object> readRecord(Owner owner,String suffix) {return new HashMap<>(records.get(owner.instance+suffix));}
        @Override boolean writeRecord(Owner owner,String suffix,Map<String,Object> record,SharedPreferences.Editor edit) {
            if(!edit.putString(owner.instance+suffix,"encrypted-fixture").commit()) return false;
            records.put(owner.instance+suffix,new HashMap<>(record)); return true;
        }
    }
    @Test public void explicitStorageFailureRetryReschedulesAndRequiresRegistrationSuccess() throws Exception {
        FlowStore store=new FlowStore();
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        boolean[] schedule={false}, server={false}; int[] schedules={0}; java.util.List<String> shown=new java.util.ArrayList<>();
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->{schedules[0]++; return schedule[0];},request->{
            assertEquals("https://example.test/api/native/push/register",request.url().toString());
            assertEquals("Bearer private-token",request.header("Authorization"));
            if(!server[0]) throw new java.io.IOException("offline");
            return Map.of("registrationId","registration-1","provider","unifiedpush");
        },(owner,payload)->shown.add(payload.get("notificationId")));
        try {
            assertTrue(store.endpoint(store.owner,"{}"));
            store.verified=false;
            coordinator.message(json(valid),true,store.owner.instance);
            assertEquals("storage-failed",coordinator.state()); assertTrue(shown.isEmpty());
            store.verified=true; schedule[0]=true;
            coordinator.enable(null);
            lane.submit(()->{}).get();
            assertEquals(2,schedules[0]); assertEquals("registration-failed",coordinator.state());
            assertFalse(coordinator.maintenance()); assertEquals("registration-failed",coordinator.state());
            assertTrue(shown.isEmpty()); server[0]=true;
            coordinator.enable(null); lane.submit(()->{}).get(); assertEquals("active",coordinator.state());
            assertEquals(java.util.List.of("notification-1"),shown);
            assertFalse(durable.containsKey(store.owner.instance+".pending"));
        } finally {lane.shutdownNow();}
    }
    @Test public void pendingVerificationRetainsEndpointAndMessageUntilExactOwnerIsAccepted() throws Exception {
        FlowStore store=new FlowStore(); store.verified=false;
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.List<String> shown=new java.util.ArrayList<>(); int[] sends={0}, schedules={0};
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->{schedules[0]++; return true;},request->{
            sends[0]++; return Map.of("registrationId","registration-1","provider","unifiedpush");
        },(owner,payload)->shown.add(payload.get("notificationId")));
        try {
            assertTrue(store.endpoint(store.owner,"{}"));
            coordinator.message(json(valid),true,store.owner.instance);
            assertTrue(durable.containsKey(store.owner.instance+".messages"));
            assertFalse(coordinator.maintenance()); assertEquals(0,sends[0]); assertTrue(shown.isEmpty());
            coordinator.verificationAccepted(); assertEquals(1,schedules[0]);
            store.verified=true; coordinator.verificationAccepted(); assertEquals(2,schedules[0]);
            assertTrue(coordinator.maintenance()); assertEquals(1,sends[0]);
            assertEquals(java.util.List.of("notification-1"),shown);
            assertFalse(durable.containsKey(store.owner.instance+".messages"));
            coordinator.message(json(valid),true,store.owner.instance);
            assertEquals(1,shown.size());
        } finally {lane.shutdownNow();}
    }
    @Test public void refusalAndReplacementDiscardDeferredMessagesWithoutShowingThem() throws Exception {
        for(boolean replacement:new boolean[]{false,true}) {
            durable.clear(); FlowStore store=new FlowStore(); store.verified=false;
            java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
            java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1);
            java.util.concurrent.CountDownLatch release=new java.util.concurrent.CountDownLatch(1);
            java.util.List<String> shown=new java.util.ArrayList<>();
            NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{throw new AssertionError("retired owner must not register");},
                    (owner,payload)->shown.add(payload.get("notificationId")));
            try {
                lane.submit(()->{started.countDown(); release.await(); return null;});
                assertTrue(started.await(5,java.util.concurrent.TimeUnit.SECONDS));
                coordinator.message(json(valid),true,store.owner.instance);
                assertTrue(durable.containsKey(store.owner.instance+".messages"));
                store.selection=replacement?captured("session-2"):null; store.verified=true;
                coordinator.state(); coordinator.verificationAccepted();
                release.countDown();
                lane.submit(()->{}).get(5,java.util.concurrent.TimeUnit.SECONDS);
                assertTrue(shown.isEmpty()); assertFalse(durable.containsKey(store.owner.instance+".messages"));
                assertEquals(true,durable.get(store.owner.instance+".retired"));
            } finally {
                release.countDown(); lane.shutdownNow();
                assertTrue(lane.awaitTermination(5,java.util.concurrent.TimeUnit.SECONDS));
            }
        }
    }
    @Test public void unavailableOwnerKeysPreserveDeferredEvidence() throws Exception {
        FlowStore store=new FlowStore(); store.verified=false;
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.List<String> shown=new java.util.ArrayList<>();
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{throw new AssertionError();},
                (owner,payload)->shown.add(payload.get("notificationId")));
        try {
            coordinator.message(json(valid),true,store.owner.instance);
            store.unavailable=true; coordinator.state(); coordinator.verificationAccepted();
            assertFalse(coordinator.maintenance());
            assertEquals(store.owner.instance,durable.get("active"));
            assertTrue(durable.containsKey(store.owner.instance+".messages")); assertTrue(shown.isEmpty());
        } finally {lane.shutdownNow();}
    }

    @Test public void queueOnlyStorageRetryReplaysWhileConfigurationIsOffline() throws Exception {
        FlowStore store=new FlowStore(); store.verified=false;
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.List<String> shown=new java.util.ArrayList<>(); boolean[] schedule={false}; int[] schedules={0};
        java.util.concurrent.atomic.AtomicInteger configurations=new java.util.concurrent.atomic.AtomicInteger();
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->{schedules[0]++; return schedule[0];},
                request->{throw new AssertionError("queue-only replay must not register again");},
                (owner,payload)->shown.add(payload.get("notificationId")));
        java.lang.reflect.Field http=NativePushCoordinator.class.getDeclaredField("http"); http.setAccessible(true);
        http.set(coordinator,new okhttp3.OkHttpClient.Builder().addInterceptor(chain->{
            configurations.incrementAndGet();
            assertEquals("https://example.test/api/native/push/config",chain.request().url().toString());
            throw new java.io.IOException("configuration is offline");
        }).build());
        try {
            coordinator.message(json(valid),true,store.owner.instance);
            assertEquals("storage-failed",coordinator.state());
            assertTrue(durable.containsKey(store.owner.instance+".messages"));
            assertFalse(durable.containsKey(store.owner.instance+".pending"));
            store.verified=true; schedule[0]=true;
            coordinator.enable(null);
            lane.submit(()->{}).get();
            assertEquals(2,schedules[0]); assertEquals(0,configurations.get());
            assertEquals("active",coordinator.state());
            assertTrue(coordinator.maintenance());
            assertEquals(java.util.List.of("notification-1"),shown);
            assertFalse(durable.containsKey(store.owner.instance+".messages"));
        } finally {lane.shutdownNow();}
    }
    @Test public void freshRegistrationDrainsWithoutWaitingForDurableBackoff() throws Exception {
        FlowStore store=new FlowStore();
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.List<String> bodies=new java.util.ArrayList<>(); boolean[] server={false};
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{
            okio.Buffer buffer=new okio.Buffer(); request.body().writeTo(buffer); bodies.add(buffer.readUtf8());
            if(!server[0]) throw new java.io.IOException("offline");
            return Map.of("registrationId","registration-1","provider","unifiedpush");
        },(owner,payload)->{throw new AssertionError();});
        try {
            assertTrue(store.endpoint(store.owner,"{\"attempt\":1}"));
            assertFalse(coordinator.maintenance()); assertEquals("registration-failed",coordinator.state());
            server[0]=true; assertTrue(store.endpoint(store.owner,"{\"attempt\":2}"));
            coordinator.enable(null);
            lane.submit(()->{}).get();
            assertEquals(java.util.List.of("{\"attempt\":1}","{\"attempt\":2}"),bodies);
            assertEquals("active",coordinator.state()); assertFalse(durable.containsKey(store.owner.instance+".pending"));
        } finally {lane.shutdownNow();}
    }
    @Test public void acceptedVerificationCoalescesBurstIntoOneQueuedDrain() throws Exception {
        FlowStore store=new FlowStore();
        java.util.concurrent.ThreadPoolExecutor lane=(java.util.concurrent.ThreadPoolExecutor)java.util.concurrent.Executors.newFixedThreadPool(1);
        java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1), release=new java.util.concurrent.CountDownLatch(1);
        java.util.List<String> bodies=new java.util.ArrayList<>();
        lane.submit(()->{started.countDown(); try {release.await();} catch(InterruptedException e) {Thread.currentThread().interrupt();}});
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{
            okio.Buffer buffer=new okio.Buffer(); request.body().writeTo(buffer); bodies.add(buffer.readUtf8());
            return Map.of("registrationId","registration-1","provider","unifiedpush");
        },(owner,payload)->{throw new AssertionError();});
        try {
            assertTrue(started.await(5,java.util.concurrent.TimeUnit.SECONDS));
            for(int i=0;i<16;i++) {
                assertTrue(store.endpoint(store.owner,"{\"attempt\":"+i+"}")); coordinator.verificationAccepted();
            }
            assertEquals(1,lane.getQueue().size());
            release.countDown(); lane.submit(()->{}).get();
            assertEquals(java.util.List.of("{\"attempt\":15}"),bodies); assertEquals("active",coordinator.state());
        } finally {release.countDown(); lane.shutdownNow();}
    }
    @Test public void queuedDrainRejectsReplacedOwnerBeforeRegistration() throws Exception {
        FlowStore store=new FlowStore();
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1), release=new java.util.concurrent.CountDownLatch(1);
        lane.submit(()->{started.countDown(); try {release.await();} catch(InterruptedException e) {Thread.currentThread().interrupt();}});
        java.util.concurrent.atomic.AtomicInteger sends=new java.util.concurrent.atomic.AtomicInteger();
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{sends.incrementAndGet(); throw new AssertionError("replacement must fence queued registration");},
                (owner,payload)->{throw new AssertionError();});
        try {
            assertTrue(started.await(5,java.util.concurrent.TimeUnit.SECONDS));
            assertTrue(store.endpoint(store.owner,"{}")); coordinator.verificationAccepted();
            store.selection=captured("session-2"); release.countDown(); lane.submit(()->{}).get();
            assertEquals(0,sends.get()); assertEquals(true,durable.get(store.owner.instance+".retired"));
        } finally {release.countDown(); lane.shutdownNow();}
    }
    @Test public void concurrentWorkersShareOneQueuedDrain() throws Exception {
        FlowStore store=new FlowStore(); assertTrue(store.endpoint(store.owner,"{}"));
        java.util.concurrent.ThreadPoolExecutor lane=(java.util.concurrent.ThreadPoolExecutor)java.util.concurrent.Executors.newFixedThreadPool(1);
        java.util.List<Thread> threads=java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        java.util.concurrent.ExecutorService workers=java.util.concurrent.Executors.newFixedThreadPool(8,r->{Thread t=new Thread(r); threads.add(t); return t;});
        java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1),called=new java.util.concurrent.CountDownLatch(8);
        java.util.concurrent.atomic.AtomicInteger sends=new java.util.concurrent.atomic.AtomicInteger();
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{
            sends.incrementAndGet(); return Map.of("registrationId","registration-1","provider","unifiedpush");
        },(owner,payload)->{throw new AssertionError();});
        lane.submit(()->{started.countDown(); try {release.await();} catch(InterruptedException e) {Thread.currentThread().interrupt();}});
        try {
            assertTrue(started.await(5,java.util.concurrent.TimeUnit.SECONDS));
            java.util.List<java.util.concurrent.Future<Boolean>> results=new java.util.ArrayList<>();
            for(int i=0;i<8;i++) results.add(workers.submit(()->{called.countDown(); return coordinator.maintenance();}));
            assertTrue(called.await(5,java.util.concurrent.TimeUnit.SECONDS));
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while(threads.stream().anyMatch(t->t.getState()!=Thread.State.WAITING) && System.nanoTime()<deadline) Thread.sleep(10);
            assertTrue(threads.stream().allMatch(t->t.getState()==Thread.State.WAITING));
            assertEquals(1,lane.getQueue().size()); release.countDown();
            for(java.util.concurrent.Future<Boolean> result:results) assertTrue(result.get(5,java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(1,sends.get()); assertEquals("active",coordinator.state());
        } finally {release.countDown(); workers.shutdownNow(); lane.shutdownNow();}
    }
    @Test public void capacityOverflowKeepsRetainedMessagesReplayable() throws Exception {
        FlowStore store=new FlowStore(); store.verified=false;
        java.util.concurrent.ExecutorService lane=java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.List<String> shown=new java.util.ArrayList<>(); int[] schedules={0};
        NativePushCoordinator coordinator=new NativePushCoordinator(store,lane,()->true,()->{schedules[0]++; return true;},
                request->{throw new AssertionError("message replay does not register");},
                (owner,payload)->shown.add(payload.get("notificationId")));
        try {
            for(int i=1;i<=65;i++) coordinator.message(json(valid.replace("notification-1","notification-"+i)),true,store.owner.instance);
            assertEquals(64,schedules[0]);
            assertEquals("active",coordinator.state()); assertTrue(shown.isEmpty());
            assertTrue(durable.containsKey(store.owner.instance+".messages"));
            store.verified=true; coordinator.verificationAccepted();
            assertTrue(coordinator.maintenance());
            assertEquals(64,shown.size()); assertFalse(shown.contains("notification-65"));
            for(int i=1;i<=64;i++) assertTrue(shown.contains("notification-"+i));
            assertFalse(durable.containsKey(store.owner.instance+".messages"));
        } finally {lane.shutdownNow();}
    }
}
