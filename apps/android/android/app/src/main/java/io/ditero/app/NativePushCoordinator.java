package io.ditero.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.net.Proxy;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PushEndpoint;

/** Process-wide serial registration lane; never owned or cancelled by an Activity. */
final class NativePushCoordinator {
    private static NativePushCoordinator singleton;
    static synchronized NativePushCoordinator get(Context context) {
        if(singleton==null) singleton=new NativePushCoordinator(context.getApplicationContext());
        return singleton;
    }
    private final Context context;
    private final NativePushStore store;
    private final ExecutorService lane;
    private final Handler main;
    private final OkHttpClient http;
    interface RegistrationTransport {Map<String,Object> register(Request request) throws Exception;}
    interface NotificationSink {void show(NativePushStore.Owner owner,Map<String,String> payload);}
    interface DurableScheduler {void persist(androidx.work.ExistingWorkPolicy policy) throws Exception;}
    private final java.util.function.BooleanSupplier permissionOverride,scheduleOverride;
    private final RegistrationTransport registrationTransport;
    private final NotificationSink notificationSink;
    private final DurableScheduler durableScheduler;
    private boolean drainQueued,legacyCancelled;
    private java.util.concurrent.Future<Boolean> workerDrainQueued;
    NativePushCoordinator(NativePushStore store,ExecutorService lane,java.util.function.BooleanSupplier permission,
                          java.util.function.BooleanSupplier schedule,RegistrationTransport registration,NotificationSink notifications) {
        this(store,lane,permission,schedule,registration,notifications,null);
    }
    NativePushCoordinator(NativePushStore store,ExecutorService lane,java.util.function.BooleanSupplier permission,
                          java.util.function.BooleanSupplier schedule,RegistrationTransport registration,NotificationSink notifications,
                          DurableScheduler durableScheduler) {
        context=null; main=null; http=null; this.store=store; this.lane=lane;
        permissionOverride=permission; scheduleOverride=schedule; registrationTransport=registration; notificationSink=notifications;
        this.durableScheduler=durableScheduler;
    }
    private String failure;
    private NativePushCoordinator(Context context) {
        this.context=context; store=new NativePushStore(context);
        lane=Executors.newSingleThreadExecutor(); main=new Handler(Looper.getMainLooper());
        http=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).proxy(Proxy.NO_PROXY)
                .connectTimeout(10,TimeUnit.SECONDS).readTimeout(15,TimeUnit.SECONDS).writeTimeout(15,TimeUnit.SECONDS)
                .callTimeout(30,TimeUnit.SECONDS).build();
        permissionOverride=null; scheduleOverride=null; registrationTransport=this::registerRequest; notificationSink=this::show;
        durableScheduler=this::persistRecovery;
        synchronized(this) {reconcile();}
        for(String key:store.prefs.getAll().keySet()) if(key.endsWith(".retired") || key.endsWith(".pending") || key.endsWith(".messages")) {schedule(); break;}
        lane.execute(() -> {
            if(!cleanup()) return;
            NativePushStore.Owner owner;
            synchronized(this) {owner=store.active();}
            if(!current(owner)) return;
            try {
                JSONObject config=request(owner.session.pushConfigRequest());
                String vapid=config.optString("vapidPublicKey","");
                if(!Boolean.TRUE.equals(config.opt("deliveryReady")) || !Boolean.TRUE.equals(config.getJSONObject("providers").opt("unifiedpush"))
                        || !vapid.matches("[A-Za-z0-9_-]{87}")) {setState(owner,"server-unavailable"); return;}
                synchronized(this) {
                    if(!current(owner)) return;
                    if(UnifiedPush.getSavedDistributor(context)==null) {setState(owner,"missing-distributor"); return;}
                    UnifiedPush.register(context,owner.instance,"Ditero",vapid);
                }
            } catch(Exception e) {setState(owner,"server-unavailable");}
        });
    }
    boolean permitted() {
        if(permissionOverride!=null) return permissionOverride.getAsBoolean();
        return (Build.VERSION.SDK_INT<33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)
                && NotificationManagerCompat.from(context).areNotificationsEnabled();
    }
    synchronized void denied() {failure="denied";}
    synchronized String state() {
        reconcile();
        if(failure!=null) return failure;
        String state=store.prefs.getString("state","disabled");
        if(state.equals("disabled")) for(String key:store.prefs.getAll().keySet())
            if(key.endsWith(".retired")) return "cleanup-pending";
        return state;
    }
    private void reconcile() {
        NativePushStore.Owner owner=store.active();
        boolean selected=store.selected(owner);
        if(store.keysUnavailable()) return;
        if(store.prefs.contains("active") && (!selected || !permitted())) invalidate();
    }
    synchronized boolean invalidate() {
        if(!store.retire()) {failure="storage-failed"; return false;}
        failure=null;
        if(!schedule()) {failure="storage-failed"; return false;}
        if(context!=null) ((NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE)).cancelAll();
        return true;
    }
    synchronized void enable(Activity activity) {
        reconcile();
        if(!permitted()) {failure="denied"; return;}
        NativeSessionVault.CapturedOwner session=store.verifiedOwner();
        if(session==null) {failure="no-session"; return;}
        NativePushStore.Owner active=store.active();
        boolean retrying=failure!=null;
        if(store.current(active)) {
            boolean pendingRegistration=store.prefs.getBoolean(active.instance+".pending",false);
            if(pendingRegistration || store.prefs.contains(active.instance+".messages")) {
                failure=null;
                if(pendingRegistration && !store.state(active,"enabling")) {failure="storage-failed"; return;}
                if(!schedule()) failure="storage-failed";
                return;
            }
            if(failure!=null) failure=null;
        }
        if(store.current(active)) {
            String state=store.prefs.getString("state","disabled");
            if((state.equals("active") || state.equals("enabling")) && failure==null && !retrying) return;
        }
        failure=null;
        final NativePushStore.Owner owner=store.current(active)?active:store.create(session);
        if(owner!=null && !store.state(owner,"enabling")) {failure="storage-failed"; return;}
        if(owner==null) {failure="storage-failed"; return;}
        lane.execute(() -> {
            if(!cleanup()) {setState(owner,"cleanup-pending"); return;}
            if(!current(owner)) return;
            try {
                JSONObject config=request(owner.session.pushConfigRequest());
                String vapid=config.optString("vapidPublicKey","");
                if(!Boolean.TRUE.equals(config.opt("deliveryReady")) || !Boolean.TRUE.equals(config.getJSONObject("providers").opt("unifiedpush"))
                        || !vapid.matches("[A-Za-z0-9_-]{87}")) {setState(owner,"server-unavailable"); return;}
                main.post(() -> {
                    if(!current(owner)) return;
                    if(activity.isFinishing() || activity.isDestroyed()) {setState(owner,"registration-failed"); return;}
                    try {UnifiedPush.tryUseCurrentOrDefaultDistributor(activity,success -> {
                        synchronized(NativePushCoordinator.this) {
                            if(current(owner)) {
                                if(success) {
                                    try {UnifiedPush.register(context,owner.instance,"Ditero",vapid);}
                                    catch(RuntimeException e) {setState(owner,"registration-failed");}
                                } else setState(owner,"missing-distributor");
                            }
                        }
                        return kotlin.Unit.INSTANCE;
                    });} catch(RuntimeException e) {setState(owner,"registration-failed");}
                });
            } catch(Exception e) {setState(owner,"server-unavailable");}
        });
    }
    private synchronized boolean current(NativePushStore.Owner owner) {return store.current(owner) && failure==null && permitted();}
    private synchronized void setState(NativePushStore.Owner owner,String value) {if(current(owner) && !store.state(owner,value)) failure="storage-failed";}
    private boolean cleanup() {
        boolean ok=true;
        for(Map.Entry<String,?> entry:store.prefs.getAll().entrySet()) {
            if(!entry.getKey().endsWith(".retired") || !Boolean.TRUE.equals(entry.getValue())) continue;
            String instance=entry.getKey().substring(0,entry.getKey().length()-8);
            NativePushStore.Owner owner=store.load(instance);
            try {
                UnifiedPush.unregister(context,instance);
                if(owner!=null) {
                    JSONObject response=request(owner.session.pushUnregisterRequest(),true);
                    if(!response.optBoolean("unregistered")) {ok=false; continue;}
                } else if(!store.expired(instance)) {ok=false; continue;}
                if(!store.clear(instance)) ok=false;
            } catch(Exception e) {ok=false;}
        }
        return ok;
    }
    synchronized void endpoint(PushEndpoint endpoint,String instance) {
        NativePushStore.Owner owner=store.active();
        if(owner==null || !owner.instance.equals(instance) || !store.selected(owner) || !permitted()) return;
        try {
            if(endpoint.getPubKeySet()==null || endpoint.getUrl().length()>2048) throw new IllegalArgumentException();
            java.net.URI uri=new java.net.URI(endpoint.getUrl());
            if(!"https".equals(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getFragment()!=null) throw new IllegalArgumentException();
            String publicKey=endpoint.getPubKeySet().getPubKey(), auth=endpoint.getPubKeySet().getAuth();
            if(!publicKey.matches("[A-Za-z0-9_-]{87}") || !auth.matches("[A-Za-z0-9_-]{22}")) throw new IllegalArgumentException();
            JSONObject keys=new JSONObject().put("p256dh",publicKey).put("auth",auth);
            String body=new JSONObject().put("provider","unifiedpush").put("endpoint",endpoint.getUrl()).put("keys",keys).toString();
            if(!store.endpoint(owner,body)) {failure="storage-failed"; return;}
            if(!schedule()) failure="storage-failed";
        } catch(Exception e) {setState(owner,"registration-failed");}
    }
    private synchronized boolean schedule() {
        if(scheduleOverride!=null && !scheduleOverride.getAsBoolean()) return false;
        if(drainQueued) return true;
        NativePushStore.Owner captured=store.active();
        drainQueued=true;
        try {
            lane.execute(() -> {
                synchronized(this) {drainQueued=false;}
                if(durableScheduler!=null) {
                    try {
                        durableScheduler.persist(androidx.work.ExistingWorkPolicy.REPLACE);
                    } catch(Exception e) {
                        if(e instanceof InterruptedException) Thread.currentThread().interrupt();
                        synchronized(this) {
                            NativePushStore.Owner active=store.active();
                            if((captured==null && active==null) || (captured!=null && active!=null && captured.instance.equals(active.instance)))
                                failure="storage-failed";
                        }
                        return;
                    }
                }
                drain();
            });
            return true;
        } catch(RuntimeException e) {drainQueued=false; return false;}
    }
    private void persistRecovery(androidx.work.ExistingWorkPolicy policy) throws Exception {
        androidx.work.WorkManager work=androidx.work.WorkManager.getInstance(context);
        work.enqueueUniqueWork("native-push-drain",policy,
                new androidx.work.OneTimeWorkRequest.Builder(MaintenanceWorker.class)
                        .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build())
                .getResult().get(5,TimeUnit.SECONDS);
        // Persist replacement recovery work before retiring the legacy blocked chain.
        if(!legacyCancelled) {
            work.cancelUniqueWork("native-push-maintenance").getResult().get(5,TimeUnit.SECONDS);
            legacyCancelled=true;
        }
    }
    synchronized void verificationAccepted() {
        NativePushStore.Owner owner=store.active();
        if(!current(owner)) return;
        if(store.prefs.getBoolean(owner.instance+".pending",false) || store.prefs.contains(owner.instance+".messages"))
            if(!schedule()) failure="storage-failed";
    }
    private Map<String,Object> registerRequest(Request request) throws Exception {
        JSONObject response=request(request);
        if(response.length()!=2) throw new IllegalArgumentException();
        return Map.of("registrationId",response.get("registrationId"),"provider",response.get("provider"));
    }
    private synchronized boolean replay(NativePushStore.Owner owner) throws Exception {
        if(!current(owner)) return false;
        for(Map<String,String> payload:store.deferred(owner)) {
            if(!current(owner)) return false;
            if(payload.get("registrationId").equals(store.registration(owner))) deliver(owner,payload);
        }
        return !store.prefs.contains(owner.instance+".messages") || store.clearDeferred(owner);
    }
    boolean maintenance() throws Exception {
        java.util.concurrent.Future<Boolean> attempt;
        synchronized(this) {
            if(workerDrainQueued==null) {
                java.util.concurrent.FutureTask<Boolean> task=new java.util.concurrent.FutureTask<>(() -> {
                    synchronized(this) {workerDrainQueued=null;}
                    return drain();
                });
                workerDrainQueued=task;
                try {lane.execute(task);} catch(RuntimeException e) {workerDrainQueued=null; throw e;}
            }
            attempt=workerDrainQueued;
        }
        return attempt.get();
    }
    private boolean drain() {
        try {
            synchronized(this) {reconcile();}
            if(!cleanup()) return false;
            NativePushStore.Owner owner;
            String body;
            synchronized(this) {
                owner=store.active();
                if(store.keysUnavailable()) return false;
                if(!current(owner)) {
                    boolean selected=store.selected(owner);
                    return !store.keysUnavailable() && (owner==null || !selected);
                }
                body=store.pending(owner);
            }
            if(body==null) return !store.prefs.getBoolean(owner.instance+".pending",false) && replay(owner);
            try {
                Map<String,Object> response=registrationTransport.register(owner.session.pushRegisterRequest(body));
                Object value=response.get("registrationId");
                String id=value instanceof String?(String)value:"";
                if(response.size()!=2 || !id.matches("[A-Za-z0-9_.:-]{1,128}")
                        || !"unifiedpush".equals(response.get("provider"))) throw new IllegalArgumentException();
                synchronized(this) {
                    if(!current(owner)) return !store.selected(owner);
                    if(!body.equals(store.pending(owner))) return false;
                    if(!store.registration(owner,id,body)) {failure="storage-failed"; return false;}
                }
                return replay(owner);
            } catch(Exception e) {setState(owner,"registration-failed"); return false;}
        } catch(Exception e) {return false;}
    }
    /** Only registration/cleanup is scheduled; reminders are received through UnifiedPush. */
    public static final class MaintenanceWorker extends androidx.work.Worker {
        public MaintenanceWorker(Context context,androidx.work.WorkerParameters parameters) {super(context,parameters);}
        @Override public Result doWork() {
            try {return NativePushCoordinator.get(getApplicationContext()).maintenance()?Result.success():Result.retry();}
            catch(Exception e) {return Result.retry();}
        }
    }
    void unavailable(String instance,String state,boolean unregister) {
        synchronized(this) {
            NativePushStore.Owner owner=store.active();
            if(!current(owner) || !owner.instance.equals(instance)) return;
            if(unregister) {invalidate(); failure=state;} else setState(owner,state);
        }
    }
    private JSONObject request(Request request) throws Exception {return request(request,false);}
    private JSONObject request(Request request,boolean cleanup) throws Exception {
        if(!request.url().isHttps()) throw new IllegalArgumentException();
        try(Response response=http.newCall(request).execute()) {
            byte[] bytes=response.peekBody(8193).bytes();
            if(bytes.length>8192) throw new IllegalArgumentException();
            String raw=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            Object parsed=NativeZeroTransport.parse(raw);
            if(!(parsed instanceof Map)) throw new IllegalArgumentException();
            JSONObject body=new JSONObject((Map<?,?>)parsed);
            if(cleanup && response.code()==401 && body.length()==1 && "unauthorized".equals(body.optString("code")))
                return new JSONObject().put("unregistered",true);
            if(response.code()!=200) throw new IllegalArgumentException();
            return body;
        }
    }
    static Map<String,String> payload(byte[] bytes,boolean decrypted) {
        if(!decrypted || bytes==null || bytes.length==0 || bytes.length>1024) return null;
        try {
            String json=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            if(!json.matches("(?s)[ \\t\\r\\n]*\\{.*\\}[ \\t\\r\\n]*")) return null;
            String content=json.substring(json.indexOf('{')+1,json.lastIndexOf('}'));
            Pattern field=Pattern.compile("[ \\t\\r\\n]*\"(version|notificationId|registrationId)\"[ \\t\\r\\n]*:[ \\t\\r\\n]*\"([A-Za-z0-9_.:-]{1,128})\"[ \\t\\r\\n]*");
            String[] fields=content.split(",",-1);
            Map<String,String> out=new HashMap<>();
            if(fields.length!=3) return null;
            for(String part:fields) {Matcher m=field.matcher(part); if(!m.matches() || out.put(m.group(1),m.group(2))!=null) return null;}
            return "1".equals(out.get("version")) ? out : null;
        } catch(Exception e) {return null;}
    }
    synchronized void message(byte[] content,boolean decrypted,String instance) {
        reconcile();
        NativePushStore.Owner owner=store.active();
        Map<String,String> payload=payload(content,decrypted);
        if(owner==null || !owner.instance.equals(instance) || !store.selected(owner) || !permitted() || payload==null
                || !payload.get("registrationId").equals(store.registration(owner))) return;
        if(!current(owner)) {
            NativePushStore.Deferred result=store.defer(owner,payload);
            if(result==NativePushStore.Deferred.FAILED || (result==NativePushStore.Deferred.STORED && !schedule()))
                failure="storage-failed";
            return;
        }
        deliver(owner,payload);
    }
    private void deliver(NativePushStore.Owner owner,Map<String,String> payload) {
        if(!current(owner) || store.seen(owner,payload.get("notificationId"))) return;
        notificationSink.show(owner,payload);
    }
    private void show(NativePushStore.Owner owner,Map<String,String> payload) {
        String instance=owner.instance;
        NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
        if(Build.VERSION.SDK_INT>=26) manager.createNotificationChannel(new NotificationChannel("native-reminders",context.getString(R.string.native_push_channel),NotificationManager.IMPORTANCE_DEFAULT));
        Intent launch=new Intent(context,MainActivity.class).setAction("io.ditero.app.PUSH_OPEN")
                .setData(android.net.Uri.parse("ditero-push:"+instance+":"+payload.get("notificationId")))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        // The explicit component only opens the shell; no URL or task navigation is consumed.
        PendingIntent tap=PendingIntent.getActivity(context,0,launch,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        try {manager.notify(instance+":"+payload.get("notificationId"),0,new NotificationCompat.Builder(context,"native-reminders")
                .setSmallIcon(io.ditero.app.R.drawable.ic_notification).setContentTitle("Ditero")
                .setContentText(context.getString(R.string.native_push_body)).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setAutoCancel(true).setContentIntent(tap).build());}
        catch(SecurityException e) {invalidate(); failure="denied";}
    }
}
