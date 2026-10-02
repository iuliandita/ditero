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
    private final ExecutorService lane=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private final OkHttpClient http=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .proxy(Proxy.NO_PROXY).connectTimeout(10,TimeUnit.SECONDS).readTimeout(15,TimeUnit.SECONDS)
            .writeTimeout(15,TimeUnit.SECONDS).callTimeout(30,TimeUnit.SECONDS).build();
    private String failure;
    private NativePushCoordinator(Context context) {
        this.context=context; store=new NativePushStore(context);
        synchronized(this) {reconcile();}
        for(String key:store.prefs.getAll().keySet()) if(key.endsWith(".retired") || key.endsWith(".pending")) {schedule(); break;}
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
        if(store.prefs.contains("active") && (!store.selected(owner) || !permitted())) invalidate();
    }
    synchronized boolean invalidate() {
        if(!store.retire()) {failure="storage-failed"; return false;}
        failure=null;
        if(!schedule()) {failure="storage-failed"; return false;}
        lane.execute(this::cleanup);
        ((NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE)).cancelAll();
        return true;
    }
    synchronized void enable(Activity activity) {
        reconcile();
        if(!permitted()) {failure="denied"; return;}
        NativeSessionVault.CapturedOwner session=store.vault.capture();
        if(session==null) {failure="no-session"; return;}
        NativePushStore.Owner active=store.active();
        if(store.current(active)) {
            String state=store.prefs.getString("state","disabled");
            if(state.equals("active") || state.equals("enabling")) return;
        }
        failure=null;
        final NativePushStore.Owner owner=store.current(active)?active:store.create(session);
        if(owner!=null) store.state(owner,"enabling");
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
        if(!current(owner) || !owner.instance.equals(instance)) return;
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
    private boolean schedule() {
        try {androidx.work.WorkManager.getInstance(context).enqueueUniqueWork("native-push-maintenance",
                androidx.work.ExistingWorkPolicy.APPEND_OR_REPLACE,
                new androidx.work.OneTimeWorkRequest.Builder(MaintenanceWorker.class)
                        .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build())
                    .getResult().get(5,TimeUnit.SECONDS);
            return true;
        } catch(InterruptedException e) {Thread.currentThread().interrupt(); return false;}
        catch(Exception e) {return false;}
    }
    boolean maintenance() throws Exception {
        return lane.submit(() -> {
            synchronized(this) {reconcile();}
            if(!cleanup()) return false;
            NativePushStore.Owner owner;
            String body;
            synchronized(this) {
                owner=store.active();
                if(!current(owner)) return owner==null || !store.selected(owner);
                body=store.pending(owner);
            }
            if(body==null) return !store.prefs.getBoolean(owner.instance+".pending",false);
            try {
                JSONObject response=request(owner.session.pushRegisterRequest(body));
                String id=response.optString("registrationId","");
                if(response.length()!=2 || !id.matches("[A-Za-z0-9_.:-]{1,128}")
                        || !"unifiedpush".equals(response.optString("provider"))) throw new IllegalArgumentException();
                synchronized(this) {
                    if(!current(owner)) return true;
                    if(!body.equals(store.pending(owner))) return true;
                    if(!store.registration(owner,id,body)) {failure="storage-failed"; return false;}
                }
                return true;
            } catch(Exception e) {setState(owner,"registration-failed"); return false;}
        }).get();
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
        if(!current(owner) || !owner.instance.equals(instance) || payload==null
                || !payload.get("registrationId").equals(store.registration(owner))) return;
        if(store.seen(owner,payload.get("notificationId"))) return;
        NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
        if(Build.VERSION.SDK_INT>=26) manager.createNotificationChannel(new NotificationChannel("native-reminders","Ditero reminders",NotificationManager.IMPORTANCE_DEFAULT));
        Intent launch=new Intent(context,MainActivity.class).setAction("io.ditero.app.PUSH_OPEN")
                .setData(android.net.Uri.parse("ditero-push:"+instance+":"+payload.get("notificationId")))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        // The explicit component only opens the shell; no URL or task navigation is consumed.
        PendingIntent tap=PendingIntent.getActivity(context,0,launch,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        try {manager.notify(instance+":"+payload.get("notificationId"),0,new NotificationCompat.Builder(context,"native-reminders")
                .setSmallIcon(io.ditero.app.R.mipmap.ic_launcher).setContentTitle("Ditero")
                .setContentText("You have a new reminder").setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setAutoCancel(true).setContentIntent(tap).build());}
        catch(SecurityException e) {invalidate(); failure="denied";}
    }
}
