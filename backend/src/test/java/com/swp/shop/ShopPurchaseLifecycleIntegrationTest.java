package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import java.util.*;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** The complete shop flow uses HTTP APIs and an explicitly isolated, non-operational DB. */
@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:purchase-lifecycle;DB_CLOSE_DELAY=-1","spring.datasource.username=sa","spring.datasource.password=","SHOP_IMPORT_ENABLED=false","SMARTSTORE_CLIENT_ID=","SMARTSTORE_CLIENT_SECRET=","SMARTSTORE_SYNC_ENABLED=false","SMARTSTORE_AUTO_SYNC_ENABLED=false"})
@AutoConfigureMockMvc
class ShopPurchaseLifecycleIntegrationTest {
    @Autowired MockMvc web;
    @Autowired JdbcTemplate jdbc;
    @Autowired ShopService shop;
    @Autowired ObjectMapper json;
    final String origin="http://127.0.0.1:5175";

    @BeforeEach void setup(){
        for(String table:List.of("stock_movements","order_items","shop_orders","carts","binders","sessions","oauth_states","cards","shop_users"))jdbc.update("DELETE FROM "+table);
        for(String user:List.of("admin","buyer","other")){
            jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES(?,?,?)",user,user.equals("buyer")?"수령 고객":user,user.equals("admin")?"ADMIN":"CUSTOMER");
            jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",shop.hash(user),user,"csrf-"+user,shop.now()+1000);
        }
    }
    MockHttpServletRequestBuilder auth(MockHttpServletRequestBuilder request,String user){return request.cookie(new Cookie("swp_session",user)).header("Origin",origin).header("X-CSRF-Token","csrf-"+user).contentType("application/json");}
    String body(Object value) throws Exception{return json.writeValueAsString(value);}
    Map<String,Object> product(boolean active){return Map.ofEntries(Map.entry("id","FLOW-001"),Map.entry("name","흐름 검증 카드"),Map.entry("en",""),Map.entry("set","검증 세트"),Map.entry("game","원피스 카드게임"),Map.entry("condition","NM"),Map.entry("language","한국어"),Map.entry("price",1500),Map.entry("image",""),Map.entry("active",active),Map.entry("purchaseLimit",2));}
    String checkout(String key,int quantity) throws Exception{return body(Map.of("items",List.of(Map.of("id","FLOW-001","quantity",quantity)),"request_key",key,"total",1));}
    int stock(){return jdbc.queryForObject("SELECT stock FROM cards WHERE id='FLOW-001'",Integer.class);}

