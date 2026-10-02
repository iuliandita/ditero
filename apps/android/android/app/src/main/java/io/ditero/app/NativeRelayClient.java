package io.ditero.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.net.Proxy;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Fixed trusted relay, captured instance routes, immutable retry bodies, and no JavaScript secrets. */
final class NativeRelayClient {
    static final class Refused extends java.io.IOException {
        final int status;final String code;
        Refused(int status) {this(status,"");}
        Refused(int status,String code) {super("relay request refused");this.status=status;this.code=code;}
    }
    interface Transport {Map<String,Object> send(Request request) throws Exception;}
    interface DeviceKey {PrivateKey privateKey() throws Exception;Map<String,Object> publicKey() throws Exception;}
    interface Authority {boolean current(NativePushStore.Owner owner);boolean activate(NativePushStore.Owner owner,String registration);}
    private static final String DEVICE_ALIAS="io.ditero.app.native.relay.device.v1";
    private final NativeRelayStore store;
    private final NativePushProvider provider;
    private final Transport transport;
    private final DeviceKey key;
    private final Authority authority;
    NativeRelayClient(NativeRelayStore store,NativePushProvider provider,Authority authority) {
        this(store,provider,authority,productionTransport(),new DeviceKey() {
            private KeyStore load() throws Exception {
                KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
                if(!ks.containsAlias(DEVICE_ALIAS)) {
                    KeyPairGenerator generator=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore");
                    generator.initialize(new KeyGenParameterSpec.Builder(DEVICE_ALIAS,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY)
                            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());
                    generator.generateKeyPair();
                }
                return ks;
            }
            public PrivateKey privateKey() throws Exception {
                PrivateKey value=(PrivateKey)load().getKey(DEVICE_ALIAS,null);
                if(value.getEncoded()!=null) throw new IllegalStateException("exportable device key");
                return value;
            }
            public Map<String,Object> publicKey() throws Exception {return NativeRelayProtocol.publicJwk(load().getCertificate(DEVICE_ALIAS).getPublicKey());}
        });
    }
    NativeRelayClient(NativeRelayStore store,NativePushProvider provider,Authority authority,Transport transport,DeviceKey key) {
        this.store=store;this.provider=provider;this.authority=authority;this.transport=transport;this.key=key;
    }
    private static Transport productionTransport() {
        OkHttpClient http=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).proxy(Proxy.NO_PROXY)
                .connectTimeout(10,TimeUnit.SECONDS).readTimeout(10,TimeUnit.SECONDS).writeTimeout(10,TimeUnit.SECONDS)
                .callTimeout(10,TimeUnit.SECONDS).build();
        return request -> {
            if(!request.url().isHttps()) throw new IllegalArgumentException("https required");
            try(Response response=http.newCall(request).execute()) {
                byte[] bytes=response.peekBody(16385).bytes();
                if(bytes.length>16384) throw new java.io.IOException("relay body limit");
                String raw=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                Map<String,Object> body=NativeRelayProtocol.parseObject(raw);
                if(response.code()!=200)throw new Refused(response.code(),body.get("code") instanceof String?(String)body.get("code"):"");
                return body;
            }
        };
    }
    void registered(NativePushStore.Owner owner,String fid) throws Exception {
        if(!authority.current(owner) || fid==null || !fid.matches("[A-Za-z0-9._:-]{1,4096}")) return;
        Map<String,Object> installation=store.installation();
        Map<String,Object> publicKey=key.publicKey();
        if(installation==null) {
            installation=new LinkedHashMap<>();installation.put("installationId",NativeRelayProtocol.opaqueId());installation.put("deviceKey",publicKey);
            require(store.installation(installation));
        } else if(!NativeRelayProtocol.canonical(publicKey).equals(NativeRelayProtocol.canonical(installation.get("deviceKey"))))
            throw new IllegalStateException("device key changed");
        require(store.begin(owner,fid,installation));
        Map<String,Object> value=store.target(owner.instance);
        if("active".equals(value.get("phase")) && !fid.equals(value.get("fid"))) startManagement(owner,value,fid);
        else if(!fid.equals(value.get(value.containsKey("nextFid")?"nextFid":"fid"))) {
            value.put("desiredFid",fid);require(store.save(owner.instance,value));
        }
    }
    void rotate(NativePushStore.Owner owner) throws Exception {
        if(!authority.current(owner)) return;
        Map<String,Object> value=store.target(owner.instance);
        if(value!=null && "active".equals(value.get("phase"))) startManagement(owner,value,null);
    }
    private void startManagement(NativePushStore.Owner owner,Map<String,Object> value,String fid) throws Exception {
        value.put("nextSecret",NativeRelayProtocol.opaqueId());
        if(fid!=null) value.put("nextFid",fid);
        value.remove("challenge");value.remove("receipt");value.put("phase",fid==null?"rotate":"replace");
        if(fid!=null)value.put("pendingExpires",now()+300);
        Map<String,Object> body=base(value);body.put("generation",value.get("generation"));
        body.put("managementSecret",value.get("managementSecret"));body.put("newManagementSecret",value.get("nextSecret"));
        if(fid!=null) body.put("fid",fid);
        operation(value,fid==null?"/v1/manage/rotate":"/v1/manage/replace-fid",body);
        require(store.save(owner.instance,value));
    }
    boolean drain(NativePushStore.Owner owner) throws Exception {
        if(!authority.current(owner)) return false;
        for(int step=0;step<6;step++) {
            Map<String,Object> value=store.target(owner.instance);
            if(value==null) return true;
            String phase=(String)value.get("phase");
            if("reset".equals(phase)) {if(!reset(owner,value)) return false;continue;}
            boolean possession="enroll".equals(phase) || "replace".equals(phase) || "confirm".equals(phase);
            Object deadline=value.get(value.containsKey("nextFid")?"pendingExpires":"offerExpires");
            if(possession && deadline instanceof Number && ((Number)deadline).longValue()<=now()) {
                value.put("phase","reset");require(store.save(owner.instance,value));
                if(!reset(owner,value))return false;continue;
            }
            if("offer".equals(phase) && value.get("offerStarted") instanceof Number
                    && ((Number)value.get("offerStarted")).longValue()+300<=now()) {
                require(store.restart(owner.instance,value,latestFid(value)));continue;
            }
            if("active".equals(phase)) {
                require(authority.activate(owner,(String)value.get("registrationId")));
                if(value.containsKey("desiredFid") && !value.get("desiredFid").equals(value.get("fid"))) {
                    String desired=(String)value.remove("desiredFid");startManagement(owner,value,desired);continue;
                }
                return true;
            }
            if("offer".equals(phase)) {
                Map<String,Object> body=Map.of("operationId",value.get("offerOperation"),"installationId",value.get("installationId"),"deviceKey",value.get("deviceKey"));
                if(!authority.current(owner)) return false;
                Map<String,Object> offer=instanceRequest(owner,value,owner.session.relayOfferRequest(NativeRelayProtocol.canonical(body)));
                if(offer==null)continue;
                value=store.target(owner.instance);
                acceptOffer(value,offer);value.put("phase","enroll");
                Map<String,Object> enroll=base(value);enroll.put("managementSecret",value.get("managementSecret"));
                for(String field:new String[]{"deviceKey","senderKey","sendCapability","offerId","offer","fid"}) enroll.put(field,value.get(field));
                operation(value,"/v1/enroll",enroll);require(store.save(owner.instance,value));
                continue;
            }
            if("enroll".equals(phase) || "replace".equals(phase)) {
                if(!Boolean.TRUE.equals(value.get("issued"))) {
                    if(!authority.current(owner)) return false;
                    Map<String,Object> result=recoverAndDispatch(owner.instance,value);
                    if("stale".equals(result.get("kind"))) {value=store.target(owner.instance);value.put("phase","reset");require(store.save(owner.instance,value));continue;}
                    if(!"issued".equals(result.get("kind"))) return false;
                    value=store.target(owner.instance);value.put("issued",true);require(store.save(owner.instance,value));
                }
                value=store.target(owner.instance);
                if(value.get("challenge")==null || !authority.current(owner)) return false;
                Map<String,Object> body=base(value);
                body.put("generation",number(value,"generation")+(value.containsKey("nextFid")?1:0));
                body.put("managementSecret",value.containsKey("nextSecret")?value.get("nextSecret"):value.get("managementSecret"));
                body.put("challenge",value.get("challenge"));value.put("phase","confirm");
                operation(value,"/v1/confirm",body);require(store.save(owner.instance,value));continue;
            }
            if("confirm".equals(phase) || "rotate".equals(phase)) {
                if(!authority.current(owner)) return false;
                Map<String,Object> result=recoverAndDispatch(owner.instance,value);
                if("stale".equals(result.get("kind"))) {value=store.target(owner.instance);value.put("phase","reset");require(store.save(owner.instance,value));continue;}
                if(!("confirmed".equals(result.get("kind")) || "rotated".equals(result.get("kind")))) return false;
                value=store.target(owner.instance);acceptReceipt(value,result);value.put("phase","activate");require(store.save(owner.instance,value));continue;
            }
            if("activate".equals(phase)) {
                if(!authority.current(owner)) return false;
                String receipt=(String)value.get("receipt");
                Request request=value.containsKey("nextSecret")
                        ?owner.session.relayUpdateRequest(NativeRelayProtocol.canonical(Map.of("registrationId",value.get("registrationId"),"expectedGeneration",value.get("generation"),"receipt",receipt)))
                        :owner.session.relayActivateRequest(NativeRelayProtocol.canonical(Map.of("offerId",value.get("offerId"),"receipt",receipt)));
                Map<String,Object> result=instanceRequest(owner,value,request);
                if(result==null)continue;
                if(!value.get("registrationId").equals(result.get("registrationId"))) throw new IllegalArgumentException("registration binding");
                if(value.containsKey("nextSecret")) {
                    if(number(result,"generation")!=number(value,"receiptGeneration")) throw new IllegalArgumentException("generation binding");
                } else if(!"fcm-relay".equals(result.get("provider"))) throw new IllegalArgumentException("provider binding");
                if(!authority.current(owner)) return false;
                if(value.containsKey("nextSecret")) value.put("managementSecret",value.remove("nextSecret"));
                if(value.containsKey("nextFid")) value.put("fid",value.remove("nextFid"));
                value.put("generation",value.remove("receiptGeneration"));value.put("credentialVersion",value.remove("receiptCredentialVersion"));
                value.remove("operation");value.remove("path");value.remove("challenge");value.remove("issued");value.put("phase","active");
                require(store.save(owner.instance,value));
                require(authority.activate(owner,(String)value.get("registrationId")));
                if(value.containsKey("desiredFid") && !value.get("desiredFid").equals(value.get("fid"))) {
                    String desired=(String)value.remove("desiredFid");startManagement(owner,value,desired);continue;
                }
                return true;
            }
            throw new IllegalArgumentException("relay phase");
        }
        return false;
    }
    private Map<String,Object> instanceRequest(NativePushStore.Owner owner,Map<String,Object> value,Request request) throws Exception {
        try {return transport.send(request);}catch(Refused e) {
            if(e.status!=409 || !java.util.Set.of("offer-unavailable","offer-consumed","registration-retired","generation-conflict","receipt-stale").contains(e.code))throw e;
            if(!authority.current(owner))return null;
            value.put("phase","reset");require(store.save(owner.instance,value));return null;
        }
    }
    private boolean reset(NativePushStore.Owner owner,Map<String,Object> value) throws Exception {
        if(!authority.current(owner))return false;
        if(value.containsKey("offerId")) {
            Map<String,Object> reply=transport.send(owner.session.relayCancelRequest(NativeRelayProtocol.canonical(Map.of("offerId",value.get("offerId")))));
            if(!Boolean.TRUE.equals(reply.get("cancelled")))throw new IllegalArgumentException("cancel acknowledgement");
        }
        if(!authority.current(owner))return false;
        return store.restart(owner.instance,value,latestFid(value));
    }
    private static String latestFid(Map<String,Object> value) {
        return (String)value.get(value.containsKey("desiredFid")?"desiredFid":value.containsKey("nextFid")?"nextFid":"fid");
    }
    private void acceptOffer(Map<String,Object> value,Map<String,Object> offer) {
        if(!offer.keySet().equals(java.util.Set.of("offer","offerId","relayOrigin","installationId","targetId","registrationId","senderKey","sendCapability","expiresAt"))
                || !provider.relayOrigin().equals(offer.get("relayOrigin")) || !value.get("installationId").equals(offer.get("installationId")))
            throw new IllegalArgumentException("offer bindings");
        Map<String,Object> expected=new LinkedHashMap<>();
        for(String field:new String[]{"installationId","offerId","targetId","registrationId","senderKey"}) expected.put(field,offer.get(field));
        expected.put("relayOrigin",provider.relayOrigin());expected.put("deviceThumbprint",NativeRelayProtocol.thumbprint(NativeRelayStore.object(value.get("deviceKey"))));
        expected.put("sendCapabilityHash",NativeRelayProtocol.credentialHash("send",(String)offer.get("sendCapability")));
        Map<String,Object> claims=NativeRelayProtocol.verifyOffer((String)offer.get("offer"),NativeRelayStore.object(offer.get("senderKey")),expected,now());
        value.putAll(offer);value.put("offerExpires",claims.get("exp"));value.put("deviceThumbprint",expected.get("deviceThumbprint"));
        value.put("sendCapabilityHash",expected.get("sendCapabilityHash"));value.put("senderThumbprint",NativeRelayProtocol.thumbprint(NativeRelayStore.object(offer.get("senderKey"))));
    }
    private void acceptReceipt(Map<String,Object> value,Map<String,Object> result) {
        Map<String,Object> expected=new LinkedHashMap<>();
        for(String field:new String[]{"offerId","offerExpires","registrationId","targetId","installationId","senderKey","senderThumbprint","deviceThumbprint","sendCapabilityHash"}) expected.put(field,value.get(field));
        expected.put("relayOrigin",provider.relayOrigin());
        int generation=number(value,"generation")+(value.containsKey("nextFid")?1:0),version=number(value,"credentialVersion")+(value.containsKey("nextSecret")?1:0);
        expected.put("generation",generation);expected.put("credentialVersion",version);
        expected.put("fidHash",NativeRelayProtocol.fidHash((String)value.get(value.containsKey("nextFid")?"nextFid":"fid")));
        NativeRelayProtocol.verifyReceipt((String)result.get("receipt"),provider.receiptKeys(),expected,now());
        value.put("receipt",result.get("receipt"));value.put("receiptGeneration",generation);value.put("receiptCredentialVersion",version);
    }
    boolean retire(String instance) throws Exception {
        Map<String,Object> value=store.target(instance);
        if(value==null) return true;
        // A fulfilled confirmation can have advanced authority even if its response was lost.
        if("confirm".equals(value.get("phase")) || "rotate".equals(value.get("phase"))) {
            Map<String,Object> result=recoverAndDispatch(instance,value);
            if("confirmed".equals(result.get("kind")) || "rotated".equals(result.get("kind"))) {
                acceptReceipt(value,result);require(store.save(instance,value));
            } else if(!"stale".equals(result.get("kind"))) return false;
        }
        if(!value.containsKey("targetId")) return true;
        if(!"retire".equals(value.get("phase"))) {
            Map<String,Object> body=base(value);
            body.put("generation",value.getOrDefault("receiptGeneration",value.get("generation")));
            body.put("managementSecret",value.containsKey("receipt") && value.containsKey("nextSecret")?value.get("nextSecret"):value.get("managementSecret"));
            operation(value,"/v1/manage/retire",body);value.put("phase","retire");require(store.save(instance,value));
        }
        Map<String,Object> result=recoverAndDispatch(instance,value);
        return "retired".equals(result.get("kind"));
    }
    private Map<String,Object> recoverAndDispatch(String instance,Map<String,Object> value) throws Exception {
        Map<String,Object> semantic=NativeRelayStore.object(value.get("operation"));
        if(value.containsKey("recovery")) {
            Map<String,Object> status=NativeRelayStore.object(value.get("recovery"));
            try {
                Map<String,Object> outcome=send("/v1/operations/status",status);
                if(!"retryable".equals(outcome.get("kind")) && !"quota".equals(outcome.get("kind"))) return outcome;
            } catch(Refused e) {if(e.status!=404) throw e;}
        } else {
            Map<String,Object> status=base(value);
            status.put("managementSecret",semantic.get("managementSecret"));
            status.put("queriedOperationId",semantic.get("operationId"));
            value.put("recovery",status);require(store.save(instance,value));
        }
        return dispatch(value);
    }
    private Map<String,Object> dispatch(Map<String,Object> value) throws Exception {
        return send((String)value.get("path"),NativeRelayStore.object(value.get("operation")));
    }
    private Map<String,Object> send(String path,Map<String,Object> body) throws Exception {
        String origin=provider.relayOrigin();
        java.net.URI trusted=new java.net.URI(origin);
        if(!"https".equals(trusted.getScheme()) || trusted.getHost()==null || trusted.getRawUserInfo()!=null || trusted.getRawQuery()!=null
                || trusted.getRawFragment()!=null || !(trusted.getRawPath()==null || trusted.getRawPath().isEmpty())) throw new IllegalArgumentException("relay trust");
        body.put("deviceProof",NativeRelayProtocol.deviceProof(key.privateKey(),key.publicKey(),origin,path,body,now()));
        body.put("appCheck",provider.appCheck());
        return transport.send(new Request.Builder().url(origin+path).header("Accept","application/json")
                .post(RequestBody.create(NativeRelayProtocol.canonical(body),MediaType.get("application/json; charset=utf-8"))).build());
    }
    private static Map<String,Object> base(Map<String,Object> value) {
        Map<String,Object> body=new LinkedHashMap<>();
        for(String field:new String[]{"installationId","targetId","registrationId"}) body.put(field,value.get(field));
        body.put("operationId",NativeRelayProtocol.opaqueId());return body;
    }
    private static void operation(Map<String,Object> value,String path,Map<String,Object> body) {
        value.put("path",path);value.put("operation",NativeRelayProtocol.parseObject(NativeRelayProtocol.canonical(body)));
        value.remove("issued");value.remove("recovery");
    }
    private static int number(Map<String,Object> value,String key) {return ((Number)value.get(key)).intValue();}
    private static long now() {return System.currentTimeMillis()/1000;}
    private static void require(boolean committed) throws java.io.IOException {if(!committed) throw new java.io.IOException("relay persistence failed");}
}
