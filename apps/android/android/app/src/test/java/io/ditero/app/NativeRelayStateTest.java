package io.ditero.app;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class NativeRelayStateTest {
    private final Map<String,Object> durable=new HashMap<>();
    private boolean failCommit,current=true,failActivate;
    private String registration;
    private SharedPreferences prefs() {
        return (SharedPreferences)Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{SharedPreferences.class},(proxy,method,args)-> {
            switch(method.getName()) {
                case "getString":return durable.getOrDefault(args[0],args[1]);
                case "contains":return durable.containsKey(args[0]);
                case "edit":
                    Map<String,Object> puts=new HashMap<>();
                    return Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{SharedPreferences.Editor.class},(editor,m,a)-> {
                        if(m.getName().equals("putString")) {puts.put((String)a[0],a[1]);return editor;}
                        if(m.getName().equals("commit")) {if(failCommit)return false;durable.putAll(puts);return true;}
                        throw new AssertionError(m.getName());
                    });
                default:throw new AssertionError(method.getName());
            }
        });
    }
    private NativeRelayStore store() {
        return new NativeRelayStore(prefs(),new NativeRelayStore.Codec() {
            public String seal(String scope,Map<String,Object> value) {return NativeRelayProtocol.canonical(Map.of("scope",scope,"value",value));}
            public Map<String,Object> open(String scope,String value) {
                Map<String,Object> envelope=NativeRelayProtocol.parseObject(value);assertEquals(scope,envelope.get("scope"));
                return NativeRelayStore.object(envelope.get("value"));
            }
        });
    }
    private static KeyPair pair() throws Exception {KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));return gen.generateKeyPair();}
    private static String sign(KeyPair key,String type,String kid,Map<String,Object> claims) throws Exception {
        Base64.Encoder encoder=Base64.getUrlEncoder().withoutPadding();
        String header=encoder.encodeToString(NativeRelayProtocol.canonical(Map.of("alg","ES256","typ",type,"kid",kid)).getBytes(StandardCharsets.UTF_8));
        String body=encoder.encodeToString(NativeRelayProtocol.canonical(claims).getBytes(StandardCharsets.UTF_8));
        Signature signer=Signature.getInstance("SHA256withECDSA");signer.initSign(key.getPrivate());signer.update((header+"."+body).getBytes(StandardCharsets.US_ASCII));
        return header+"."+body+"."+encoder.encodeToString(NativeRelayProtocol.derToRaw(signer.sign()));
    }
    private NativePushStore.Owner owner() throws Exception {
        Map<String,Object> record=new HashMap<>();record.put("token","private-token");record.put("sessionId","session");record.put("userId","user");
        record.put("deviceId","device");record.put("expiresAt","2099-01-01T00:00:00Z");record.put("verified",true);
        record.put("profile",Map.of("id","user","name","User","email","user@example.test"));
        record.put("zeroUrl","https://zero.example.test");record.put("workspaceId","workspace");
        return new NativePushStore.Owner("11111111-1111-4111-8111-111111111111",NativeSessionVault.capture(ServerContext.parse("https://instance.example.test"),record,false));
    }
    private final class Fixture {
        final NativePushStore.Owner owner=owner();
        final KeyPair device=pair(),sender=pair(),receipt=pair();
        final Map<String,Object> jwk=NativeRelayProtocol.publicJwk(device.getPublic()),senderKey=NativeRelayProtocol.publicJwk(sender.getPublic());
        final NativeRelayStore store=store();
        final Map<String,Map<String,Object>> outcomes=new HashMap<>();
        String target=NativeRelayProtocol.opaqueId(),offerId=NativeRelayProtocol.opaqueId(),send=NativeRelayProtocol.opaqueId(),challenge=NativeRelayProtocol.opaqueId();
        long expires=System.currentTimeMillis()/1000+300;
        int sends,activations,statuses,retireGeneration;
        boolean loseEnroll,loseConfirm,replaceOwnerOnActivate,expireActivate,loseCancel,refuseRetire;
        int cancellations;
        String lastManagement,lastConfirmSecret;
        Map<String,Object> lastEnroll;
        final NativePushProvider provider=new NativePushProvider() {
            public String id(){return "google";}public boolean available(){return true;}
            public void enable(Activity activity,NativePushStore.Owner owner){}public void resume(NativePushStore.Owner owner){}public void retire(NativePushStore.Owner owner){}
            public String relayOrigin(){return "https://relay.example.test";}public Map<String,Object> receiptKeys(){try{return Map.of("pinned",NativeRelayProtocol.publicJwk(receipt.getPublic()));}catch(Exception e){throw new AssertionError(e);}}
            public String appCheck(){return "attestation";}
        };
        Fixture() throws Exception {}
        NativeRelayClient client() {
            return new NativeRelayClient(store,provider,new NativeRelayClient.Authority() {
                public boolean current(NativePushStore.Owner value){return current && owner.instance.equals(value.instance);}
                public boolean activate(NativePushStore.Owner value,String id){if(failActivate)return false;registration=id;return true;}
            },request -> {
                okio.Buffer buffer=new okio.Buffer();request.body().writeTo(buffer);Map<String,Object> body=NativeRelayProtocol.parseObject(buffer.readUtf8());
                String path=request.url().encodedPath();
                if(path.startsWith("/api/")) {assertEquals("Bearer private-token",request.header("Authorization"));assertEquals("instance.example.test",request.url().host());}
                else {assertNull(request.header("Authorization"));assertEquals("relay.example.test",request.url().host());assertTrue(body.containsKey("deviceProof"));assertTrue(body.containsKey("appCheck"));}
                if(path.endsWith("/offer")) {
                    Map<String,Object> claims=new LinkedHashMap<>();claims.put("aud",provider.relayOrigin());claims.put("iat",expires-300);claims.put("exp",expires);
                    claims.put("installationId",body.get("installationId"));claims.put("offerId",offerId);claims.put("targetId",target);claims.put("registrationId","registration-1");
                    claims.put("senderKey",senderKey);claims.put("deviceThumbprint",NativeRelayProtocol.thumbprint(jwk));claims.put("sendCapabilityHash",NativeRelayProtocol.credentialHash("send",send));
                    return Map.of("offer",sign(sender,NativeRelayProtocol.OFFER_TYPE,NativeRelayProtocol.thumbprint(senderKey),claims),"offerId",offerId,
                            "relayOrigin",provider.relayOrigin(),"installationId",body.get("installationId"),"targetId",target,"registrationId","registration-1","senderKey",senderKey,"sendCapability",send,"expiresAt","ignored");
                }
                if(path.equals("/v1/operations/status")) {statuses++;Map<String,Object> result=outcomes.get(body.get("queriedOperationId"));if(result==null)throw new NativeRelayClient.Refused(404);return result;}
                if(path.equals("/v1/enroll") || path.equals("/v1/manage/replace-fid")) {
                    sends++;assertNotNull(store.target(owner.instance).get("operation"));
                    if(path.equals("/v1/enroll"))lastEnroll=body;
                    assertTrue(store.challenge(owner.instance,"registration-1",challenge));
                    Map<String,Object> result=Map.of("kind","issued");outcomes.put((String)body.get("operationId"),result);
                    if(loseEnroll){loseEnroll=false;throw new java.io.IOException("lost response");}return result;
                }
                if(path.equals("/v1/confirm") || path.equals("/v1/manage/rotate")) {
                    lastConfirmSecret=(String)body.get("managementSecret");
                    Map<String,Object> value=store.target(owner.instance),claims=new LinkedHashMap<>();
                    for(String field:new String[]{"offerId","offerExpires","registrationId","targetId","installationId","senderKey","senderThumbprint","deviceThumbprint","sendCapabilityHash"})claims.put(field,value.get(field));
                    claims.put("relayOrigin",provider.relayOrigin());claims.put("aud",provider.relayOrigin());claims.put("iss",provider.relayOrigin());claims.put("iat",System.currentTimeMillis()/1000);
                    int generation=((Number)value.get("generation")).intValue()+(value.containsKey("nextFid")?1:0),version=((Number)value.get("credentialVersion")).intValue()+(value.containsKey("nextSecret")?1:0);
                    claims.put("generation",generation);claims.put("credentialVersion",version);claims.put("fidHash",NativeRelayProtocol.fidHash((String)value.get(value.containsKey("nextFid")?"nextFid":"fid")));
                    Map<String,Object> result=Map.of("kind",path.endsWith("rotate")?"rotated":"confirmed","receipt",sign(receipt,NativeRelayProtocol.RECEIPT_TYPE,"pinned",claims));
                    outcomes.put((String)body.get("operationId"),result);
                    if(loseConfirm){loseConfirm=false;throw new java.io.IOException("lost response");}return result;
                }
                if(path.endsWith("/cancel")) {
                    cancellations++;
                    if(loseCancel) {loseCancel=false;throw new java.io.IOException("lost cancel ack");}
                    target=NativeRelayProtocol.opaqueId();offerId=NativeRelayProtocol.opaqueId();challenge=NativeRelayProtocol.opaqueId();expires=System.currentTimeMillis()/1000+300;
                    return Map.of("cancelled",true);
                }
                if(path.endsWith("/activate") || path.endsWith("/update")) {
                    if(expireActivate) {expireActivate=false;throw new NativeRelayClient.Refused(409,"offer-unavailable");}
                    activations++;if(replaceOwnerOnActivate)current=false;
                    if(path.endsWith("/activate"))return Map.of("registrationId","registration-1","provider","fcm-relay");
                    return Map.of("registrationId","registration-1","generation",store.target(owner.instance).get("receiptGeneration"));
                }
                if(path.endsWith("/retire")) {if(refuseRetire)throw new NativeRelayClient.Refused(404,"not_found");retireGeneration=((Number)body.get("generation")).intValue();lastManagement=(String)body.get("managementSecret");return Map.of("kind","retired");}
                throw new AssertionError(path);
            },new NativeRelayClient.DeviceKey() {
                public java.security.PrivateKey privateKey(){return device.getPrivate();}public Map<String,Object> publicKey(){return jwk;}
            });
        }
    }
    @Test public void failedCommitPreventsDispatchAndPreservesPhysicalIdentity() throws Exception {
        Fixture fixture=new Fixture();failCommit=true;
        try{fixture.client().registered(fixture.owner,"fid-1");fail();}catch(java.io.IOException expected){}
        assertEquals(0,fixture.sends);assertNull(fixture.store.target(fixture.owner.instance));
        failCommit=false;fixture.client().registered(fixture.owner,"fid-1");Map<String,Object> installation=store().installation();
        assertNotNull(installation.get("installationId"));assertEquals(fixture.jwk,installation.get("deviceKey"));
    }
    @Test public void deliveredChallengeSurvivesLostEnrollmentResponseAndRestart() throws Exception {
        Fixture fixture=new Fixture();fixture.loseEnroll=true;fixture.client().registered(fixture.owner,"fid-1");
        try{fixture.client().drain(fixture.owner);fail();}catch(java.io.IOException expected){}
        assertEquals(fixture.challenge,store().target(fixture.owner.instance).get("challenge"));assertNull(registration);
        assertTrue(fixture.client().drain(fixture.owner));assertEquals(1,fixture.sends);assertEquals(1,fixture.statuses);
        assertEquals("registration-1",registration);assertFalse(fixture.store.suppressed(fixture.owner.instance));
    }
    @Test public void activeRegistrationCommitFailureIsRepairedAfterRestart() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");failActivate=true;
        try{fixture.client().drain(fixture.owner);fail();}catch(java.io.IOException expected){}
        assertNull(registration);assertEquals("active",store().target(fixture.owner.instance).get("phase"));
        failActivate=false;assertTrue(fixture.client().drain(fixture.owner));assertEquals("registration-1",registration);assertEquals(1,fixture.activations);
    }
    @Test public void replacementRetainsPredecessorUntilReceiptAndLiveInstanceUpdate() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");assertTrue(fixture.client().drain(fixture.owner));
        String old=(String)fixture.store.target(fixture.owner.instance).get("managementSecret");
        fixture.client().registered(fixture.owner,"fid-2");Map<String,Object> pending=fixture.store.target(fixture.owner.instance);
        assertEquals(old,pending.get("managementSecret"));assertNotEquals(old,pending.get("nextSecret"));assertTrue(fixture.store.suppressed(fixture.owner.instance));
        fixture.loseConfirm=true;
        try{fixture.client().drain(fixture.owner);fail();}catch(java.io.IOException expected){}
        assertTrue(fixture.client().drain(fixture.owner));Map<String,Object> active=fixture.store.target(fixture.owner.instance);
        assertEquals("fid-2",active.get("fid"));assertEquals(2.0,active.get("generation"));assertNotEquals(old,active.get("managementSecret"));assertFalse(active.containsKey("nextSecret"));
    }
    @Test public void retiredReplacementRecoversLostConfirmationAndUsesNewGeneration() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");assertTrue(fixture.client().drain(fixture.owner));
        fixture.client().registered(fixture.owner,"fid-2");fixture.loseConfirm=true;
        try{fixture.client().drain(fixture.owner);fail();}catch(java.io.IOException expected){}
        String next=(String)fixture.store.target(fixture.owner.instance).get("nextSecret");current=false;
        assertTrue(fixture.client().retire(fixture.owner.instance));assertEquals(2,fixture.retireGeneration);assertEquals(next,fixture.lastManagement);
    }
    @Test public void staleOwnerCannotActivateOrDisplayPendingAndForeignChallengeIsIgnored() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");
        assertFalse(fixture.store.challenge(fixture.owner.instance,"foreign",fixture.challenge));fixture.replaceOwnerOnActivate=true;
        assertFalse(fixture.client().drain(fixture.owner));assertNull(registration);assertTrue(fixture.store.suppressed(fixture.owner.instance));
        assertFalse(fixture.client().drain(fixture.owner));assertTrue(fixture.client().retire(fixture.owner.instance));
    }
    @Test public void lateEnrollmentResponseCannotEraseConcurrentChallenge() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");
        Map<String,Object> state=fixture.store.target(fixture.owner.instance);state.put("phase","enroll");state.put("registrationId","registration-1");state.put("operation",Map.of("operationId",NativeRelayProtocol.opaqueId()));
        assertTrue(fixture.store.save(fixture.owner.instance,state));Map<String,Object> stale=fixture.store.target(fixture.owner.instance);
        assertTrue(fixture.store.challenge(fixture.owner.instance,"registration-1",fixture.challenge));stale.put("issued",true);
        assertTrue(fixture.store.save(fixture.owner.instance,stale));assertEquals(fixture.challenge,store().target(fixture.owner.instance).get("challenge"));
        assertFalse(fixture.store.challenge(fixture.owner.instance,"registration-1",NativeRelayProtocol.opaqueId()));
    }
    @Test public void newerFidDuringPendingReplacementPreservesOperationThenStartsNextGeneration() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");assertTrue(fixture.client().drain(fixture.owner));
        fixture.client().registered(fixture.owner,"fid-2");String operation=NativeRelayProtocol.canonical(fixture.store.target(fixture.owner.instance).get("operation"));
        fixture.client().registered(fixture.owner,"fid-3");Map<String,Object> pending=fixture.store.target(fixture.owner.instance);
        assertEquals(operation,NativeRelayProtocol.canonical(pending.get("operation")));assertEquals("fid-2",pending.get("nextFid"));assertEquals("fid-3",pending.get("desiredFid"));
        fixture.client().drain(fixture.owner);assertTrue(fixture.client().drain(fixture.owner));
        Map<String,Object> active=fixture.store.target(fixture.owner.instance);assertEquals("fid-3",active.get("fid"));assertEquals(3.0,active.get("generation"));
    }

    @Test public void terminalActivation409RequiresCancelAckBeforeFreshOfferAndArchivesSecrets() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");fixture.expireActivate=true;fixture.loseCancel=true;
        String old=(String)fixture.store.target(fixture.owner.instance).get("managementSecret");
        try{fixture.client().drain(fixture.owner);fail();}catch(java.io.IOException expected){}
        Map<String,Object> blocked=fixture.store.target(fixture.owner.instance);assertEquals("reset",blocked.get("phase"));assertEquals(old,blocked.get("managementSecret"));
        assertEquals(1,fixture.sends);assertNull(registration);assertTrue(fixture.store.suppressed(fixture.owner.instance));
        assertTrue(fixture.client().drain(fixture.owner));assertEquals(2,fixture.cancellations);assertEquals(2,fixture.sends);assertNotEquals(old,fixture.store.target(fixture.owner.instance).get("managementSecret"));
        assertTrue(durable.keySet().stream().anyMatch(key->key.startsWith(fixture.owner.instance+".relay-retired.")));
    }
    @Test public void expiredReplacementRestartsWithLatestFidAfterAuthoritativeCancel() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");assertTrue(fixture.client().drain(fixture.owner));
        fixture.client().registered(fixture.owner,"fid-2");fixture.client().registered(fixture.owner,"fid-3");
        Map<String,Object> pending=fixture.store.target(fixture.owner.instance);pending.put("pendingExpires",System.currentTimeMillis()/1000-1);assertTrue(fixture.store.save(fixture.owner.instance,pending));
        assertTrue(fixture.client().drain(fixture.owner));assertEquals(1,fixture.cancellations);assertEquals("fid-3",fixture.store.target(fixture.owner.instance).get("fid"));assertEquals(1.0,fixture.store.target(fixture.owner.instance).get("generation"));
    }
    @Test public void missingRelayTarget404DoesNotClaimRetirementWithoutInstanceAuthority() throws Exception {
        Fixture fixture=new Fixture();fixture.client().registered(fixture.owner,"fid-1");assertTrue(fixture.client().drain(fixture.owner));fixture.refuseRetire=true;
        try{fixture.client().retire(fixture.owner.instance);fail("404 claimed retirement");}catch(NativeRelayClient.Refused expected){assertEquals(404,expected.status);}
        assertEquals("retire",fixture.store.target(fixture.owner.instance).get("phase"));assertTrue(fixture.store.target(fixture.owner.instance).containsKey("managementSecret"));
    }

}