    @Test void administratorPublishesStockAndCustomerRequestsCancelsAndCollects() throws Exception {
        web.perform(get("/shop-api/admin/orders")).andExpect(status().isUnauthorized());
        web.perform(auth(get("/shop-api/admin/orders"),"buyer")).andExpect(status().isForbidden());
        String create=body(Map.of("product",product(false),"stock",3));
        web.perform(auth(post("/shop-api/admin/products"),"buyer").content(create)).andExpect(status().isForbidden());
        web.perform(post("/shop-api/admin/products").cookie(new Cookie("swp_session","admin")).header("Origin",origin).header("X-CSRF-Token","bad").contentType("application/json").content(create)).andExpect(status().isForbidden());
        web.perform(auth(post("/shop-api/admin/products"),"admin").content(create)).andExpect(status().isOk());
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$.length()").value(0));
        web.perform(auth(post("/shop-api/orders"),"buyer").content(checkout("hidden-product-key-123",1))).andExpect(status().isConflict());
        web.perform(auth(put("/shop-api/admin/products/FLOW-001"),"admin").content(body(product(true)))).andExpect(status().isOk());
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$[0].id").value("FLOW-001")).andExpect(jsonPath("$[0].price").value(1500));
        web.perform(auth(post("/shop-api/admin/products/FLOW-001/stock"),"admin").content("{\"delta\":2,\"expectedStock\":3,\"reason\":\"실물 입고 확인\"}")).andExpect(status().isOk());
        web.perform(auth(post("/shop-api/admin/products/FLOW-001/stock"),"admin").content("{\"delta\":1,\"expectedStock\":3,\"reason\":\"충돌\"}")).andExpect(status().isConflict());
        web.perform(auth(put("/shop-api/cart"),"buyer").content("{\"items\":[{\"id\":\"FLOW-001\",\"quantity\":2}]}" )).andExpect(status().isOk());
        String request=checkout("lifecycle-first-key-123",2);
        var response=web.perform(auth(post("/shop-api/orders"),"buyer").content(request)).andExpect(status().isCreated()).andExpect(jsonPath("$.total").value(3000)).andReturn();
        String id=json.readTree(response.getResponse().getContentAsString()).path("id").asText();
        web.perform(auth(post("/shop-api/orders"),"buyer").content(request)).andExpect(jsonPath("$.id").value(id));
        assertEquals(3,stock());
        web.perform(auth(get("/shop-api/cart"),"buyer")).andExpect(jsonPath("$.length()").value(0));
        web.perform(auth(get("/shop-api/orders"),"other")).andExpect(jsonPath("$.length()").value(0));
        web.perform(auth(post("/shop-api/orders/"+id+"/cancel"),"other")).andExpect(status().isNotFound());
        web.perform(auth(post("/shop-api/orders"),"buyer").content(checkout("lifecycle-limit-key-123",1))).andExpect(status().isConflict());
        web.perform(auth(post("/shop-api/orders/"+id+"/cancel"),"buyer")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("취소"));
        web.perform(auth(post("/shop-api/orders/"+id+"/cancel"),"buyer")).andExpect(status().isOk());
        assertEquals(5,stock());
        var replacement=web.perform(auth(post("/shop-api/orders"),"buyer").content(checkout("lifecycle-reorder-key-123",2))).andExpect(status().isCreated()).andReturn();
        String replacementId=json.readTree(replacement.getResponse().getContentAsString()).path("id").asText();
        web.perform(auth(post("/shop-api/admin/orders/"+replacementId+"/complete"),"buyer")).andExpect(status().isForbidden());
        web.perform(auth(post("/shop-api/admin/orders/"+replacementId+"/complete"),"admin")).andExpect(status().isOk());
        web.perform(auth(post("/shop-api/orders/"+replacementId+"/cancel"),"buyer")).andExpect(status().isConflict());
        assertEquals(3,stock());
        assertEquals(List.of("INITIAL","IN","ORDER","CANCEL","ORDER"),jdbc.queryForList("SELECT inventory_type FROM stock_movements ORDER BY id",String.class));
        assertEquals(List.of(3,5,3,5,3),jdbc.queryForList("SELECT balance FROM stock_movements ORDER BY id",Integer.class));
        web.perform(auth(get("/shop-api/orders"),"buyer")).andExpect(jsonPath("$.length()").value(2)).andExpect(jsonPath("$[0].userId").doesNotExist()).andExpect(jsonPath("$[0].nickname").doesNotExist());
        web.perform(auth(get("/shop-api/admin/orders"),"admin")).andExpect(jsonPath("$.length()").value(2)).andExpect(jsonPath("$[0].userId").value("buyer")).andExpect(jsonPath("$[0].nickname").value("수령 고객"));
    }
    @Test void staleCartCanBeReducedOrRemovedButCannotIncreaseOrCheckout() throws Exception {
        web.perform(auth(post("/shop-api/admin/products"),"admin").content(body(Map.of("product",product(true),"stock",3)))).andExpect(status().isOk());
        // Lift the per-account cap to first save three, then lower both stock and cap.
        jdbc.update("UPDATE cards SET purchase_limit=0 WHERE id='FLOW-001'");
        jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES('OTHER','다른 카드','','세트',100,3,'')");
        web.perform(auth(put("/shop-api/cart"),"buyer").content("{\"items\":[{\"id\":\"FLOW-001\",\"quantity\":3},{\"id\":\"OTHER\",\"quantity\":2}]}" )).andExpect(status().isOk());
        jdbc.update("UPDATE cards SET stock=1,purchase_limit=1 WHERE id='FLOW-001'");
        jdbc.update("UPDATE cards SET stock=0 WHERE id='OTHER'");
        // Reducing one stale line must not be blocked by another unchanged stale line.
        web.perform(auth(put("/shop-api/cart"),"buyer").content("{\"items\":[{\"id\":\"FLOW-001\",\"quantity\":2},{\"id\":\"OTHER\",\"quantity\":2}]}" )).andExpect(status().isOk());
        web.perform(auth(put("/shop-api/cart"),"buyer").content("{\"items\":[{\"id\":\"FLOW-001\",\"quantity\":2}]}" )).andExpect(status().isOk());
        web.perform(auth(put("/shop-api/cart"),"buyer").content("{\"items\":[{\"id\":\"FLOW-001\",\"quantity\":3}]}" )).andExpect(status().isConflict());
        web.perform(auth(post("/shop-api/orders"),"buyer").content(checkout("stale-cart-checkout-123",2))).andExpect(status().isConflict());
        assertEquals(1,stock());
        web.perform(auth(get("/shop-api/cart"),"buyer")).andExpect(jsonPath("$[0].quantity").value(2));
        web.perform(auth(put("/shop-api/cart"),"buyer").content("{\"items\":[]}" )).andExpect(status().isOk());
        web.perform(auth(get("/shop-api/cart"),"buyer")).andExpect(jsonPath("$.length()").value(0));
    }

}
