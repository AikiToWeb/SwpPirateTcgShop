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
import org.springframework.web.server.ResponseStatusException;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:purchase-limit-tests;DB_CLOSE_DELAY=-1","spring.datasource.username=sa","spring.datasource.password=","SHOP_IMPORT_ENABLED=false","SMARTSTORE_CLIENT_ID=","SMARTSTORE_CLIENT_SECRET=","SMARTSTORE_SYNC_ENABLED=false","SMARTSTORE_AUTO_SYNC_ENABLED=false"})
@AutoConfigureMockMvc
class PurchaseLimitIntegrationTest {
    @Autowired ShopService s;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc web;
    @Autowired ObjectMapper json;
    @BeforeEach void setup(){
        for(String table:List.of("smartstore_order_effects","smartstore_mappings","inventory_operations","inventory_devices","inventory_pairings","price_reference_checks","stock_movements","order_items","shop_orders","carts","binders","sessions","oauth_states","cards","shop_users"))jdbc.update("DELETE FROM "+table);
        jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES('one','회원1','CUSTOMER'),('two','회원2','CUSTOMER'),('admin','관리자','ADMIN')");
        for(String user:List.of("one","two","admin"))jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",s.hash(user),user,"csrf-"+user,s.now()+1000);
        jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image,game) VALUES('LIMIT','한도 상품','','세트',100,100,'','원피스 카드게임')");
    }
    String body(Object object) throws Exception{return json.writeValueAsString(object);}
    ShopService.Checkout order(String key,int quantity){return new ShopService.Checkout(List.of(new ShopService.Item("LIMIT",quantity)),key);}
    void limit(int value){jdbc.update("UPDATE cards SET purchase_limit=? WHERE id='LIMIT'",value);}
    int stock(){return jdbc.queryForObject("SELECT stock FROM cards WHERE id='LIMIT'",Integer.class);}
    org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder userPost(String route,String user){return post(route).cookie(new Cookie("swp_session",user)).header("Origin",s.origin).header("X-CSRF-Token","csrf-"+user).contentType("application/json");}
    Map<String,Object> product(Integer value){var product=new LinkedHashMap<String,Object>();product.put("id","LIMIT");product.put("name","한도 상품");product.put("en","");product.put("set","세트");product.put("game","원피스 카드게임");product.put("condition","NM");product.put("language","한국어");product.put("price",100);product.put("image","");product.put("active",true);if(value!=null)product.put("purchaseLimit",value);return product;}
    String pair() throws Exception {
        var paired=web.perform(userPost("/shop-api/admin/inventory/pairings","admin").content("{\"deviceName\":\"매장 PC\"}")).andExpect(status().isOk()).andReturn();
        String code=json.readTree(paired.getResponse().getContentAsString()).path("pairCode").asText();
        var token=web.perform(post("/shop-api/inventory/pair").contentType("application/json").content(body(Map.of("pairCode",code,"deviceName","매장 PC")))).andExpect(status().isOk()).andReturn();
        return json.readTree(token.getResponse().getContentAsString()).path("deviceToken").asText();
    }
    @Test void existingAndNewCardsDefaultToUnlimitedAndDtoIncludesLimit() throws Exception {
        assertEquals(0,((Number)s.cards().getFirst().get("purchaseLimit")).intValue());
        s.checkout("one",order("unlimited-one-1234567",100));jdbc.update("UPDATE cards SET stock=100 WHERE id='LIMIT'");s.checkout("one",order("unlimited-two-1234567",100));
        assertEquals(2,s.orders("one").size());var p=product(null);p.put("id","NEW");
        web.perform(userPost("/shop-api/admin/products","admin").content(body(Map.of("product",p,"stock",0)))).andExpect(status().isOk()).andExpect(jsonPath("$.purchaseLimit").value(0));
    }
    @Test void cumulativeLimitBlocksCartAndDirectCheckoutWhilePreservingPriorCart() throws Exception {
        limit(3);s.checkout("one",order("limited-first-1234567",2));s.saveCart("one",List.of(new ShopService.Item("LIMIT",1)));
        web.perform(put("/shop-api/cart").cookie(new Cookie("swp_session","one")).header("Origin",s.origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content("{\"items\":[{\"id\":\"LIMIT\",\"quantity\":2}]}"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("한도 상품"))).andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("3개"))).andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("현재 추가 구매 가능 수량 1개")));
        web.perform(userPost("/shop-api/orders","one").content(body(order("direct-bypass-1234567",2)))).andExpect(status().isConflict());
        assertEquals(98,stock());assertEquals(1,s.orders("one").size());assertEquals(1,((Number)s.cart("one").getFirst().get("quantity")).intValue());
    }
    @Test void oldOrdersCountWhenLimitIntroducedOrLoweredWithoutCancelingThem(){
        var first=s.checkout("one",order("old-unlimited-1234567",3));limit(2);
        var error=assertThrows(ResponseStatusException.class,()->s.checkout("one",order("after-lower-12345678",1)));assertEquals(409,error.getStatusCode().value());
        assertEquals("접수",s.orders("one").getFirst().get("status"));assertEquals(first.get("id"),s.checkout("one",order("old-unlimited-1234567",3)).get("id"));assertEquals(97,stock());
    }
    @Test void completedOrdersContinueCountingAndAnotherAccountHasSeparateAllowance() throws Exception {
        limit(2);var order=s.checkout("one",order("completed-limit-12345",2));
        web.perform(userPost("/shop-api/admin/orders/"+order.get("id")+"/complete","admin")).andExpect(status().isOk());
        assertThrows(ResponseStatusException.class,()->s.checkout("one",order("after-complete-12345",1)));s.checkout("two",order("other-account-123456",2));assertEquals(96,stock());
    }
    @Test void cancellationReleasesAllowanceAndSampleOrdersDoNotCount(){
        limit(2);var first=s.checkout("one",order("cancel-limit-1234567",2));s.cancel("one",first.get("id").toString());s.checkout("one",order("buy-after-cancel-123",2));
        assertEquals(98,stock());assertEquals(2,s.orders("one").size());
        jdbc.update("UPDATE shop_orders SET is_sample=TRUE WHERE status='접수'");s.checkout("one",order("buy-exclude-sample-12",2));assertEquals(96,stock());
    }
    @Test void simultaneousSplitOrdersBySameAccountCannotBypassCumulativeLimit() throws Exception {
        limit(3);
        try(var threads=Executors.newFixedThreadPool(2)){
            var one=threads.submit(()->buy("concurrent-limit-one-123"));var two=threads.submit(()->buy("concurrent-limit-two-123"));assertEquals(1,one.get()+two.get());
        }
        assertEquals(98,stock());assertEquals(1,s.orders("one").size());assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
    }
    int buy(String key){try{s.checkout("one",order(key,2));return 1;}catch(ResponseStatusException error){assertEquals(409,error.getStatusCode().value());return 0;}}
    @Test void adminLimitRequiresRoleCsrfAndStrictIntegerAndOmissionPreservesValue() throws Exception {
        var update=product(4);String input=body(update);
        web.perform(put("/shop-api/admin/products/LIMIT").cookie(new Cookie("swp_session","one")).header("Origin",s.origin).header("X-CSRF-Token","csrf-one").contentType("application/json").content(input)).andExpect(status().isForbidden());
        web.perform(put("/shop-api/admin/products/LIMIT").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","bad").contentType("application/json").content(input)).andExpect(status().isForbidden());
        for(String value:List.of("-1","1000001","1.5","\"2\""))web.perform(put("/shop-api/admin/products/LIMIT").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(input.replace("\"purchaseLimit\":4","\"purchaseLimit\":"+value))).andExpect(status().isUnprocessableEntity());
        web.perform(put("/shop-api/admin/products/LIMIT").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(input)).andExpect(status().isOk()).andExpect(jsonPath("$.purchaseLimit").value(4));
        web.perform(put("/shop-api/admin/products/LIMIT").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(body(product(null)))).andExpect(status().isOk()).andExpect(jsonPath("$.purchaseLimit").value(4));assertEquals(1L,jdbc.queryForObject("SELECT inventory_version FROM cards WHERE id='LIMIT'",Long.class));
    }
    @Test void pairedLimitSettingUsesVersionRoleOriginAndDoesNotAlterStockOrHistory() throws Exception {
        String token=pair(),route="/shop-api/inventory/products/LIMIT/purchase-limit",input="{\"purchaseLimit\":2,\"expectedVersion\":0}";
        web.perform(put(route).cookie(new Cookie("swp_session","admin")).contentType("application/json").content(input)).andExpect(status().isUnauthorized());
        web.perform(put(route).header("Authorization","Bearer "+token).header("Origin",s.origin).contentType("application/json").content(input)).andExpect(status().isForbidden());
        web.perform(put(route).header("Authorization","Bearer "+token).contentType("application/json").content(input)).andExpect(status().isOk()).andExpect(jsonPath("$.product.purchaseLimit").value(2)).andExpect(jsonPath("$.product.version").value(1));
        web.perform(put(route).header("Authorization","Bearer "+token).contentType("application/json").content(input)).andExpect(status().isConflict());
        assertEquals(100,stock());assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
        web.perform(get("/shop-api/inventory/products").header("Authorization","Bearer "+token)).andExpect(jsonPath("$.items[0].purchaseLimit").value(2));
        jdbc.update("UPDATE shop_users SET role='CUSTOMER' WHERE id='admin'");web.perform(put(route).header("Authorization","Bearer "+token).contentType("application/json").content("{\"purchaseLimit\":0,\"expectedVersion\":1}")).andExpect(status().isUnauthorized());
    }
    @Test void staleCartIsRecheckedAtCheckoutAfterAdministratorChangesLimit() throws Exception {
        s.saveCart("one",List.of(new ShopService.Item("LIMIT",3)));String token=pair();
        web.perform(put("/shop-api/inventory/products/LIMIT/purchase-limit").header("Authorization","Bearer "+token).contentType("application/json").content("{\"purchaseLimit\":2,\"expectedVersion\":0}")).andExpect(status().isOk());
        web.perform(userPost("/shop-api/orders","one").content(body(order("stale-cart-limit-12345",3)))).andExpect(status().isConflict());assertEquals(100,stock());assertEquals(3,((Number)s.cart("one").getFirst().get("quantity")).intValue());
    }
}
