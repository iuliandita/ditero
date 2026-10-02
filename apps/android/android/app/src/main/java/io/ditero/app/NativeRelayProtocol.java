package io.ditero.app;

import java.math.BigInteger;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;

/** Wire-only relay protocol. Keys, trust pins, clock and expected bindings come from native ownership. */
final class NativeRelayProtocol {
    static final String PROOF_TYPE="ditero-relay-proof+jwt";
    static final String OFFER_TYPE="ditero-relay-offer+jwt";
    static final String RECEIPT_TYPE="ditero-relay-receipt+jwt";
    private static final long MAX_INTEGER=9007199254740991L;
    private static final String BASE64URL="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    private static final SecureRandom RANDOM=new SecureRandom();
    private static final Set<String> DEVICE_PATHS=Set.of("/v1/enroll","/v1/confirm","/v1/manage/rotate",
            "/v1/manage/replace-fid","/v1/manage/retire","/v1/operations/status");
    private NativeRelayProtocol() {}

    static String opaqueId() {byte[] value=new byte[32]; RANDOM.nextBytes(value); return encode(value);}
    static boolean isOpaque(String value) {
        try {return value!=null && value.matches("[A-Za-z0-9_-]{43}") && decode(value).length==32;}
        catch(IllegalArgumentException e) {return false;}
    }
    static String credentialHash(String kind,String value) {
        require(kind.equals("management") || kind.equals("send")); require(isOpaque(value));
        return hash("ditero:push-relay:v1:"+kind+":"+value);
    }
    static String fidHash(String value) {
        require(value!=null && value.matches("[A-Za-z0-9._:-]{1,4096}"));
        return hash("ditero:push-relay:v1:fid:"+value);
    }
    static String semanticDigest(Map<String,Object> body) {
        Map<String,Object> semantic=new LinkedHashMap<>(body);
        semantic.remove("deviceProof"); semantic.remove("senderProof"); semantic.remove("appCheck");
        return hash(canonical(semantic));
    }
    static String canonical(Object value) {return canonical(value,0);}
    private static String canonical(Object value,int depth) {
        require(depth<=24);
        if(value==null) return "null";
        if(value instanceof String) return quote((String)value);
        if(value instanceof Boolean) return value.toString();
        if(value instanceof Number) return Long.toString(integer(value));
        if(value instanceof Map) {
            Map<?,?> map=(Map<?,?>)value; List<String> keys=new ArrayList<>();
            for(Object key:map.keySet()) {
                // Relay contracts contain only ASCII identifier keys. Refuse other collation domains.
                require(key instanceof String && ((String)key).matches("[A-Za-z][A-Za-z0-9]*")); keys.add((String)key);
            }
            // JS localeCompare orders ASCII letters case-insensitively, with lowercase first on ties.
            keys.sort((a,b) -> {int order=a.compareToIgnoreCase(b); return order!=0?order:b.compareTo(a);});
            List<String> fields=new ArrayList<>();
            for(String key:keys) fields.add(quote(key)+":"+canonical(map.get(key),depth+1));
            return "{"+String.join(",",fields)+"}";
        }
        if(value instanceof List) {
            List<String> values=new ArrayList<>();
            for(Object item:(List<?>)value) values.add(canonical(item,depth+1));
            return "["+String.join(",",values)+"]";
        }
        throw invalid();
    }
    static Map<String,Object> parseObject(String json) {
        require(json!=null && json.getBytes(StandardCharsets.UTF_8).length<=16384);
        Parser parser=new Parser(json); Object value=parser.value(0); parser.space();
        require(parser.index==json.length()); return object(value);
    }
    static Map<String,Object> publicJwk(PublicKey key) throws GeneralSecurityException {
        require(key instanceof ECPublicKey); ECPublicKey ec=(ECPublicKey)key;
        ECParameterSpec expected=curve(); ECParameterSpec actual=ec.getParams();
        require(actual.getCurve().equals(expected.getCurve()) && actual.getGenerator().equals(expected.getGenerator())
                && actual.getOrder().equals(expected.getOrder()) && actual.getCofactor()==expected.getCofactor());
        Map<String,Object> jwk=new LinkedHashMap<>(); jwk.put("kty","EC"); jwk.put("crv","P-256");
        jwk.put("x",encode(unsigned(ec.getW().getAffineX(),32))); jwk.put("y",encode(unsigned(ec.getW().getAffineY(),32)));
        importKey(jwk); return Collections.unmodifiableMap(jwk);
    }
    static String thumbprint(Map<String,Object> jwk) {
        try {importKey(jwk);} catch(GeneralSecurityException e) {throw invalid();}
        // RFC 7638 explicitly requires lexicographic order, independent of relay semantic canonicalization.
        return hash("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":"+quote(string(jwk,"x"))+",\"y\":"+quote(string(jwk,"y"))+"}");
    }
    static String deviceProof(PrivateKey privateKey,Map<String,Object> deviceKey,String origin,String path,
            Map<String,Object> body,long nowSeconds) throws GeneralSecurityException {
        origin(origin); require(DEVICE_PATHS.contains(path)); require(nowSeconds>=0 && nowSeconds<=MAX_INTEGER-60);
        String operation=string(body,"operationId"); require(isOpaque(operation));
        Map<String,Object> claims=new LinkedHashMap<>(); claims.put("aud",origin); claims.put("iat",nowSeconds);
        claims.put("exp",nowSeconds+60); claims.put("method","POST"); claims.put("path",path);
        claims.put("operationId",operation); claims.put("digest",semanticDigest(body)); claims.put("nonce",opaqueId());
        String kid=thumbprint(deviceKey); String token=sign(privateKey,PROOF_TYPE,kid,claims);
        // A persisted public key and keystore alias must describe the same device key.
        verify(token,deviceKey,PROOF_TYPE,kid); return token;
    }
    static Map<String,Object> verifyOffer(String token,Map<String,Object> pinnedSenderKey,
            Map<String,Object> expected,long nowSeconds) {
        String origin=string(expected,"relayOrigin"); origin(origin);
        String kid=thumbprint(pinnedSenderKey); Map<String,Object> claims=verify(token,pinnedSenderKey,OFFER_TYPE,kid);
        fields(claims,"aud","iat","exp","installationId","offerId","targetId","registrationId","senderKey",
                "deviceThumbprint","sendCapabilityHash");
        require(origin.equals(string(claims,"aud"))); long iat=integer(claims.get("iat")), exp=integer(claims.get("exp"));
        require(nowSeconds>=0 && iat>=0 && iat<=nowSeconds && exp>nowSeconds && exp>iat && exp-iat<=300);
        for(String key:new String[]{"installationId","offerId","targetId","deviceThumbprint","sendCapabilityHash"}) {
            require(isOpaque(string(claims,key))); binding(claims,expected,key);
        }
        appId(string(claims,"registrationId")); binding(claims,expected,"registrationId");
        require(kid.equals(thumbprint(object(claims.get("senderKey")))));
        if(expected.containsKey("senderKey")) require(kid.equals(thumbprint(object(expected.get("senderKey")))));
        if(expected.containsKey("offerExpires")) require(exp==integer(expected.get("offerExpires")));
        return immutable(claims);
    }
    static Map<String,Object> verifyReceipt(String token,Map<String,Object> pinnedReceiptKeys,
            Map<String,Object> expected,long nowSeconds) {
        String origin=string(expected,"relayOrigin"); origin(origin); Map<String,Object> header=header(token);
        String kid=string(header,"kid"); require(kid.length()>0 && kid.length()<=128);
        require(pinnedReceiptKeys.containsKey(kid));
        Map<String,Object> claims=verify(token,object(pinnedReceiptKeys.get(kid)),RECEIPT_TYPE,kid);
        List<String> names=new ArrayList<>(Arrays.asList("iss","aud","iat","offerId","offerExpires","registrationId",
                "targetId","installationId","senderKey","senderThumbprint","deviceThumbprint","relayOrigin","fidHash",
                "generation","credentialVersion","sendCapabilityHash"));
        if(expected.containsKey("kind")) {
            String kind=string(expected,"kind"); require(kind.equals("target-status") || kind.equals("accepted"));
            names.addAll(Arrays.asList("kind","operationId","digest"));
            if(kind.equals("target-status")) names.add("state");
        }
        fields(claims,names.toArray(new String[0]));
        require(origin.equals(string(claims,"iss")) && origin.equals(string(claims,"aud")));
        long iat=integer(claims.get("iat")); require(nowSeconds>=0 && iat>=0 && iat<=nowSeconds);
        require(integer(claims.get("offerExpires"))>=0);
        require(integer(claims.get("generation"))>0 && integer(claims.get("credentialVersion"))>0);
        appId(string(claims,"registrationId"));
        for(String key:new String[]{"offerId","targetId","installationId","senderThumbprint","deviceThumbprint",
                "fidHash","sendCapabilityHash"}) require(isOpaque(string(claims,key)));
        require(string(claims,"senderThumbprint").equals(thumbprint(object(claims.get("senderKey")))));
        for(String key:names) if(!key.equals("iss") && !key.equals("aud") && !key.equals("iat")) binding(claims,expected,key);
        if(expected.containsKey("kind")) {
            require(isOpaque(string(claims,"operationId")) && isOpaque(string(claims,"digest")));
            if("target-status".equals(claims.get("kind"))) require(Set.of("issued","confirmed","retired").contains(string(claims,"state")));
        }
        // Registration receipts intentionally have no expiry: durable recovery remains possible after offer expiry.
        return immutable(claims);
    }

