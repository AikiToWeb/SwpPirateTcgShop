package com.swp.shop;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.bcrypt.BCrypt;
import org.springframework.stereotype.Component;

/** Official Commerce API adapter. Production destination cannot be supplied by a user or environment variable. */
@Component
public class SmartStoreClient {
    static final String BASE="https://api.commerce.naver.com/external";
    record Reply(int status,String body){}
    @FunctionalInterface interface Transport { Reply exchange(String method,String path,Map<String,String> headers,String body) throws Exception; }
    static final class Failure extends RuntimeException {
        final String state;
        Failure(String state,String message){super(message);this.state=state;}
    }
    private final String clientId,secret;
    private final ObjectMapper json;
    private final Transport transport;
    private String token;
    private Instant tokenExpires=Instant.EPOCH;
    private volatile boolean connected;
    @Autowired
    public SmartStoreClient(@Value("${SMARTSTORE_CLIENT_ID:}") String clientId,@Value("${SMARTSTORE_CLIENT_SECRET:}") String secret,ObjectMapper json){
        this(clientId,secret,json,productionTransport());
    }
    // Package-scoped injection exists only for mock-HTTP tests; no configurable production host.
    SmartStoreClient(String clientId,String secret,ObjectMapper json,Transport transport){this.clientId=clientId;this.secret=secret;this.json=json;this.transport=transport;}
    private static Transport productionTransport(){
        var http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
        return (method,path,headers,body)->{
            if(!path.startsWith("/v1/")&&!path.startsWith("/v2/"))throw new IllegalArgumentException("Unsupported Commerce API path");
            var builder=HttpRequest.newBuilder(URI.create(BASE+path)).timeout(Duration.ofSeconds(20));headers.forEach(builder::header);
            builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(body,StandardCharsets.UTF_8));
            var response=http.send(builder.build(),HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return new Reply(response.statusCode(),response.body());
        };
    }
    public boolean configured(){return !clientId.isBlank()&&!secret.isBlank();}
    public boolean connected(){return connected&&configured();}
    void disconnected(){connected=false;}
    private static String encode(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8);}
    static String id(String value){
        if(value==null||!value.matches("[1-9][0-9]{0,18}"))throw new Failure("FAILED","네이버 상품 또는 옵션 번호를 확인해 주세요.");
        try{Long.parseLong(value);}catch(NumberFormatException e){throw new Failure("FAILED","네이버 상품 번호가 범위를 초과했습니다.");}
        return value;
    }
    static String identifier(JsonNode node){return id(node.asText(""));}
    static int stock(JsonNode node){if(!node.isIntegralNumber()||!node.canConvertToInt()||node.intValue()<0||node.intValue()>InventoryService.MAX_STOCK)throw new Failure("FAILED","네이버 재고 응답을 확인할 수 없습니다.");return node.intValue();}
    private JsonNode exchange(String method,String endpoint,Map<String,String> headers,String body,boolean write){
        try{
            Reply reply=transport.exchange(method,endpoint,headers,body);
            if(reply.status()<200||reply.status()>=300){
                connected=false;
                if(reply.status()==401||reply.status()==403){token=null;throw new Failure("FAILED","네이버 API 권한·호출 IP·인증 설정을 확인해 주세요.");}
                throw new Failure(write&&(reply.status()>=500||reply.status()==408)?"UNKNOWN":"FAILED",write&&reply.status()>=500?"네이버 반영 결과가 불명확합니다. 재전송 전에 판매자센터에서 확인해 주세요.":"네이버 API 요청에 실패했습니다. 설정과 요청 범위를 확인해 주세요.");
            }
            JsonNode result=json.readTree(reply.body());
            if(result==null||!result.isObject())throw new Failure(write?"UNKNOWN":"FAILED","네이버 응답을 확인할 수 없습니다.");
            return result;
        }catch(Failure failure){throw failure;}
        catch(Exception ignored){connected=false;throw new Failure(write?"UNKNOWN":"FAILED",write?"네이버 반영 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다.":"네이버 API에 연결할 수 없습니다. 잠시 후 다시 확인해 주세요.");}
    }
    private synchronized String token(){
        if(!configured())throw new Failure("NOT_CONFIGURED","서버에 스마트스토어 API 설정이 필요합니다.");
        if(token!=null&&Instant.now().isBefore(tokenExpires))return token;
        long timestamp=System.currentTimeMillis();String signature;
        try{signature=Base64.getEncoder().encodeToString(BCrypt.hashpw(clientId+"_"+timestamp,secret).getBytes(StandardCharsets.UTF_8));}
        catch(Exception ignored){throw new Failure("FAILED","서버의 스마트스토어 인증 설정을 확인해 주세요.");}
        String form="client_id="+encode(clientId)+"&timestamp="+timestamp+"&grant_type=client_credentials&type=SELF&client_secret_sign="+encode(signature);
        JsonNode response=exchange("POST","/v1/oauth2/token",Map.of("Content-Type","application/x-www-form-urlencoded","Accept","application/json"),form,false);
        if(!response.path("access_token").isTextual()||response.path("access_token").asText().isBlank()||!response.path("expires_in").canConvertToLong()||response.path("expires_in").asLong()<1)throw new Failure("FAILED","네이버 인증 응답이 올바르지 않습니다.");
        token=response.path("access_token").asText();tokenExpires=Instant.now().plusSeconds(Math.max(0,response.path("expires_in").asLong()-60));return token;
    }
    private JsonNode call(String method,String endpoint,JsonNode payload,boolean write){
        var headers=Map.of("Authorization","Bearer "+token(),"Accept","application/json","Content-Type","application/json");
        JsonNode response=exchange(method,endpoint,headers,payload==null?null:payload.toString(),write);connected=true;return response;
    }
    public JsonNode search(int page){
        if(page<1||page>100000)throw new Failure("FAILED","조회 페이지를 확인해 주세요.");
        var payload=json.createObjectNode();payload.put("page",page);payload.put("size",20);payload.put("orderType","NO");
        var response=call("POST","/v1/products/search",payload,false);
        if(!response.path("contents").isArray()||!response.path("totalElements").canConvertToLong())throw new Failure("FAILED","네이버 상품 목록 응답이 올바르지 않습니다.");
        return response;
    }
    public JsonNode detail(String originProductNo){
        var response=call("GET","/v2/products/origin-products/"+id(originProductNo),null,false);
        if(!response.path("originProduct").isObject())throw new Failure("FAILED","네이버 상품 상세 응답이 올바르지 않습니다.");
        return response;
    }
    public String channelNumber(String originProductNo){
        var payload=json.createObjectNode();payload.put("searchKeywordType","PRODUCT_NO");payload.putArray("originProductNos").add(Long.parseLong(id(originProductNo)));payload.put("page",1);payload.put("size",20);
        var response=call("POST","/v1/products/search",payload,false);
        for(var origin:response.path("contents"))if(originProductNo.equals(origin.path("originProductNo").asText()))for(var channel:origin.path("channelProducts"))
            if("STOREFARM".equals(channel.path("channelServiceType").asText()))return identifier(channel.path("channelProductNo"));
        throw new Failure("FAILED","스마트스토어 채널 상품을 확인할 수 없습니다.");
    }
    public JsonNode changes(String from,String to,String sequence){
        String endpoint="/v1/pay-order/seller/product-orders/last-changed-statuses?lastChangedFrom="+encode(from)+"&lastChangedTo="+encode(to)+"&limitCount=300";
        if(sequence!=null&&!sequence.isBlank())endpoint+="&moreSequence="+encode(sequence);
        var result=call("GET",endpoint,null,false);
        if(!result.path("data").path("lastChangeStatuses").isArray())throw new Failure("FAILED","네이버 주문 변경 응답이 올바르지 않습니다.");
        return result.path("data");
    }
    public JsonNode orderDetails(List<String> ids){
        if(ids.isEmpty()||ids.size()>300)throw new Failure("FAILED","주문 조회 범위를 확인해 주세요.");
        var payload=json.createObjectNode();payload.set("productOrderIds",json.valueToTree(ids));payload.put("quantityClaimCompatibility",false);
        var result=call("POST","/v1/pay-order/seller/product-orders/query",payload,false);
        if(!result.path("data").isArray())throw new Failure("FAILED","네이버 주문 상세 응답이 올바르지 않습니다.");return result.path("data");
    }
    public void writeStock(String originProductNo,String optionId,int quantity,JsonNode latest){
        if(quantity<0||quantity>InventoryService.MAX_STOCK)throw new Failure("FAILED","전송할 재고 범위를 확인해 주세요.");
        JsonNode result;
        if(optionId==null||optionId.isBlank()){
            var payload=json.createObjectNode();var item=payload.putArray("multiProductUpdateRequestVos").addObject();item.put("originProductNo",Long.parseLong(id(originProductNo)));item.putArray("multiUpdateTypes").add("STOCK");item.put("stockQuantity",quantity);
            result=call("PATCH","/v1/products/origin-products/multi-update",payload,true);
            if(result.has("code")&&!List.of("SUCCESS","200","0").contains(result.path("code").asText()))throw new Failure("UNKNOWN","네이버 변경 응답을 수동 확인해야 합니다. 자동 재전송하지 않습니다.");
        }else{
            id(optionId);var info=latest.path("originProduct").path("detailAttribute").path("optionInfo");
            if(!info.isObject())throw new Failure("FAILED","상품 옵션 정보를 확인할 수 없습니다.");
            // The official partial-update contract preserves omitted fields/options (#2221).
            // Send only the target ID and stock; replaying siblings would overwrite concurrent orders.
            var payload=json.createObjectNode();var next=json.createObjectNode();boolean found=false;
            for(String key:List.of("optionCombinations","optionStandards"))for(JsonNode option:info.path(key))if(optionId.equals(option.path("id").asText())){
                var target=next.putArray(key).addObject();target.put("id",Long.parseLong(optionId));target.put("stockQuantity",quantity);found=true;
            }
            if(!found)throw new Failure("FAILED","연결된 옵션을 찾을 수 없습니다.");
            payload.set("optionInfo",next);result=call("PUT","/v1/products/origin-products/"+id(originProductNo)+"/option-stock",payload,true);
            if(!result.path("originProduct").isObject())throw new Failure("UNKNOWN","네이버 옵션 반영 결과를 확인할 수 없습니다.");
        }
    }
}
