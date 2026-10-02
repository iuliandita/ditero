package io.ditero.app;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the real WorkManager RUNNING-to-SUCCESS handoff with a failing fresh drain. */
@RunWith(AndroidJUnit4.class)
public class NativePushHandoffTest {
    private static volatile NativePushCoordinator coordinator;
    private static CountDownLatch drained,complete,failed;

    public static final class CompletingWorker extends Worker {
        public CompletingWorker(Context context,WorkerParameters parameters) {super(context,parameters);}
        @Override public Result doWork() {
            try {
                boolean ok=coordinator.maintenance(); drained.countDown();
                if(!complete.await(20,TimeUnit.SECONDS)) return Result.failure();
                return ok?Result.success():Result.retry();
            } catch(Exception e) {return Result.failure();}
        }
    }
    public static final class RetryWorker extends Worker {
        public RetryWorker(Context context,WorkerParameters parameters) {super(context,parameters);}
        @Override public Result doWork() {
            try {
                if(coordinator.maintenance()) return Result.success();
                failed.countDown(); return Result.retry();
            } catch(Exception e) {failed.countDown(); return Result.retry();}
        }
    }
    private static final class Store extends NativePushStore {
        final Owner owner;
        volatile String body,state="active";
        Store(Context context,String name) throws Exception {
            super(context.getSharedPreferences(name,Context.MODE_PRIVATE),null);
            Map<String,Object> record=new HashMap<>();
            record.put("token","test-token"); record.put("sessionId","session-1"); record.put("userId","user-1");
            record.put("deviceId","device-1"); record.put("expiresAt","2099-01-01T00:00:00Z"); record.put("verified",true);
            record.put("profile",Map.of("id","user-1","name","User","email","user@example.test"));
            record.put("zeroUrl","https://zero.example.test"); record.put("workspaceId","workspace-1");
            owner=new Owner(UUID.randomUUID().toString(),NativeSessionVault.capture(ServerContext.parse("https://example.test"),record,false));
        }
        @Override Owner active() {return owner;}
        @Override boolean current(Owner candidate) {return candidate==owner;}
        @Override boolean selected(Owner candidate) {return candidate==owner;}
        @Override String pending(Owner candidate) {return body;}
        @Override boolean state(Owner candidate,String value) {state=value; return true;}
        @Override boolean registration(Owner candidate,String id,String submitted) {
            if(!submitted.equals(body)) return false;
            if(!prefs.edit().remove(owner.instance+".pending").commit()) return false;
            body=null; state="active"; return true;
        }
    }
    private boolean race(ExistingWorkPolicy negativeControl) throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        WorkManager work=WorkManager.getInstance(context);
        String name="native-push-handoff-test-"+UUID.randomUUID();
        Store store=new Store(context,name);
        ExecutorService lane=Executors.newSingleThreadExecutor();
        drained=new CountDownLatch(1); complete=new CountDownLatch(1); failed=new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean online=new java.util.concurrent.atomic.AtomicBoolean();
        coordinator=new NativePushCoordinator(store,lane,()->true,()->true,request->{
            if(!online.get()) throw new java.io.IOException("offline");
            return Map.of("registrationId","registration-1","provider","unifiedpush");
        },(owner,payload)->{throw new AssertionError();},policy->work.enqueueUniqueWork(name,
                negativeControl==null?policy:negativeControl,
                new OneTimeWorkRequest.Builder(RetryWorker.class).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build())
                .getResult().get(5,TimeUnit.SECONDS));
        OneTimeWorkRequest old=new OneTimeWorkRequest.Builder(CompletingWorker.class).build();
        try {
            work.enqueueUniqueWork(name,ExistingWorkPolicy.REPLACE,old).getResult().get(5,TimeUnit.SECONDS);
            assertTrue(drained.await(10,TimeUnit.SECONDS));
            assertEquals(WorkInfo.State.RUNNING,work.getWorkInfoById(old.getId()).get(5,TimeUnit.SECONDS).getState());
            store.body="{}"; store.prefs.edit().putBoolean(store.owner.instance+".pending",true).commit();
            coordinator.verificationAccepted(); lane.submit(()->{}).get(10,TimeUnit.SECONDS);
            assertEquals("registration-failed",store.state); assertEquals("{}",store.body);
            complete.countDown();
            if(negativeControl==null) assertTrue(failed.await(10,TimeUnit.SECONDS));
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(System.nanoTime()<deadline) {
                List<WorkInfo> infos=work.getWorkInfosForUniqueWork(name).get(5,TimeUnit.SECONDS);
                boolean oldFinished=work.getWorkInfoById(old.getId()).get(5,TimeUnit.SECONDS).getState().isFinished();
                boolean retry=infos.stream().anyMatch(info->!info.getId().equals(old.getId()) && info.getState()==WorkInfo.State.ENQUEUED && info.getRunAttemptCount()>0);
                if(oldFinished && (negativeControl!=null || retry)) {
                    if(retry) {
                        online.set(true); coordinator.verificationAccepted(); lane.submit(()->{}).get(10,TimeUnit.SECONDS);
                        assertNull(store.body); assertEquals("active",store.state);
                    }
                    return retry;
                }
                Thread.sleep(20);
            }
            throw new AssertionError("WorkManager did not finish the bounded handoff");
        } finally {
            complete.countDown(); work.cancelUniqueWork(name).getResult().get(5,TimeUnit.SECONDS);
            lane.shutdownNow(); store.prefs.edit().clear().commit();
        }
    }
    @Test public void freshFailureRetainsDurableRetryAfterPriorWorkerSuccess() throws Exception {
        assertFalse("KEEP control loses the fresh retry",race(ExistingWorkPolicy.KEEP));
        assertTrue("production scheduling retains the fresh retry",race(null));
    }
}
