package com.swp.shop;

import jakarta.servlet.http.Cookie;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:shop-tests;DB_CLOSE_DELAY=-1","SHOP_IMPORT_ENABLED=false"})
@AutoConfigureMockMvc
class ShopIntegrationTest {
    @Autowired ShopService shop;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc web;
    private final String origin="http://127.0.0.1:5175";
    @BeforeEach void reset(){
        for(String table:List.of("shop_events","stock_movements","order_items","shop_orders","carts","binders","sessions","oauth_states","cards","shop_users"))jdbc.update("DELETE FROM "+table);
        jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES('test-card','테스트 카드','Test','Set',500,3,'test.png')");
        for(String user:List.of("one","two")){jdbc.update("INSERT INTO shop_users(id,nickname) VALUES(?,?)",user,user);jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",shop.hash(user),user,"csrf-"+user,shop.now()+1000);}
    }
    ShopService.Checkout body(String key,int n){return new ShopService.Checkout(List.of(new ShopService.Item("test-card",n)),key);}
    int stock(){return jdbc.queryForObject("SELECT stock FROM cards WHERE id='test-card'",Integer.class);}
    @Test void authenticationAndCsrf() throws Exception {
        web.perform(get("/shop-api/orders")).andExpect(status().isUnauthorized());
        web.perform(put("/shop-api/cart").cookie(new Cookie("swp_session","one")).header("Origin","https://evil.example").header("X-CSRF-Token","csrf-one").contentType("application/json").content("{\"items\":[]}")).andExpect(status().isForbidden());
        web.perform(put("/shop-api/cart").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","bad").contentType("application/json").content("{\"items\":[]}")).andExpect(status().isForbidden());
        web.perform(get("/shop-api/auth/callback").param("state","fake").param("code","fake")).andExpect(status().isBadRequest());
    }
    @Test void accountIsolationAndCartValidation(){
        shop.save("one","test-card",true);assertEquals(List.of("test-card"),shop.binder("one"));assertTrue(shop.binder("two").isEmpty());
        shop.saveCart("one",List.of(new ShopService.Item("test-card",2)));assertTrue(shop.cart("two").isEmpty());
        assertThrows(ResponseStatusException.class,()->shop.saveCart("one",List.of(new ShopService.Item("test-card",4))));
        assertEquals(2,shop.cart("one").getFirst().get("quantity"));
        assertThrows(ResponseStatusException.class,()->shop.saveCart("one",List.of(new ShopService.Item("test-card",1),new ShopService.Item("test-card",1))));
    }
    @Test void serverPriceIdempotencyCancelAndOwnership(){
        var order=shop.checkout("one",body("request-key-one-12345",2));assertEquals(1000L,order.get("total"));assertEquals(1,stock());
        assertEquals(order.get("id"),shop.checkout("one",body("request-key-one-12345",2)).get("id"));assertEquals(1,stock());
        assertTrue(shop.orders("two").isEmpty());assertThrows(ResponseStatusException.class,()->shop.cancel("two",order.get("id").toString()));
        shop.cancel("one",order.get("id").toString());shop.cancel("one",order.get("id").toString());assertEquals(3,stock());
    }
    @Test void rollbackWhenAnyItemFails(){
        var invalid=new ShopService.Checkout(List.of(new ShopService.Item("test-card",1),new ShopService.Item("unknown",1)),"request-invalid-12345");
        assertThrows(ResponseStatusException.class,()->shop.checkout("one",invalid));assertEquals(3,stock());assertTrue(shop.orders("one").isEmpty());
    }
    @Test void concurrentOrdersCannotOversell() throws Exception {
        try(var threads=Executors.newFixedThreadPool(2)){
            var a=threads.submit(()->buy("one","concurrent-key-one-12345"));var b=threads.submit(()->buy("two","concurrent-key-two-12345"));
            assertEquals(1,a.get()+b.get());assertEquals(0,stock());
        }
    }
    private int buy(String user,String key){try{shop.checkout(user,body(key,3));return 1;}catch(ResponseStatusException e){assertEquals(409,e.getStatusCode().value());return 0;}}
    @Test void apiRejectsInvalidQuantityAndIgnoresClientTotal() throws Exception {
        web.perform(post("/shop-api/orders").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content("{\"items\":[{\"id\":\"test-card\",\"quantity\":0}],\"request_key\":\"api-key-invalid-123456\"}")).andExpect(status().isUnprocessableEntity());
        web.perform(post("/shop-api/orders").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content("{\"items\":[{\"id\":\"test-card\",\"quantity\":1}],\"request_key\":\"api-key-valid-123456\",\"total\":1}")).andExpect(status().isCreated()).andExpect(jsonPath("$.total").value(500));
    }
    @Test void logoutRevokesCookieSession() throws Exception {
        web.perform(post("/shop-api/auth/logout").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one")).andExpect(status().isOk()).andExpect(header().string("Set-Cookie",org.hamcrest.Matchers.containsString("HttpOnly")));
        web.perform(get("/shop-api/me").cookie(new Cookie("swp_session","one"))).andExpect(jsonPath("$.user").doesNotExist());
    }
    @Test void sampleCatalogueIsNotPublished(){
        shop.saveCart("one",List.of(new ShopService.Item("test-card",1)));
        jdbc.update("UPDATE cards SET is_sample=TRUE WHERE id='test-card'");
        assertTrue(shop.cards().isEmpty());assertTrue(shop.cart("one").isEmpty());
        assertThrows(ResponseStatusException.class,()->shop.checkout("one",body("sample-order-key-1234",1)));
    }
    @Test void adminProductInventoryAndAccessControl() throws Exception {
        web.perform(get("/shop-api/admin/products").cookie(new Cookie("swp_session","two"))).andExpect(status().isForbidden());
        jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id='one'");
        String product="""
          {"product":{"id":"LIVE-001","name":"DB 등록 시험","en":"","set":"테스트 세트","game":"원피스 카드게임","condition":"NM","language":"한국어","price":12500,"image":"","active":true},"stock":5}
          """;
        web.perform(post("/shop-api/admin/products").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content(product)).andExpect(status().isOk()).andExpect(jsonPath("$.price").value(12500));
        web.perform(post("/shop-api/admin/products/LIVE-001/stock").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content("{\"delta\":2,\"expectedStock\":5,\"reason\":\"입고 확인\"}")).andExpect(status().isOk()).andExpect(jsonPath("$.stock").value(7));
        web.perform(post("/shop-api/admin/products/LIVE-001/stock").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content("{\"delta\":2,\"expectedStock\":5,\"reason\":\"중복 입고\"}")).andExpect(status().isConflict());
        assertEquals(7,jdbc.queryForObject("SELECT stock FROM cards WHERE id='LIVE-001'",Integer.class));
        assertEquals(2,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements WHERE card_id='LIVE-001'",Integer.class));
        assertTrue(shop.cards().stream().anyMatch(p->p.get("id").equals("LIVE-001")&&p.get("game").equals("원피스 카드게임")));
        web.perform(get("/shop-api/admin/summary").cookie(new Cookie("swp_session","one"))).andExpect(status().isOk()).andExpect(jsonPath("$.tables.stock_movements").value(2));
    }
    @Test void fulfilledOrderCannotBeCancelled() throws Exception {
        jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id='one'");
        var order=shop.checkout("two",body("fulfillment-test-key-1234",1));
        web.perform(post("/shop-api/admin/orders/"+order.get("id")+"/complete").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one")).andExpect(status().isOk());
        assertThrows(ResponseStatusException.class,()->shop.cancel("two",order.get("id").toString()));assertEquals(2,stock());
    }
    @Test void sampleRequiresPhysicalStockConfirmation() throws Exception {
        jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id='one'");jdbc.update("UPDATE cards SET is_sample=TRUE,active=FALSE WHERE id='test-card'");
        String product="""
          {"id":"test-card","name":"확인한 실제 상품","en":"","set":"세트","game":"원피스 카드게임","condition":"NM","language":"한국어","price":10000,"image":"","active":true}
          """;
        web.perform(put("/shop-api/admin/products/test-card").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content(product)).andExpect(status().isUnprocessableEntity());
        assertTrue(shop.cards().isEmpty());
        String confirmed=product.trim().replace("\"active\":true}","\"active\":true,\"confirmedStock\":0}");
        web.perform(put("/shop-api/admin/products/test-card").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content(confirmed)).andExpect(status().isOk()).andExpect(jsonPath("$.stock").value(0));
        assertEquals(0,stock());assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
    }
    @Test void managedEventsAreStoredAndPublished() throws Exception {
        jdbc.update("UPDATE shop_users SET role='ADMIN' WHERE id='one'");
        String event="{\"game\":\"원피스 카드게임\",\"title\":\"일정 등록 검증\",\"startsAt\":\"2026-10-14T19:30:00\",\"description\":\"검증용\",\"active\":true}";
        web.perform(post("/shop-api/admin/events").cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content(event)).andExpect(status().isOk());
        web.perform(get("/shop-api/events")).andExpect(jsonPath("$[0].title").value("일정 등록 검증"));
        long id=jdbc.queryForObject("SELECT id FROM shop_events",Long.class);
        web.perform(put("/shop-api/admin/events/"+id).cookie(new Cookie("swp_session","one")).header("Origin",origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content(event.replace("\"active\":true","\"active\":false"))).andExpect(status().isOk());
        assertTrue(shop.events().isEmpty());assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM shop_events",Integer.class));
    }
    @Autowired DatabaseBootstrap bootstrap;
    @Test
    @org.springframework.transaction.annotation.Transactional
    void categoriesAreReadFromDatabaseAndNotResetOnStartup() throws Exception {
        jdbc.update("INSERT INTO games(name,sort_order) VALUES('DB 분류 확인',-1)");
        jdbc.update("DELETE FROM games WHERE name='리프트바운드'");
        bootstrap.run(null);
        web.perform(get("/shop-api/games")).andExpect(status().isOk())
            .andExpect(jsonPath("$[0]").value("DB 분류 확인"))
            .andExpect(jsonPath("$",org.hamcrest.Matchers.not(org.hamcrest.Matchers.hasItem("리프트바운드"))));
    }
}
