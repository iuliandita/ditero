package io.ditero.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android keystore/AES persistence; no Firebase service or provider delivery claims. */
@RunWith(AndroidJUnit4.class)
public class NativeRelayPersistenceTest {
    @Test public void encryptedTargetRecoveryRetainsPredecessorPendingSecretAndConcurrentChallenge() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs=context.getSharedPreferences("native-relay-runtime-test-"+UUID.randomUUID(),Context.MODE_PRIVATE);
        NativeRelayStore store=new NativeRelayStore(prefs);
        String instance=UUID.randomUUID().toString(),old=NativeRelayProtocol.opaqueId(),next=NativeRelayProtocol.opaqueId(),challenge=NativeRelayProtocol.opaqueId();
        try {
            Map<String,Object> state=new HashMap<>();state.put("phase","replace");state.put("registrationId","registration-1");
            state.put("managementSecret",old);state.put("nextSecret",next);state.put("generation",1);state.put("credentialVersion",1);
            state.put("operation",Map.of("operationId",NativeRelayProtocol.opaqueId(),"managementSecret",old,"newManagementSecret",next));
            assertTrue(store.save(instance,state));String ciphertext=prefs.getString(instance+".relay","");
            assertFalse(ciphertext.contains(old));assertFalse(ciphertext.contains(next));
            Map<String,Object> stale=store.target(instance);assertTrue(store.challenge(instance,"registration-1",challenge));
            stale.put("issued",true);assertTrue(store.save(instance,stale));
            Map<String,Object> recovered=new NativeRelayStore(prefs).target(instance);
            assertEquals(old,recovered.get("managementSecret"));assertEquals(next,recovered.get("nextSecret"));assertEquals(challenge,recovered.get("challenge"));
            assertTrue(new NativeRelayStore(prefs).suppressed(instance));
            String other=UUID.randomUUID().toString();assertTrue(prefs.edit().putString(other+".relay",ciphertext).commit());
            try {new NativeRelayStore(prefs).target(other);fail("copied owner ciphertext accepted");}catch(java.security.GeneralSecurityException expected){}
        } finally {assertTrue(prefs.edit().clear().commit());}
    }
    private static volatile String recoveryPrefs,recoveryInstance;
    private static volatile boolean acceptActivation;
    private static java.util.concurrent.CountDownLatch attempted,recovered;
    public static final class RelayRecoveryWorker extends androidx.work.Worker {
        public RelayRecoveryWorker(Context context,androidx.work.WorkerParameters parameters) {super(context,parameters);}
        @Override public Result doWork() {
            SharedPreferences prefs=getApplicationContext().getSharedPreferences(recoveryPrefs,Context.MODE_PRIVATE);
            NativeRelayClient client=new NativeRelayClient(new NativeRelayStore(prefs),new NativePushProvider() {
                public String id(){return "google";}public boolean available(){return true;}
                public void enable(android.app.Activity activity,NativePushStore.Owner owner){}public void resume(NativePushStore.Owner owner){}public void retire(NativePushStore.Owner owner){}
            },new NativeRelayClient.Authority() {
                public boolean current(NativePushStore.Owner owner){return true;}
                public boolean activate(NativePushStore.Owner owner,String registration) {
                    attempted.countDown();
                    if(!acceptActivation)return false;
                    boolean ok=prefs.edit().putString("repaired-registration",registration).commit();if(ok)recovered.countDown();return ok;
                }
            },request->{throw new AssertionError("active local repair must not dispatch");},new NativeRelayClient.DeviceKey() {
                public java.security.PrivateKey privateKey(){throw new AssertionError("active local repair must not sign");}
                public Map<String,Object> publicKey(){throw new AssertionError("active local repair must not replace key");}
            });
            try{return client.drain(new NativePushStore.Owner(recoveryInstance,null,"google"))?Result.success():Result.retry();}
            catch(Exception e){return Result.retry();}
        }
    }
    @Test public void workManagerRestoresEncryptedRelayAndRepairsFailedLocalActivationCommit() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        recoveryPrefs="native-relay-worker-test-"+UUID.randomUUID();recoveryInstance=UUID.randomUUID().toString();
        SharedPreferences prefs=context.getSharedPreferences(recoveryPrefs,Context.MODE_PRIVATE);
        androidx.work.WorkManager work=androidx.work.WorkManager.getInstance(context);
        String job="native-relay-recovery-test-"+UUID.randomUUID();attempted=new java.util.concurrent.CountDownLatch(1);recovered=new java.util.concurrent.CountDownLatch(1);acceptActivation=false;
        try {
            assertTrue(new NativeRelayStore(prefs).save(recoveryInstance,Map.of("phase","active","registrationId","registration-1","managementSecret",NativeRelayProtocol.opaqueId())));
            androidx.work.OneTimeWorkRequest first=new androidx.work.OneTimeWorkRequest.Builder(RelayRecoveryWorker.class)
                    .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,30,java.util.concurrent.TimeUnit.SECONDS).build();
            work.enqueueUniqueWork(job,androidx.work.ExistingWorkPolicy.REPLACE,first).getResult().get(5,java.util.concurrent.TimeUnit.SECONDS);
            assertTrue(attempted.await(10,java.util.concurrent.TimeUnit.SECONDS));assertNull(prefs.getString("repaired-registration",null));
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
            boolean durableRetry=false;
            while(System.nanoTime()<deadline) {
                androidx.work.WorkInfo info=work.getWorkInfoById(first.getId()).get(5,java.util.concurrent.TimeUnit.SECONDS);
                if(info.getState()==androidx.work.WorkInfo.State.ENQUEUED && info.getRunAttemptCount()>0){durableRetry=true;break;}
                Thread.sleep(20);
            }
            assertTrue("failed activation remains durably scheduled",durableRetry);
            assertNotNull(new NativeRelayStore(prefs).target(recoveryInstance).get("managementSecret"));
            acceptActivation=true;
            androidx.work.OneTimeWorkRequest retry=new androidx.work.OneTimeWorkRequest.Builder(RelayRecoveryWorker.class).build();
            work.enqueueUniqueWork(job,androidx.work.ExistingWorkPolicy.REPLACE,retry).getResult().get(5,java.util.concurrent.TimeUnit.SECONDS);
            assertTrue(recovered.await(10,java.util.concurrent.TimeUnit.SECONDS));assertEquals("registration-1",prefs.getString("repaired-registration",null));
        } finally {work.cancelUniqueWork(job).getResult().get(5,java.util.concurrent.TimeUnit.SECONDS);assertTrue(prefs.edit().clear().commit());}
    }

}
