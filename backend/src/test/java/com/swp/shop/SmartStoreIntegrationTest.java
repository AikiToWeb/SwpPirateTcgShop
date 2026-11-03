package com.swp.shop;

import com.fasterxml.jackson.databind.*;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.crypto.bcrypt.BCrypt;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:smartstore-http-tests;DB_CLOSE_DELAY=-1","spring.datasource.username=sa","spring.datasource.password=","SHOP_IMPORT_ENABLED=false","SMARTSTORE_CLIENT_ID=","SMARTSTORE_CLIENT_SECRET=","SMARTSTORE_SYNC_ENABLED=false"})
class SmartStoreIntegrationTest {
    @Autowired ShopService s;
    @Autowired InventoryService inventory;
    @Autowired ObjectMapper json;
    MockApi api;
    SmartStoreService smart;
    InventoryDeviceService.Device actor;
    @BeforeEach void setup() throws Exception {
        for(String table:List.of("smartstore_order_effects","smartstore_mappings","inventory_operations","inventory_devices","inventory_pairings","price_reference_checks","stock_movements","order_items","shop_orders","carts","binders","sessions","oauth_states","cards","shop_users"))s.jdbc.update("DELETE FROM "+table);
        s.jdbc.update("UPDATE smartstore_sync_lock SET owner=NULL,expires=0");
        s.jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES('admin','관리자','ADMIN')");
        s.jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES('CARD','테스트 상품','','세트',100,10,'')");
        String id=UUID.randomUUID().toString();s.jdbc.update("INSERT INTO inventory_devices(id,token_hash,actor_id,name,created,expires) VALUES(?,?,'admin','PC',?,?)",id,s.hash("test-only"),s.now(),s.now()+1000);actor=new InventoryDeviceService.Device(id,"admin");
        api=new MockApi(json);smart=new SmartStoreService(s,inventory,api.client(),true);
    }
    @AfterEach void teardown(){if(api!=null)api.close();}
    Map<String,Object> map(){return smart.map(actor,new SmartStoreService.Mapping("CARD","100",null,0L,true));}
    Map<String,Object> baseline(){return smart.baseline(actor,"CARD",new SmartStoreService.Baseline(0L,10,true));}
    String state(Map<String,Object> response){return ((Map<?,?>)((List<?>)response.get("items")).getFirst()).get("status").toString();}
    int local(){return s.jdbc.queryForObject("SELECT stock FROM cards WHERE id='CARD'",Integer.class);}
    void ready(){map();assertEquals("PENDING",baseline().get("status"));s.jdbc.update("UPDATE smartstore_mappings SET baseline_at=?,order_cursor=? WHERE card_id='CARD'",s.now()-60,Instant.ofEpochSecond(s.now()-15).toString());}
    Map<String,Object> order(String id,String state,int quantity){return Map.of("order",Map.of("paymentDate",Instant.ofEpochSecond(s.now()-30).toString()),"productOrder",Map.of("productOrderId",id,"productId","200","quantity",quantity,"productOrderStatus",state,"optionCode",""));}
    @SafeVarargs final void feed(Map<String,Object>... orders){api.orders.clear();api.changes.clear();for(var entry:orders){var product=(Map<?,?>)entry.get("productOrder");String id=product.get("productOrderId").toString();api.orders.put(id,entry);api.changes.add(Map.of("productOrderId",id,"lastChangedDate",Instant.ofEpochSecond(s.now()-8).toString()));}}
    @Test void realHttpAuthenticationUsesOfficialSignatureFormAndCachesToken() throws Exception {
        var client=api.client();assertFalse(client.connected());client.search(1);client.search(2);assertTrue(client.connected());
        var auth=api.seen.stream().filter(item->item.path.equals("/v1/oauth2/token")).toList();assertEquals(1,auth.size());
        var fields=new HashMap<String,String>();for(String field:auth.getFirst().body.split("&")){var pair=field.split("=",2);fields.put(pair[0],URLDecoder.decode(pair[1],StandardCharsets.UTF_8));}
        assertEquals("SELF",fields.get("type"));assertEquals("client_credentials",fields.get("grant_type"));
        assertEquals(BCrypt.hashpw("test-client_"+fields.get("timestamp"),api.salt),new String(Base64.getDecoder().decode(fields.get("client_secret_sign")),StandardCharsets.UTF_8));
        var search=api.seen.stream().filter(item->item.path.equals("/v1/products/search")).findFirst().orElseThrow();assertEquals(20,json.readTree(search.body).path("size").asInt());assertEquals("Bearer test-only-token",search.authorization);
    }
    @Test void credentialsPresenceDoesNotClaimConnectedAndInvalidAuthErrorsAreSanitized(){
        var client=api.client();assertTrue(client.configured());assertFalse(client.connected());api.authFailure=true;
        var error=assertThrows(SmartStoreClient.Failure.class,()->client.search(1));assertEquals("FAILED",error.state);assertFalse(error.getMessage().contains("test-client"));assertFalse(error.getMessage().contains(api.salt));assertFalse(client.connected());
    }
    @Test void searchReturnsRealDetailOptionsAndExplicitPageLocalFilter(){
        api.withOptions=true;var result=smart.products("테스트",1);assertEquals(1L,result.get("total"));assertEquals(20,result.get("pageSize"));assertEquals(1,((List<?>)result.get("items")).size());
        var item=(Map<?,?>)((List<?>)result.get("items")).getFirst();assertEquals(2,((List<?>)item.get("options")).size());
        assertEquals(0,((List<?>)smart.products("없는 상품",1).get("items")).size());
    }
    @Test void initialMappingIsBlockedAndExplicitBaselineRequiresRealEqualStockAndNoRecentOrders(){
        assertEquals("BLOCKED",map().get("status"));assertEquals("BLOCKED",state(smart.sync(actor,List.of("CARD"))));assertEquals(0,api.writes);
        api.remoteStock=9;assertEquals("CONFLICT",baseline().get("status"));assertFalse((Boolean)s.jdbc.queryForObject("SELECT baseline_verified FROM smartstore_mappings WHERE card_id='CARD'",Boolean.class));
        api.remoteStock=10;feed(order("OLD","PAYED",1));assertEquals("BLOCKED",baseline().get("status"));assertEquals(10,local());
        feed();assertEquals("PENDING",baseline().get("status"));assertTrue(s.jdbc.queryForObject("SELECT baseline_verified FROM smartstore_mappings WHERE card_id='CARD'",Boolean.class));assertEquals(0,api.writes);
    }
    @Test void disabledSenderStillBlocksOutboundWritesAfterBaselineAndLocalChange(){
        ready();s.tx.executeWithoutResult(tx->{s.jdbc.update("UPDATE cards SET stock=12 WHERE id='CARD'");s.movement("CARD","admin",2,12,"입고",null);});
        var disabled=new SmartStoreService(s,inventory,api.client(),false);assertEquals("BLOCKED",state(disabled.sync(actor,List.of("CARD"))));assertEquals(0,api.writes);assertEquals(10,api.remoteStock);
    }
    @Test void enabledSenderWritesStockOnlyAndConfirmsByReadback(){
        ready();s.tx.executeWithoutResult(tx->{s.jdbc.update("UPDATE cards SET stock=12 WHERE id='CARD'");s.movement("CARD","admin",2,12,"입고",null);});
        assertEquals("SYNCED",state(smart.sync(actor,List.of("CARD"))));assertEquals(1,api.writes);assertEquals(12,api.remoteStock);
        var request=api.seen.stream().filter(item->item.method.equals("PATCH")).findFirst().orElseThrow();
        var payload=assertDoesNotThrow(()->json.readTree(request.body)).path("multiProductUpdateRequestVos").get(0);assertEquals(12,payload.path("stockQuantity").asInt());assertEquals("STOCK",payload.path("multiUpdateTypes").get(0).asText());assertFalse(payload.has("productSalePrice"));
        assertEquals("SYNCED",state(smart.sync(actor,List.of("CARD"))));assertEquals(1,api.writes);
    }
    @Test void optionWriteTouchesOnlyTargetAndPreservesConcurrentSiblingOrder() throws Exception {
        api.withOptions=true;var client=api.client();var detail=client.detail("100");api.optionB=6;client.writeStock("100","11",5,detail);
        var request=api.seen.stream().filter(item->item.method.equals("PUT")).findFirst().orElseThrow();var options=json.readTree(request.body).path("optionInfo").path("optionCombinations");assertEquals(1,options.size());assertEquals(11,options.get(0).path("id").asInt());assertEquals(5,options.get(0).path("stockQuantity").asInt());assertFalse(options.get(0).has("price"));assertFalse(options.get(0).has("usable"));assertEquals(6,api.optionB);assertEquals(5,api.optionA);
    }
    @Test void uncertainWriteIsDurablyUnknownAndNeverAutomaticallyRetried(){
        ready();s.tx.executeWithoutResult(tx->{s.jdbc.update("UPDATE cards SET stock=12 WHERE id='CARD'");s.movement("CARD","admin",2,12,"입고",null);});api.writeFailure=true;
        assertEquals("UNKNOWN",state(smart.sync(actor,List.of("CARD"))));assertEquals(1,api.writes);
        var restarted=new SmartStoreService(s,inventory,api.client(),true);assertEquals("UNKNOWN",state(restarted.sync(actor,List.of("CARD"))));assertEquals(1,api.writes);
    }
    @Test void failedReadbackAfterAcceptedWriteIsUnknownRatherThanRetryableFailure(){
        ready();s.tx.executeWithoutResult(tx->{s.jdbc.update("UPDATE cards SET stock=12 WHERE id='CARD'");s.movement("CARD","admin",2,12,"입고",null);});api.failReadback=true;
        assertEquals("UNKNOWN",state(smart.sync(actor,List.of("CARD"))));assertEquals(1,api.writes);assertEquals("UNKNOWN",state(smart.sync(actor,List.of("CARD"))));assertEquals(1,api.writes);
    }
    @Test void remoteManualChangeIsConflictAndDoesNotOverwriteNaver(){
        ready();api.remoteStock=8;assertEquals("CONFLICT",state(smart.sync(actor,List.of("CARD"))));assertEquals(0,api.writes);assertEquals(10,local());
    }
    @Test void paidAndCanceledOrdersApplyOnceAcrossServiceRestartWithoutDoubleSending(){
        ready();feed(order("NEW-1","PAYED",2));api.remoteStock=8;
        assertEquals("SYNCED",state(smart.sync(actor,List.of("CARD"))));assertEquals(8,local());assertEquals(0,api.writes);assertEquals(1,s.jdbc.queryForObject("SELECT COUNT(*) FROM smartstore_order_effects",Integer.class));
        s.jdbc.update("UPDATE smartstore_mappings SET order_cursor=?",Instant.ofEpochSecond(s.now()-15).toString());
        var restarted=new SmartStoreService(s,inventory,api.client(),true);assertEquals("SYNCED",state(restarted.sync(actor,List.of("CARD"))));assertEquals(8,local());assertEquals(1,s.jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
        feed(order("NEW-1","CANCELED",2));api.remoteStock=10;s.jdbc.update("UPDATE smartstore_mappings SET order_cursor=?",Instant.ofEpochSecond(s.now()-15).toString());
        assertEquals("SYNCED",state(restarted.sync(actor,List.of("CARD"))));assertEquals(10,local());assertEquals(2,s.jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));assertEquals(0,api.writes);
    }
    @Test void unknownCancellationAndReturnedItemsNeverInventStock(){
        ready();feed(order("UNKNOWN-CANCEL","CANCELED",1));assertEquals("BLOCKED",state(smart.sync(actor,List.of("CARD"))));assertEquals(10,local());
        feed(order("RETURN","RETURNED",1));assertEquals("BLOCKED",state(smart.sync(actor,List.of("CARD"))));assertEquals(10,local());assertEquals(0,api.writes);
    }
    @Test void missingOrderDetailsAndPartialClaimsLeaveCursorStockAndHistoryUnchanged(){
        ready();String cursor=s.jdbc.queryForObject("SELECT order_cursor FROM smartstore_mappings",String.class);feed(order("NEW","PAYED",1));api.omitDetails=true;
        assertEquals("FAILED",state(smart.sync(actor,List.of("CARD"))));assertEquals(cursor,s.jdbc.queryForObject("SELECT order_cursor FROM smartstore_mappings",String.class));assertEquals(10,local());
        api.omitDetails=false;var partial=new LinkedHashMap<>(order("PARTIAL","PAYED",1));partial.put("completedClaims",List.of(Map.of("claimType","CANCEL","claimQuantity",1)));feed(order("NEW","PAYED",1),partial);
        assertEquals("BLOCKED",state(smart.sync(actor,List.of("CARD"))));assertEquals(10,local());assertEquals(0,s.jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));assertEquals(0,s.jdbc.queryForObject("SELECT COUNT(*) FROM smartstore_order_effects",Integer.class));assertEquals(0,api.writes);
    }
    @Test void multipleOrderPagesAndDistributedLeaseAreHandled(){
        map();api.extraPage=true;assertEquals("PENDING",baseline().get("status"));assertEquals(2,api.seen.stream().filter(item->item.path.equals("/v1/pay-order/seller/product-orders/last-changed-statuses")).count());
        s.jdbc.update("UPDATE smartstore_sync_lock SET owner='other',expires=?",s.now()+100);
        var error=assertThrows(InventoryException.class,()->smart.sync(actor,List.of("CARD")));assertEquals(409,error.getStatusCode().value());assertEquals(0,api.writes);
    }
    @Test void statusProbeMakesFirstAuthenticatedReadAndReturnsSanitizedFailure(){
        assertFalse((Boolean)smart.status().get("connected"));assertTrue((Boolean)smart.probeStatus().get("connected"));
        var failing=new SmartStoreService(s,inventory,api.client(),false);api.authFailure=true;var result=failing.probeStatus();assertTrue((Boolean)result.get("configured"));assertFalse((Boolean)result.get("connected"));assertFalse(result.get("message").toString().contains(api.salt));
    }
    @Test void scheduledWorkerRequiresBothFlagsAndStopsDemotedOwners(){
        ready();s.tx.executeWithoutResult(tx->{s.jdbc.update("UPDATE cards SET stock=12 WHERE id='CARD'");s.movement("CARD","admin",2,12,"입고",null);});
        smart.scheduledSync();assertEquals(0,api.writes);
        org.springframework.test.util.ReflectionTestUtils.setField(smart,"autoEnabled",true);smart.scheduledSync();assertEquals(1,api.writes);assertEquals(12,api.remoteStock);
        s.jdbc.update("UPDATE shop_users SET role='CUSTOMER' WHERE id='admin'");smart.scheduledSync();assertEquals("BLOCKED",s.jdbc.queryForObject("SELECT status FROM smartstore_mappings",String.class));assertEquals(1,api.writes);
    }
    @Test void roundRobinWorkerDoesNotStarveMappingsAfterFirstTwenty(){
        org.springframework.test.util.ReflectionTestUtils.setField(smart,"autoEnabled",true);
        for(int index=0;index<21;index++){
            String card=String.format("ROUND-%02d",index);s.jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES(?,?,'','',0,10,'')",card,card);
            s.jdbc.update("INSERT INTO smartstore_mappings(card_id,origin_product_no,channel_product_no,actor_id,status,remote_stock,baseline_at,baseline_verified,order_cursor,message) VALUES(?,?,?,'admin','PENDING',10,?,TRUE,?,'대기')",card,"1"+index+"00","2"+index+"00",s.now()-60,Instant.ofEpochSecond(s.now()).toString());
        }
        smart.scheduledSync();assertEquals(20,api.seen.stream().filter(item->item.path.startsWith("/v2/products/origin-products/")).count());
        smart.scheduledSync();assertEquals(21,api.seen.stream().filter(item->item.path.startsWith("/v2/products/origin-products/")).count());
    }

    static final class MockApi implements AutoCloseable {
        final ObjectMapper json;
        final HttpServer server;
        final HttpClient http=HttpClient.newHttpClient();
        final String salt=BCrypt.gensalt(4);
        final List<Seen> seen=new CopyOnWriteArrayList<>();
        final List<Map<String,Object>> changes=new ArrayList<>();
        final Map<String,Map<String,Object>> orders=new LinkedHashMap<>();
        volatile int remoteStock=10,writes=0,optionA=3,optionB=7;
        boolean withOptions,authFailure,writeFailure,failReadback,omitDetails,extraPage;
        record Seen(String method,String path,String authorization,String body){}
        MockApi(ObjectMapper json) throws IOException {
            this.json=json;server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.createContext("/",exchange->{
                String path=exchange.getRequestURI().getPath(),body=new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8),method=exchange.getRequestMethod();seen.add(new Seen(method,path,exchange.getRequestHeaders().getFirst("Authorization"),body));
                int status=200;Object result;
                try{
                    if(path.equals("/v1/oauth2/token")){status=authFailure?403:200;result=authFailure?Map.of("message","sensitive upstream message ignored"):Map.of("access_token","test-only-token","expires_in",3600);}
                    else if(path.equals("/v1/products/search"))result=Map.of("contents",List.of(Map.of("originProductNo",100,"channelProducts",List.of(Map.of("channelProductNo",200,"channelServiceType","STOREFARM")))),"totalElements",1);
                    else if(path.equals("/v2/products/origin-products/100")){status=failReadback&&writes>0?503:200;result=detail();}
                    else if(path.equals("/v1/pay-order/seller/product-orders/last-changed-statuses")){
                        var data=new LinkedHashMap<String,Object>();data.put("lastChangeStatuses",changes);if(extraPage&&!Objects.toString(exchange.getRequestURI().getRawQuery(),"").contains("moreSequence="))data.put("more",Map.of("moreFrom",Instant.ofEpochSecond(Instant.now().getEpochSecond()-10).toString(),"moreSequence","next"));result=Map.of("data",data);
                    }else if(path.equals("/v1/pay-order/seller/product-orders/query")){
                        var data=new ArrayList<Map<String,Object>>();if(!omitDetails)for(var id:json.readTree(body).path("productOrderIds")){var item=orders.get(id.asText());if(item!=null)data.add(item);}result=Map.of("data",data);
                    }else if(path.equals("/v1/products/origin-products/multi-update")){
                        writes++;remoteStock=json.readTree(body).path("multiProductUpdateRequestVos").get(0).path("stockQuantity").asInt();status=writeFailure?503:200;result=Map.of("code","SUCCESS");
                    }else if(path.equals("/v1/products/origin-products/100/option-stock")){writes++;for(var option:json.readTree(body).path("optionInfo").path("optionCombinations")){if(option.path("id").asInt()==11)optionA=option.path("stockQuantity").asInt();else if(option.path("id").asInt()==12)optionB=option.path("stockQuantity").asInt();}result=detail();}
                    else{status=404;result=Map.of("code","NOT_FOUND");}
                    byte[] encoded=json.writeValueAsBytes(result);exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(status,encoded.length);exchange.getResponseBody().write(encoded);
                }catch(Exception error){exchange.sendResponseHeaders(500,-1);}finally{exchange.close();}
            });server.start();
        }
        Object detail(){var product=new LinkedHashMap<String,Object>();product.put("name","테스트 상품");product.put("stockQuantity",remoteStock);product.put("statusType","SALE");
            if(withOptions)product.put("detailAttribute",Map.of("optionInfo",Map.of("useStockManagement",true,"optionCombinations",List.of(Map.of("id",11,"optionName1","옵션 A","stockQuantity",optionA,"price",0,"usable",true,"sellerManagerCode","OPT-A"),Map.of("id",12,"optionName1","옵션 B","stockQuantity",optionB,"price",300,"usable",true,"sellerManagerCode","OPT-B")))));
            return Map.of("originProduct",product);
        }
        SmartStoreClient client(){return new SmartStoreClient("test-client",salt,json,(method,path,headers,body)->{
            var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+path)).timeout(Duration.ofSeconds(3));headers.forEach(request::header);request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(body));var response=http.send(request.build(),HttpResponse.BodyHandlers.ofString());return new SmartStoreClient.Reply(response.statusCode(),response.body());
        });}
        @Override public void close(){server.stop(0);http.close();}
    }
}
