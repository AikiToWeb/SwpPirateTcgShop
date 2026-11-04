package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import java.util.*;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:inventory-api-tests;DB_CLOSE_DELAY=-1","spring.datasource.username=sa","spring.datasource.password=","SHOP_IMPORT_ENABLED=false","SMARTSTORE_CLIENT_ID=","SMARTSTORE_CLIENT_SECRET=","SMARTSTORE_SYNC_ENABLED=false"})
@AutoConfigureMockMvc
class InventoryIntegrationTest {
    @Autowired ShopService s;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc web;
    @Autowired ObjectMapper json;
    @Autowired InventoryService inventory;
    @BeforeEach void reset(){
        for(String table:List.of("smartstore_order_effects","smartstore_mappings","inventory_operations","inventory_devices","inventory_pairings","price_reference_checks","stock_movements","order_items","shop_orders","carts","binders","sessions","oauth_states","cards","shop_users"))jdbc.update("DELETE FROM "+table);
        jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES('admin','관리자','ADMIN'),('other-admin','다른 관리자','ADMIN'),('customer','회원','CUSTOMER')");
        for(String user:List.of("admin","other-admin","customer"))jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",s.hash(user),user,"csrf-"+user,s.now()+3600);
        jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES('CARD_01','검색100% 카드','','테스트 세트',100,3,'')");
        jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image,active,is_sample) VALUES('SAMPLE','예시','','',0,99,'',FALSE,TRUE)");
    }
    String body(Object object) throws Exception{return json.writeValueAsString(object);}
    String pair() throws Exception {
        var create=web.perform(post("/shop-api/admin/inventory/pairings").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content("{\"deviceName\":\"매장 PC\"}")).andExpect(status().isOk()).andReturn();
        String code=json.readTree(create.getResponse().getContentAsString()).path("pairCode").asText();
        var response=web.perform(post("/shop-api/inventory/pair").contentType("application/json").content(body(Map.of("pairCode",code,"deviceName","매장 PC")))).andExpect(status().isOk()).andReturn();
        web.perform(post("/shop-api/inventory/pair").contentType("application/json").content(body(Map.of("pairCode",code,"deviceName","중복 PC")))).andExpect(status().isUnauthorized());
        String token=json.readTree(response.getResponse().getContentAsString()).path("deviceToken").asText();
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM inventory_devices WHERE token_hash=?",Integer.class,token));
        return token;
    }
    Map<String,Object> stockBody(String type,int quantity,long version,String operation){return Map.of("productId","CARD_01","type",type,"quantity",quantity,"reason","매장 재고 확인","expectedVersion",version,"operationId",operation);}
    @Test void adminPairingRequiresRoleOriginAndCsrf() throws Exception {
        for(String user:List.of("customer","admin")){
            var request=post("/shop-api/admin/inventory/pairings").cookie(new Cookie("swp_session",user)).header("Origin",s.origin).header("X-CSRF-Token",user.equals("admin")?"wrong":"csrf-customer").contentType("application/json").content("{\"deviceName\":\"PC\"}");
            web.perform(request).andExpect(status().isForbidden());
        }
        web.perform(post("/shop-api/admin/inventory/pairings").cookie(new Cookie("swp_session","admin")).header("Origin","https://untrusted.example").header("X-CSRF-Token","csrf-admin").contentType("application/json").content("{\"deviceName\":\"PC\"}")).andExpect(status().isForbidden());
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM inventory_pairings",Integer.class));
    }
    @Test void nativeApiRejectsAmbientCookieOriginMissingRevokedAndDemotedTokens() throws Exception {
        web.perform(get("/shop-api/inventory/products").cookie(new Cookie("swp_session","admin"))).andExpect(status().isUnauthorized());
        String token=pair();
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token).header("Origin",s.origin)).andExpect(status().isForbidden());
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items[0].id").value("CARD_01"));
        jdbc.update("UPDATE shop_users SET role='CUSTOMER' WHERE id='admin'");
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(status().isUnauthorized());
        jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id='admin'");
        web.perform(delete("/shop-api/inventory/device").header("Authorization","Bearer "+token)).andExpect(status().isOk());
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(status().isUnauthorized());
    }
    @Test void expiredAndRevokedConnectionsCannotReadOrWrite() throws Exception {
        String token=pair();jdbc.update("UPDATE inventory_devices SET expires=?",s.now()-1);
        web.perform(get("/shop-api/inventory/overview").header("Authorization","Bearer "+token)).andExpect(status().isUnauthorized());
        jdbc.update("UPDATE inventory_devices SET expires=?,revoked=TRUE",s.now()+1000);
        web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(body(stockBody("IN",1,0,UUID.randomUUID().toString())))).andExpect(status().isUnauthorized());
    }
    @Test void pairedStoreProductsIncludePersistedGameAndOfficialImageForDesktopDisplay() throws Exception {
        String token=pair(),image="https://onepiece-cardgame.kr/fileDownload?downname=20250918_210023_2cf9a23a59";
        jdbc.update("UPDATE cards SET game=?,image=? WHERE id='CARD_01'","원피스 카드게임",image);
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].game").value("원피스 카드게임")).andExpect(jsonPath("$.items[0].image").value(image));
    }
    @Test void pairingExpiryAndBrowserPairingAreRejected() throws Exception {
        String code=s.token();jdbc.update("INSERT INTO inventory_pairings VALUES(?,?,?,?)",s.hash(code),"admin","PC",s.now()-1);
        String input=body(Map.of("pairCode",code,"deviceName","PC"));
        web.perform(post("/shop-api/inventory/pair").contentType("application/json").content(input)).andExpect(status().isUnauthorized());
        web.perform(post("/shop-api/inventory/pair").header("Origin",s.origin).contentType("application/json").content(input)).andExpect(status().isForbidden());
    }
    @Test void deviceListHidesTokensAndOnlyOwnerCanRevoke() throws Exception {
        pair();String id=jdbc.queryForObject("SELECT id FROM inventory_devices",String.class);
        var response=web.perform(get("/shop-api/admin/inventory/devices").cookie(new Cookie("swp_session","admin"))).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].name").value("매장 PC")).andExpect(jsonPath("$.items[0].token_hash").doesNotExist()).andReturn();
        assertFalse(response.getResponse().getContentAsString().contains("token"));
        web.perform(delete("/shop-api/admin/inventory/devices/"+id).cookie(new Cookie("swp_session","other-admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-other-admin")).andExpect(status().isNotFound());
        web.perform(delete("/shop-api/admin/inventory/devices/"+id).cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin")).andExpect(status().isOk());
    }
    @Test void sharedLedgerStockChangeIsPersistentIdempotentAndVisibleToStore() throws Exception {
        String token=pair(),operation=UUID.randomUUID().toString(),input=body(stockBody("OUT",2,0,operation));
        var result=web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(input)).andExpect(status().isOk()).andExpect(jsonPath("$.product.stock").value(1)).andExpect(jsonPath("$.product.version").value(1)).andExpect(jsonPath("$.movement.beforeStock").value(3)).andExpect(jsonPath("$.movement.type").value("OUT")).andReturn().getResponse().getContentAsString();
        String retry=web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(input)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertEquals(json.readTree(result),json.readTree(retry));assertEquals(1,jdbc.queryForObject("SELECT stock FROM cards WHERE id='CARD_01'",Integer.class));assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
        assertEquals(1,((Number)s.cards().getFirst().get("stock")).intValue());
        web.perform(get("/shop-api/inventory/history").header("Authorization","Bearer "+token).param("productId","CARD_01")).andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items[0].operationId").value(operation));
        web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(body(stockBody("OUT",1,0,operation)))).andExpect(status().isConflict());
    }
    @Test void webOrderAdminStockAndCancellationAdvanceSameMonotonicVersion() throws Exception {
        String token=pair();var order=s.checkout("customer",new ShopService.Checkout(List.of(new ShopService.Item("CARD_01",1)),"inventory-checkout-12345"));
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(jsonPath("$.items[0].version").value(1)).andExpect(jsonPath("$.items[0].stock").value(2));
        web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(body(stockBody("IN",1,0,UUID.randomUUID().toString())))).andExpect(status().isConflict());
        s.cancel("customer",order.get("id").toString());
        web.perform(post("/shop-api/admin/products/CARD_01/stock").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content("{\"delta\":2,\"expectedStock\":3,\"reason\":\"입고\"}")).andExpect(status().isOk());
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(jsonPath("$.items[0].version").value(3)).andExpect(jsonPath("$.items[0].stock").value(5));
    }
    @Test void quantitiesValidationInsufficientNoChangeAndLiteralSearch() throws Exception {
        String token=pair();
        for(String input:List.of(body(stockBody("OUT",4,0,UUID.randomUUID().toString())),body(stockBody("ADJUST",3,0,UUID.randomUUID().toString()))))web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(input)).andExpect(status().is4xxClientError());
        for(String quantity:List.of("1.5","-1","100000000","\"2\"","null")){
            String input=body(stockBody("IN",1,0,UUID.randomUUID().toString())).replace("\"quantity\":1","\"quantity\":"+quantity);
            web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(input)).andExpect(status().isUnprocessableEntity());
        }
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token).param("query","%")).andExpect(jsonPath("$.total").value(1));
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token).param("query","' OR 1=1 --")).andExpect(jsonPath("$.total").value(0));
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
    }
    @Test void concurrentDeviceUpdatesCannotLoseStockAndFailedTransactionLeavesNoOperation() throws Exception {
        pair();var row=jdbc.queryForMap("SELECT id,actor_id FROM inventory_devices");var device=new InventoryDeviceService.Device(row.get("ID").toString(),row.get("ACTOR_ID").toString());
        try(var threads=Executors.newFixedThreadPool(2)){
            var one=threads.submit(()->change(device));var two=threads.submit(()->change(device));assertEquals(1,one.get()+two.get());
        }
        assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM inventory_operations",Integer.class));assertEquals(1,jdbc.queryForObject("SELECT stock FROM cards WHERE id='CARD_01'",Integer.class));
    }
    int change(InventoryDeviceService.Device device){try{inventory.adjust(device,new InventoryService.Stock("CARD_01","OUT",2,"판매",0L,UUID.randomUUID().toString()));return 1;}catch(InventoryException e){assertEquals(409,e.getStatusCode().value());return 0;}}
    @Test void unconfiguredSmartStoreIsNeverReportedConnectedAndDoesNotWrite() throws Exception {
        String token=pair();
        web.perform(get("/shop-api/inventory/smartstore/status").header("Authorization","Bearer "+token)).andExpect(status().isOk()).andExpect(jsonPath("$.configured").value(false)).andExpect(jsonPath("$.connected").value(false)).andExpect(jsonPath("$.syncEnabled").value(false));
        web.perform(post("/shop-api/inventory/smartstore/sync").header("Authorization","Bearer "+token).contentType("application/json").content("{\"productIds\":[\"CARD_01\"]}")).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].status").value("NOT_CONFIGURED"));
        web.perform(get("/shop-api/inventory/smartstore/products").header("Authorization","Bearer "+token)).andExpect(status().isServiceUnavailable());
    }
    String updateProduct(String name,int price) throws Exception{return body(Map.of("id","CARD_01","name",name,"en","","set","테스트 세트","game","원피스 카드게임","condition","NM","language","한국어","price",price,"image","","active",true));}
    @Test void identityChangesAdvanceVersionAndMappedIdentityIsImmutableButPriceRemainsEditable() throws Exception {
        jdbc.update("UPDATE cards SET game='원피스 카드게임' WHERE id='CARD_01'");
        web.perform(put("/shop-api/admin/products/CARD_01").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(updateProduct("새 상품명",100))).andExpect(status().isOk());
        assertEquals(1L,jdbc.queryForObject("SELECT inventory_version FROM cards WHERE id='CARD_01'",Long.class));
        jdbc.update("INSERT INTO smartstore_mappings(card_id,origin_product_no,channel_product_no,actor_id,status,remote_stock,baseline_at,message) VALUES('CARD_01','100','200','admin','BLOCKED',3,?,'초기 확인')",s.now());
        web.perform(put("/shop-api/admin/products/CARD_01").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(updateProduct("다른 카드",100))).andExpect(status().isConflict());
        assertEquals("새 상품명",jdbc.queryForObject("SELECT name FROM cards WHERE id='CARD_01'",String.class));
        web.perform(put("/shop-api/admin/products/CARD_01").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(updateProduct("새 상품명",200))).andExpect(status().isOk());
        assertEquals(200L,jdbc.queryForObject("SELECT price FROM cards WHERE id='CARD_01'",Long.class));assertEquals(1L,jdbc.queryForObject("SELECT inventory_version FROM cards WHERE id='CARD_01'",Long.class));
    }
    @Test void allWritersRejectOverflowAndCancellationRollsBackAtUpperBound() throws Exception {
        String token=pair();jdbc.update("UPDATE cards SET stock=? WHERE id='CARD_01'",InventoryService.MAX_STOCK);
        web.perform(post("/shop-api/admin/products/CARD_01/stock").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(body(Map.of("delta",1,"expectedStock",InventoryService.MAX_STOCK,"reason","상한 검증")))).andExpect(status().isUnprocessableEntity());
        var order=s.checkout("customer",new ShopService.Checkout(List.of(new ShopService.Item("CARD_01",1)),"upper-bound-cancel-12345"));
        web.perform(post("/shop-api/inventory/stock").header("Authorization","Bearer "+token).contentType("application/json").content(body(stockBody("ADJUST",InventoryService.MAX_STOCK,1,UUID.randomUUID().toString())))).andExpect(status().isOk());
        var error=assertThrows(org.springframework.web.server.ResponseStatusException.class,()->s.cancel("customer",order.get("id").toString()));assertEquals(409,error.getStatusCode().value());
        assertEquals(InventoryService.MAX_STOCK,jdbc.queryForObject("SELECT stock FROM cards WHERE id='CARD_01'",Integer.class));assertEquals("접수",jdbc.queryForObject("SELECT status FROM shop_orders WHERE id=?",String.class,order.get("id")));assertEquals(2,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
    }
}
