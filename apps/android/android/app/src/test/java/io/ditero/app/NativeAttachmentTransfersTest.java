package io.ditero.app;
import static org.junit.Assert.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.io.OutputStream;
import java.util.Map;
import org.junit.Test;
public class NativeAttachmentTransfersTest {
 private static void rejects(Runnable operation) { try { operation.run(); fail("must reject"); } catch(IllegalArgumentException expected) {} }
 @Test public void pathsAreFixedAndIdsCannotRetargetRequests() {
 assertEquals("/api/native/attachments/task_A-1/upload",NativeAttachmentTransfers.attachmentPath("task_A-1",false,true));
 assertEquals("/api/native/attachments/task_A-1/thumbnail",NativeAttachmentTransfers.attachmentPath("task_A-1",true,false));
 for(String id:new String[]{"..","a/b","https://other.example","a?b","a%2Fb",""}) rejects(() -> NativeAttachmentTransfers.attachmentPath(id,false,false));
 }
 @Test public void decodedChunksStayWithinTheSingleChunkMemoryBound() {
 NativeAttachmentTransfers.validateChunk(new byte[32768]);
 rejects(() -> NativeAttachmentTransfers.validateChunk(new byte[32769]));
 rejects(() -> NativeAttachmentTransfers.validateChunk(new byte[0]));
 }
 @Test public void declaredBytesMustBePositiveSafeIntegers() {
 assertEquals(32768,NativeAttachmentTransfers.positiveBytes(32768));
 for(Object bytes:new Object[]{0,-1,1.5,Double.NaN,Double.POSITIVE_INFINITY,9007199254740992d,"12"}) rejects(() -> NativeAttachmentTransfers.positiveBytes(bytes));
 }
 @Test public void sequenceAndCapturedOwnerPreventStaleOrConcurrentWrites() {
 NativeAttachmentTransfers.Transfer t=new NativeAttachmentTransfers.Transfer("origin/user/session/page/gen","upload",65536);
 rejects(() -> t.claim("different-session","upload",0)); rejects(() -> t.claim(t.owner,"save",0)); rejects(() -> t.claim(t.owner,"upload",1));
 t.claim(t.owner,"upload",0); rejects(() -> t.claim(t.owner,"upload",0)); t.consumed(32768);
 rejects(() -> t.claim(t.owner,"upload",0)); t.claim(t.owner,"upload",1); assertEquals(32768,t.bytes);
 }
 @Test public void oneChunkQueueAndCancellationUnblockQueuedAndConsumingChunks() throws Exception {
 NativeAttachmentTransfers.Transfer t=new NativeAttachmentTransfers.Transfer("owner","upload",65536);
 NativeAttachmentTransfers.Chunk queued=new NativeAttachmentTransfers.Chunk(new byte[32768],false), consuming=new NativeAttachmentTransfers.Chunk(new byte[32768],false);
 assertTrue(t.queue.offer(queued)); assertFalse(t.queue.offer(new NativeAttachmentTransfers.Chunk(new byte[1],false))); t.consuming=consuming; t.cancel();
 assertTrue(queued.consumed.await(1,TimeUnit.SECONDS)); assertTrue(consuming.consumed.await(1,TimeUnit.SECONDS)); assertTrue(t.result.isDone()); rejects(() -> t.claim("owner","upload",0));
 }
 @Test public void capabilityLimitAndScopeCancellationAreEnforced() {
 NativeAttachmentTransfers transfers=new NativeAttachmentTransfers(null,null);
 try {
 NativeAttachmentTransfers.Transfer first=transfers.add("owner","download",0);
 for(int n=1;n<4;n++)transfers.add("owner","save",0);
 rejects(() -> transfers.add("owner","upload",1)); rejects(() -> transfers.cancel(first.id,"other-owner")); transfers.cancelAll(); assertTrue(first.cancelled); rejects(() -> transfers.get(first.id)); transfers.add("new-owner","upload",1);
 } finally { transfers.shutdown(); }
 }

