package io.ditero.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.net.URI;
import java.util.concurrent.atomic.AtomicInteger;
import android.util.Base64;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;
import okhttp3.*;
import okio.BufferedSink;

/** Fixed attachment streaming and user-selected write-only document capabilities. */
final class NativeAttachmentTransfers {
    static final int PICK_DOCUMENT = 49346;
    private static final AtomicInteger nextPicker = new AtomicInteger(PICK_DOCUMENT);
    static final int CHUNK = 32768;
    static final int MAX_ACTIVE = 4;
    static final long MAX_SAFE = 9007199254740991L;
    private static final ExecutorService cleanup = Executors.newSingleThreadExecutor();
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
    interface Reply { void done(Map<String,Object> value); }
    private final Activity activity;
    private final OkHttpClient http;
    private final ExecutorService workers = Executors.newFixedThreadPool(MAX_ACTIVE);
    private final Map<String,Transfer> transfers = new HashMap<>();
    static final class Pick {
        final Transfer transfer;
        final Reply reply;
        Pick(Transfer transfer, Reply reply) { this.transfer=transfer; this.reply=reply; }
    }
    private final Map<Integer,Pick> picks = new HashMap<>();
    private Transfer pendingSave;
    private boolean closed;

    NativeAttachmentTransfers(Activity activity, OkHttpClient http) {
        this.activity = activity;
        this.http = http;
    }
    static String attachmentPath(String id, boolean thumbnail, boolean upload) {
        if (id == null || !ID.matcher(id).matches()) throw new IllegalArgumentException("invalid-id");
        return "/api/native/attachments/" + id + (thumbnail ? "/thumbnail" : upload ? "/upload" : "/download");
    }
    static long positiveBytes(Object value) {
        if (!(value instanceof Number)) throw new IllegalArgumentException("invalid-bytes");
        double n = ((Number)value).doubleValue();
        if (!Double.isFinite(n) || n < 1 || n > MAX_SAFE || n != Math.floor(n)) throw new IllegalArgumentException("invalid-bytes");
        return (long)n;
    }
    static void optionalPositiveBytes(Object value, Object jsonNull) {
        if(value!=null && value!=jsonNull)positiveBytes(value);
    }
    static final class Chunk {
        final byte[] data;
        final boolean eof;
        final CountDownLatch consumed = new CountDownLatch(1);
        Chunk(byte[] data, boolean eof) { this.data=data; this.eof=eof; }
    }
    static class Transfer {
        final String id = UUID.randomUUID().toString();
        final String owner;
        final String kind;
        final long declared;
        final ArrayBlockingQueue<Chunk> queue = new ArrayBlockingQueue<>(1);
        final CompletableFuture<Map<String,Object>> result = new CompletableFuture<>();
        volatile boolean cancelled;
        volatile Chunk consuming;
        Call call;
        InputStream input;
        OutputStream output;
        long bytes;
        int seq;
        boolean busy;
        boolean finishing;
        boolean saveCommitted;
        Uri document;
        Transfer(String owner, String kind, long declared) { this.owner=owner; this.kind=kind; this.declared=declared; }
        synchronized void claim(String owner, String kind, int sequence) {
            if (cancelled || !this.owner.equals(owner) || !this.kind.equals(kind)) throw new IllegalArgumentException("invalid-capability");
            if (busy || finishing) throw new IllegalArgumentException("busy");
            if (sequence != seq) throw new IllegalArgumentException("invalid-sequence");
            busy=true;
        }
        synchronized void consumed(int count) {
            bytes += count;
            seq++;
            busy=false;
        }
        synchronized void cancel() {
            cancelled=true;
            if (call != null) call.cancel();
            InputStream oldInput=input; OutputStream oldOutput=output;
            input=null; output=null;
            cleanup.execute(() -> { close(oldInput); close(oldOutput); });
            Chunk pending=queue.poll();
            if (pending != null) pending.consumed.countDown();
            if (consuming != null) consuming.consumed.countDown();
            queue.offer(new Chunk(new byte[0],true));
            result.complete(error("cancelled"));
        }
    }
    synchronized Transfer add(String owner, String kind, long bytes) {
        if (closed || transfers.size() >= MAX_ACTIVE) throw new IllegalArgumentException("transfer-limit");
        Transfer t=new Transfer(owner,kind,bytes); transfers.put(t.id,t); return t;
    }
    synchronized Transfer get(String id) {
        Transfer t=transfers.get(id);
        if (t == null) throw new IllegalArgumentException("invalid-capability");
        return t;
    }
    synchronized void remove(Transfer t) {
        transfers.remove(t.id); t.cancel();
        if(t.document!=null && !t.saveCommitted) deleteDocument(t.document);
        if(pendingSave==t)pendingSave=null;
    }
    synchronized void cancel(String id, String owner) {
        Transfer t=get(id);
        if (!t.owner.equals(owner)) throw new IllegalArgumentException("invalid-capability");
        remove(t);
        if (pendingSave == t) pendingSave=null;
    }
    synchronized void cancelAll() {
        for (Transfer t:new ArrayList<>(transfers.values())) remove(t);
        transfers.clear(); pendingSave=null;
    }
    void shutdown() { synchronized(this) { closed=true; cancelAll(); } workers.shutdownNow(); }
    static Map<String,Object> value(Object... fields) {
        Map<String,Object> out=new LinkedHashMap<>();
        for(int i=0;i<fields.length;i+=2) out.put((String)fields[i],fields[i+1]);
        return out;
    }
    static Map<String,Object> error(String code) { return value("ok",false,"code",code); }
    static void close(Closeable value) { if(value!=null) try { value.close(); } catch(IOException ignored) {} }
    static byte[] decode(String text) {
        if(text==null || text.length()>4*((CHUNK+2)/3) || !text.matches("[A-Za-z0-9+/]*={0,2}")) throw new IllegalArgumentException("invalid-chunk");
        byte[] data=Base64.decode(text,Base64.NO_WRAP);
        validateChunk(data);
        return data;
    }
    static void validateChunk(byte[] data) {
        if(data==null || data.length==0 || data.length>CHUNK)throw new IllegalArgumentException("invalid-chunk");
    }
    void upload(String owner, String url, String token, long bytes, Reply reply, Reply observer) {
        Transfer t=add(owner,"upload",bytes);
        RequestBody body=new RequestBody() {
            public MediaType contentType() { return MediaType.get("application/octet-stream"); }
            public long contentLength() { return bytes; }
            public void writeTo(BufferedSink sink) throws IOException {
                try {
                    while(!t.cancelled) {
                        Chunk c=t.queue.take(); t.consuming=c;
                        try {
                            if(t.cancelled) throw new IOException("cancelled");
                            if(c.eof) return;
                            try { sink.write(c.data); sink.flush(); }
                            catch(IOException error) { t.cancel(); throw error; }
                        } finally { c.consumed.countDown(); t.consuming=null; }
                    }
                    throw new IOException("cancelled");
                } catch(InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("cancelled",e); }
            }
        };
        t.call=http.newCall(new Request.Builder().url(url).header("Authorization","Bearer "+token).post(body).build());
        t.call.enqueue(new Callback() {
            public void onFailure(Call call, IOException e) { t.result.complete(error(t.cancelled?"cancelled":"network")); t.cancel(); }
            public void onResponse(Call call, Response response) {
                try(Response r=response) { Map<String,Object> out=httpResult(r); observer.done(out); t.result.complete(out); }
                finally { t.cancel(); }
            }
        });
        reply.done(value("ok",true,"transferId",t.id));
    }
    void write(String owner, String id, int seq, String encoded, boolean save, Reply reply) {
        byte[] data=decode(encoded);
        Transfer t=get(id); t.claim(owner,save?"save":"upload",seq);
        if (!save && t.bytes+data.length>t.declared) { t.busy=false; throw new IllegalArgumentException("invalid-bytes"); }
        workers.execute(() -> {
            try {
                if(save) { if(t.output==null)throw new IOException("cancelled"); t.output.write(data); }
                else {
                    if(t.result.isDone()) { Map<String,Object> out=t.result.get(); remove(t); reply.done(out); return; }
                    Chunk c=new Chunk(data,false);
                    if(!t.queue.offer(c)) throw new IOException("busy");
                    c.consumed.await();
                    if(t.result.isDone()) { Map<String,Object> out=t.result.get(); remove(t); reply.done(out); return; }
                    if(t.cancelled) throw new IOException("cancelled");
                }
                t.consumed(data.length); reply.done(value("ok",true));
            } catch(IOException | InterruptedException | ExecutionException | RuntimeException e) { remove(t); reply.done(error("cancelled")); }
        });
    }
    void finish(String owner, String id, int seq, boolean save, Reply reply) {
        Transfer t=get(id); t.claim(owner,save?"save":"upload",seq);
        if(!save && t.bytes!=t.declared) { t.busy=false; throw new IllegalArgumentException("invalid-bytes"); }
        t.finishing=true;
        workers.execute(() -> {
            try {
                Map<String,Object> out;
                if(save) {
                    OutputStream output;
                    synchronized(t) { output=t.output; if(t.cancelled || output==null)throw new IOException("cancelled"); }
                    output.flush(); output.close();
                    synchronized(t) {
                        if(t.cancelled)throw new IOException("cancelled");
                        t.output=null; t.saveCommitted=true;
                    }
                    out=value("ok",true);
                }
                else { if(!t.queue.offer(new Chunk(new byte[0],true)))throw new IOException("busy"); out=t.result.get(); }
                remove(t); reply.done(out);
            } catch(IOException | InterruptedException | ExecutionException | RuntimeException e) { remove(t); reply.done(error("cancelled")); }
        });
    }
    static Map<String,Object> httpResult(Response response) {
        String body=null;
        try {
            if(response.body()!=null) {
                InputStream input=response.body().byteStream();
                ByteArrayOutputStream output=new ByteArrayOutputStream();
                byte[] chunk=new byte[4096]; int count;
                while((count=input.read(chunk))!=-1) {
                    if(output.size()+count>65536)throw new IOException("response-bound");
                    output.write(chunk,0,count);
                }
                body=new String(output.toByteArray(),java.nio.charset.StandardCharsets.UTF_8);
            }
        } catch(IOException | RuntimeException ignored) { body=null; }
        return value("ok",response.isSuccessful() && body!=null,"status",response.code(),"body",body);
    }
    void download(String owner, String url, String token, Reply reply) {
        Transfer t=add(owner,"download",0);
        t.call=http.newCall(new Request.Builder().url(url).header("Authorization","Bearer "+token).get().build());
        workers.execute(() -> {
            try {
                Response r=t.call.execute();
                if(!r.isSuccessful() || r.body()==null) {
                    try(Response ignored=r) { Map<String,Object> out=httpResult(r); remove(t); reply.done(out); } return;
                }
                t.input=r.body().byteStream();
                if(t.cancelled) { r.close(); throw new IOException("cancelled"); }
                long length=r.body().contentLength();
                Map<String,Object> out=value("ok",true,"transferId",t.id,"status",r.code());
                if(length>=0 && length<=MAX_SAFE)out.put("bytes",length);
                reply.done(out);
            } catch(IOException | RuntimeException e) { remove(t); reply.done(error("network")); }
        });
    }
    void read(String owner, String id, int seq, Reply reply) {
        Transfer t=get(id); t.claim(owner,"download",seq);
        workers.execute(() -> {
            try {
                byte[] data=new byte[CHUNK]; int count=t.input.read(data);
                if(t.cancelled)throw new IOException("cancelled");
                t.consumed(Math.max(count,0));
                if(count<0)remove(t);
                reply.done(value("ok",true,"data",count<0?"":Base64.encodeToString(Arrays.copyOf(data,count),Base64.NO_WRAP),"eof",count<0));
            } catch(IOException | RuntimeException e) { remove(t); reply.done(error("network")); }
        });
    }
    static int pickerRequestCode() {
        int code=nextPicker.getAndIncrement();
        if(code<PICK_DOCUMENT || code>65534)throw new IllegalArgumentException("picker-limit");
        return code;
    }
    static boolean ownsPickerRequestCode(int code) {
        return code>=PICK_DOCUMENT && code<=65534 && code<nextPicker.get();
    }
    static boolean documentUriSyntax(String raw) {
        try {
            URI uri=new URI(raw);
            String path=uri.getRawPath();
            return "content".equals(uri.getScheme()) && uri.getHost()!=null && uri.getUserInfo()==null
                && uri.getPort()==-1 && uri.getFragment()==null && uri.getQuery()==null
                && path!=null && (path.startsWith("/document/") || path.matches("/tree/[^/]+/document/.+"))
                && !uri.getHost().equals("localhost") && !uri.getHost().equals("io.ditero.app");
        } catch(Exception error) { return false; }
    }
    private boolean documentUri(Uri uri) {
        return uri!=null && documentUriSyntax(uri.toString()) && DocumentsContract.isDocumentUri(activity,uri);
    }
    private void deleteDocument(Uri uri) {
        cleanup.execute(() -> {
            try { if(documentUri(uri))DocumentsContract.deleteDocument(activity.getContentResolver(),uri); }
            catch(IOException | RuntimeException ignored) {}
        });
    }
    synchronized void cancelPending(String owner) {
        if(pendingSave==null)return;
        if(!pendingSave.owner.equals(owner))throw new IllegalArgumentException("invalid-capability");
        remove(pendingSave);
    }
    synchronized void pick(String owner, String filename, Reply reply) {
        if(pendingSave!=null || picks.size()>=MAX_ACTIVE)throw new IllegalArgumentException("busy");
        if(filename==null || filename.length()<1 || filename.length()>255 || filename.indexOf('/')>=0 || filename.indexOf('\\')>=0 || filename.chars().anyMatch(c->c<32 || c==127))throw new IllegalArgumentException("invalid-filename");
        int code=pickerRequestCode();
        Transfer t=add(owner,"save",0); registerPick(code,t,reply);
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,filename);
        try { activity.startActivityForResult(intent,code); }
        catch(RuntimeException error) { picks.remove(code); remove(t); reply.done(error("picker-unavailable")); }
    }
    synchronized Pick takePick(int code) { return picks.remove(code); }
    synchronized void registerPick(int code, Transfer t, Reply reply) { picks.put(code,new Pick(t,reply)); pendingSave=t; }
    synchronized boolean activityResult(int requestCode, int resultCode, Intent data) {
        if(!ownsPickerRequestCode(requestCode))return false;
        Pick pick=takePick(requestCode);
        Uri uri=data==null?null:data.getData();
        if(pick==null) { if(resultCode==Activity.RESULT_OK && documentUri(uri))deleteDocument(uri); return true; }
        Transfer t=pick.transfer; Reply reply=pick.reply;
        if(resultCode!=Activity.RESULT_OK || !documentUri(uri)) { remove(t); reply.done(error("cancelled")); return true; }
        synchronized(t) { t.document=uri; }
        if(t.cancelled) { deleteDocument(uri); reply.done(error("cancelled")); return true; }
        workers.execute(() -> {
            try {
                OutputStream output=activity.getContentResolver().openOutputStream(uri,"w");
                synchronized(t) { if(t.cancelled || output==null) { close(output); throw new IOException("cancelled"); } t.output=output; }
                reply.done(value("ok",true,"saveId",t.id));
            } catch(IOException | RuntimeException error) { remove(t); reply.done(error("save-failed")); }
        });
        return true;
    }
}