    private static String sign(PrivateKey key,String type,String kid,Map<String,Object> claims) throws GeneralSecurityException {
        String header=canonical(Map.of("alg","ES256","typ",type,"kid",kid));
        String input=encode(header.getBytes(StandardCharsets.UTF_8))+"."+encode(canonical(claims).getBytes(StandardCharsets.UTF_8));
        Signature signer=Signature.getInstance("SHA256withECDSA"); signer.initSign(key); signer.update(input.getBytes(StandardCharsets.US_ASCII));
        return input+"."+encode(derToRaw(signer.sign()));
    }
    private static Map<String,Object> header(String token) {return jsonSegment(parts(token)[0]);}
    private static Map<String,Object> verify(String token,Map<String,Object> jwk,String type,String kid) {
        try {
            String[] parts=parts(token); Map<String,Object> header=jsonSegment(parts[0]); fields(header,"alg","typ","kid");
            require("ES256".equals(header.get("alg")) && type.equals(header.get("typ")) && kid.equals(header.get("kid")));
            byte[] raw=decode(parts[2]); require(raw.length==64);
            Signature verifier=Signature.getInstance("SHA256withECDSA"); verifier.initVerify(importKey(jwk));
            verifier.update((parts[0]+"."+parts[1]).getBytes(StandardCharsets.US_ASCII));
            require(verifier.verify(rawToDer(raw))); return jsonSegment(parts[1]);
        } catch(GeneralSecurityException e) {throw invalid();}
    }
    private static String[] parts(String token) {
        require(token!=null && token.length()<=8192 && token.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"));
        return token.split("\\.",-1);
    }
    private static Map<String,Object> jsonSegment(String value) {
        try {return parseObject(StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(decode(value))).toString());}
        catch(java.nio.charset.CharacterCodingException e) {throw invalid();}
    }
    private static PublicKey importKey(Map<String,Object> jwk) throws GeneralSecurityException {
        fields(jwk,"kty","crv","x","y"); require("EC".equals(jwk.get("kty")) && "P-256".equals(jwk.get("crv")));
        require(isOpaque(string(jwk,"x")) && isOpaque(string(jwk,"y")));
        BigInteger x=new BigInteger(1,decode(string(jwk,"x"))), y=new BigInteger(1,decode(string(jwk,"y")));
        ECParameterSpec spec=curve(); BigInteger p=((java.security.spec.ECFieldFp)spec.getCurve().getField()).getP();
        require(x.compareTo(p)<0 && y.compareTo(p)<0);
        require(y.multiply(y).mod(p).equals(x.multiply(x).multiply(x).add(spec.getCurve().getA().multiply(x))
                .add(spec.getCurve().getB()).mod(p)));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x,y),spec));
    }
    private static ECParameterSpec curve() throws GeneralSecurityException {
        AlgorithmParameters parameters=AlgorithmParameters.getInstance("EC"); parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }
    static byte[] derToRaw(byte[] der) {
        require(der!=null && der.length>=8 && der.length<=72 && der[0]==0x30 && (der[1]&255)==der.length-2);
        byte[] raw=new byte[64]; int offset=2;
        for(int component=0;component<2;component++) {
            require(offset+2<=der.length && der[offset++]==2); int length=der[offset++]&255;
            require(length>0 && length<=33 && offset+length<=der.length && (der[offset]&128)==0);
            require(length==1 || der[offset]!=0 || (der[offset+1]&128)!=0);
            int skip=der[offset]==0?1:0; int bytes=length-skip; require(bytes<=32);
            System.arraycopy(der,offset+skip,raw,component*32+32-bytes,bytes); offset+=length;
        }
        require(offset==der.length); return raw;
    }
    static byte[] rawToDer(byte[] raw) {
        require(raw!=null && raw.length==64); byte[][] values=new byte[2][];
        for(int i=0;i<2;i++) {
            int start=i*32,end=start+32; while(start<end-1 && raw[start]==0) start++;
            int pad=(raw[start]&128)!=0?1:0; values[i]=new byte[end-start+pad];
            System.arraycopy(raw,start,values[i],pad,end-start);
        }
        byte[] der=new byte[6+values[0].length+values[1].length]; der[0]=0x30; der[1]=(byte)(der.length-2);
        int offset=2; for(byte[] value:values) {der[offset++]=2; der[offset++]=(byte)value.length; System.arraycopy(value,0,der,offset,value.length); offset+=value.length;}
        return der;
    }
    private static byte[] unsigned(BigInteger value,int width) {
        byte[] bytes=value.toByteArray(); int start=bytes.length>1 && bytes[0]==0?1:0; require(bytes.length-start<=width);
        byte[] out=new byte[width]; System.arraycopy(bytes,start,out,width-bytes.length+start,bytes.length-start); return out;
    }
    private static String hash(String value) {
        try {return encode(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}
        catch(GeneralSecurityException e) {throw new IllegalStateException(e);}
    }
    private static String encode(byte[] value) {
        StringBuilder out=new StringBuilder((value.length*4+2)/3); int bits=0,count=0;
        for(byte item:value) {
            bits=(bits<<8)|(item&255); count+=8;
            while(count>=6) {count-=6; out.append(BASE64URL.charAt((bits>>>count)&63));}
        }
        if(count>0) out.append(BASE64URL.charAt((bits<<(6-count))&63)); return out.toString();
    }
    private static byte[] decode(String value) {
        require(value!=null && value.matches("[A-Za-z0-9_-]+") && value.length()%4!=1);
        byte[] decoded=new byte[value.length()*6/8]; int bits=0,count=0,index=0;
        for(int i=0;i<value.length();i++) {
            bits=(bits<<6)|BASE64URL.indexOf(value.charAt(i)); count+=6;
            if(count>=8) {count-=8; decoded[index++]=(byte)(bits>>>count);}
        }
        require(encode(decoded).equals(value)); return decoded;
    }
    private static void origin(String value) {
        try {URI uri=new URI(value); require("https".equals(uri.getScheme()) && uri.getHost()!=null && uri.getRawUserInfo()==null
                && uri.getRawQuery()==null && uri.getRawFragment()==null && (uri.getRawPath()==null || uri.getRawPath().isEmpty())
                && uri.getPort()!=0 && uri.getPort()<=65535);}
        catch(java.net.URISyntaxException e) {throw invalid();}
    }
    private static void appId(String value) {require(value.matches("[A-Za-z0-9_-]{1,128}"));}
    private static String string(Map<String,Object> map,String name) {Object value=map.get(name); require(value instanceof String); return (String)value;}
    private static long integer(Object value) {
        require(value instanceof Number); double number=((Number)value).doubleValue();
        require(Double.isFinite(number) && number==Math.rint(number) && Math.abs(number)<=MAX_INTEGER); return ((Number)value).longValue();
    }
    private static void binding(Map<String,Object> value,Map<String,Object> expected,String key) {
        require(expected.containsKey(key) && canonical(value.get(key)).equals(canonical(expected.get(key))));
    }
    private static void fields(Map<String,Object> value,String... names) {
        require(value.keySet().equals(new HashSet<>(Arrays.asList(names))));
    }
    @SuppressWarnings("unchecked") private static Map<String,Object> object(Object value) {require(value instanceof Map); return (Map<String,Object>)value;}
    private static Map<String,Object> immutable(Map<String,Object> map) {
        Map<String,Object> out=new LinkedHashMap<>();
        for(Map.Entry<String,Object> entry:map.entrySet()) out.put(entry.getKey(),entry.getValue() instanceof Map?immutable(object(entry.getValue())):entry.getValue());
        return Collections.unmodifiableMap(out);
    }
    private static IllegalArgumentException invalid() {return new IllegalArgumentException("Invalid relay protocol");}
    private static void require(boolean valid) {if(!valid) throw invalid();}
    private static String quote(String value) {
        StringBuilder out=new StringBuilder("\"");
        for(int i=0;i<value.length();i++) {
            char c=value.charAt(i);
            if(Character.isHighSurrogate(c)) {require(i+1<value.length() && Character.isLowSurrogate(value.charAt(i+1))); out.append(c).append(value.charAt(++i));}
            else if(Character.isLowSurrogate(c)) throw invalid();
            else switch(c) {
                case '"': out.append("\\\""); break; case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break; case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break; case '\r': out.append("\\r"); break; case '\t': out.append("\\t"); break;
                default: if(c<32) {out.append("\\u"); String hex=Integer.toHexString(c); out.append("0000",0,4-hex.length()).append(hex);} else out.append(c);
            }
        }
        return out.append('"').toString();
    }
    private static final class Parser {
        final String input; int index;
        Parser(String input) {this.input=input;}
        void space() {while(index<input.length() && " \t\r\n".indexOf(input.charAt(index))>=0) index++;}
        char take() {require(index<input.length()); return input.charAt(index++);}
        Object value(int depth) {
            require(depth<=24); space(); require(index<input.length()); char token=input.charAt(index);
            if(token=='{') {
                index++; space(); Map<String,Object> out=new LinkedHashMap<>(); if(consume('}')) return out;
                do {space(); String key=text(); require(!out.containsKey(key)); space(); require(take()==':'); out.put(key,value(depth+1)); space();
                    if(consume('}')) return out; require(take()==',');} while(true);
            }
            if(token=='[') {
                index++; space(); List<Object> out=new ArrayList<>(); if(consume(']')) return out;
                do {out.add(value(depth+1)); space(); if(consume(']')) return out; require(take()==',');} while(true);
            }
            if(token=='"') return text();
            for(String literal:new String[]{"true","false","null"}) if(input.startsWith(literal,index)) {
                index+=literal.length(); return literal.equals("null")?null:literal.equals("true");
            }
            int start=index; while(index<input.length() && "-+0123456789.eE".indexOf(input.charAt(index))>=0) index++;
            String number=input.substring(start,index); require(number.matches("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"));
            try {double value=Double.parseDouble(number); require(Double.isFinite(value) && Math.abs(value)<=MAX_INTEGER); return value;}
            catch(NumberFormatException e) {throw invalid();}
        }
        boolean consume(char value) {if(index<input.length() && input.charAt(index)==value) {index++; return true;} return false;}
        String text() {
            require(take()=='"'); StringBuilder out=new StringBuilder(); boolean closed=false;
            while(index<input.length()) {
                char c=take(); if(c=='"') {closed=true; break;} require(c>=32);
                if(c=='\\') {
                    c=take(); switch(c) {
                        case '"': case '\\': case '/': out.append(c); break;
                        case 'b': out.append('\b'); break; case 'f': out.append('\f'); break;
                        case 'n': out.append('\n'); break; case 'r': out.append('\r'); break; case 't': out.append('\t'); break;
                        case 'u': require(index+4<=input.length()); String hex=input.substring(index,index+4); require(hex.matches("[0-9A-Fa-f]{4}"));
                            out.append((char)Integer.parseInt(hex,16)); index+=4; break;
                        default: throw invalid();
                    }
                } else out.append(c);
            }
            require(closed); String value=out.toString(); quote(value); return value;
        }
    }
}