 @Test public void cancelledPickerResultCannotBindToItsReplacement() {
 NativeAttachmentTransfers transfers=new NativeAttachmentTransfers(null,null);
 try {
 int oldCode=NativeAttachmentTransfers.pickerRequestCode(), newCode=NativeAttachmentTransfers.pickerRequestCode();
 assertNotEquals(oldCode,newCode);
 assertTrue(NativeAttachmentTransfers.ownsPickerRequestCode(oldCode));
 assertFalse(NativeAttachmentTransfers.ownsPickerRequestCode(1));
 assertFalse(NativeAttachmentTransfers.ownsPickerRequestCode(65534));
 NativeAttachmentTransfers.Transfer old=transfers.add("old-owner","save",0);
 transfers.registerPick(oldCode,old,value -> {});
 rejects(() -> transfers.cancelPending("new-owner"));
 transfers.cancelPending("old-owner");
 NativeAttachmentTransfers.Transfer replacement=transfers.add("new-owner","save",0);
 transfers.registerPick(newCode,replacement,value -> {});
 assertSame(old,transfers.takePick(oldCode).transfer);
 assertTrue(old.cancelled);
 assertFalse(replacement.cancelled);
 assertNull(transfers.takePick(oldCode));
 assertSame(replacement,transfers.takePick(newCode).transfer);
 } finally { transfers.shutdown(); }
 }
 @Test public void onlyDocumentContentUriSyntaxCanReachTheSafProvider() {
 assertTrue(NativeAttachmentTransfers.documentUriSyntax("content://com.android.providers.downloads.documents/document/42"));
 assertTrue(NativeAttachmentTransfers.documentUriSyntax("content://provider.documents/tree/root/document/file"));
 for(String uri:new String[]{"file:///data/user/0/io.ditero.app/session","https://provider/document/42","content://io.ditero.app/document/private","content://localhost/document/private","content://provider/private/path","content://user@provider/document/42","content://provider/document/42?target=secret"})assertFalse(NativeAttachmentTransfers.documentUriSyntax(uri));
 }
 @Test public void saveFinishCancellationDuringFlushAlwaysRepliesOnce() throws Exception {
 NativeAttachmentTransfers transfers=new NativeAttachmentTransfers(null,null);
 try {
 NativeAttachmentTransfers.Transfer t=transfers.add("owner","save",0);
 t.output=new OutputStream() {
 public void write(int data) {}
 public void flush() { transfers.cancel(t.id,"owner"); }
 };
 CompletableFuture<Map<String,Object>> result=new CompletableFuture<>();
 AtomicInteger replies=new AtomicInteger();
 transfers.finish("owner",t.id,0,true,value -> { replies.incrementAndGet(); result.complete(value); });
 assertEquals(false,result.get(2,TimeUnit.SECONDS).get("ok"));
 assertEquals(1,replies.get());
 assertFalse(t.saveCommitted);
 } finally { transfers.shutdown(); }
 }

 @Test public void absentThumbnailAcceptsTheParserJsonNullSentinel() {
 NativeAttachmentTransfers.optionalPositiveBytes(org.json.JSONObject.NULL,org.json.JSONObject.NULL);
 // Android's host test jar may stub NULL; a non-null identity exercises the parser's real device representation.
 Object jsonNull=new Object();
 NativeAttachmentTransfers.optionalPositiveBytes(jsonNull,jsonNull);
 NativeAttachmentTransfers.optionalPositiveBytes(null,jsonNull);
 NativeAttachmentTransfers.optionalPositiveBytes(268d,jsonNull);
 rejects(() -> NativeAttachmentTransfers.optionalPositiveBytes(0d,jsonNull));
 rejects(() -> NativeAttachmentTransfers.optionalPositiveBytes("268",jsonNull));
 rejects(() -> NativeAttachmentTransfers.optionalPositiveBytes(new Object(),jsonNull));
 System.out.println("Android host JSON null sentinel is non-null: "+(org.json.JSONObject.NULL!=null));
 }
}
