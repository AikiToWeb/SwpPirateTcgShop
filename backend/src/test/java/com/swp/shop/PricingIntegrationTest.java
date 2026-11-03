package com.swp.shop;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:pricing-tests;DB_CLOSE_DELAY=-1","spring.datasource.username=sa","spring.datasource.password=","SHOP_IMPORT_ENABLED=false"})
@AutoConfigureMockMvc
class PricingIntegrationTest {
    @Autowired MockMvc web;@Autowired JdbcTemplate jdbc;@Autowired ShopService shop;
    String body="{\"name\":\"상품\",\"en\":\"\",\"set\":\"세트\",\"game\":\"플레시 앤 블러드\",\"language\":\"한국어\",\"condition\":\"NM\",\"productType\":\"BOX\",\"unitCount\":1,\"rollingAbsent\":true,\"cardnyangAbsent\":true}";
    @BeforeEach void setup(){jdbc.update("DELETE FROM price_reference_checks");jdbc.update("DELETE FROM sessions");jdbc.update("DELETE FROM shop_users");jdbc.update("DELETE FROM cards");jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES('admin','관리자','ADMIN'),('customer','회원','CUSTOMER')");for(String user:new String[]{"admin","customer"})jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",shop.hash(user),user,"csrf-"+user,shop.now()+1000);jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image) VALUES('manual','수동 판매가','','세트',12345,1,'')");}
    @Test void quoteRequiresAdminOriginAndCsrf() throws Exception {
        web.perform(post("/shop-api/admin/pricing/quote").contentType("application/json").content(body)).andExpect(status().isForbidden());
        web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","customer")).header("Origin",shop.origin).header("X-CSRF-Token","csrf-customer").contentType("application/json").content(body)).andExpect(status().isForbidden());
        web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","admin")).header("Origin",shop.origin).header("X-CSRF-Token","bad").contentType("application/json").content(body)).andExpect(status().isForbidden());
    }
    @Test void retiredNaverStateIsRecordedWithoutChangingManualPrice() throws Exception {
        web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","admin")).header("Origin",shop.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(body)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UNAVAILABLE")).andExpect(jsonPath("$.quotes[2].reason").value(org.hamcrest.Matchers.containsString("API_RETIRED")));
        assertEquals(12345L,jdbc.queryForObject("SELECT price FROM cards WHERE id='manual'",Long.class));assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM price_reference_checks",Integer.class));
        String metadata=jdbc.queryForObject("SELECT request_json FROM price_reference_checks",String.class);assertTrue(metadata.contains("한국어"));assertTrue(metadata.contains("NM"));assertTrue(metadata.contains("game"));
    }
    @Test void invalidUrlCredentialsAreNotPersisted() throws Exception {
        String invalid=body.replace("\"rollingAbsent\":true","\"rollingAbsent\":false,\"rollingUrl\":\"https://private-user:private-password@tcgrollingdice.com/mtga/index.php?mode=card&set=M13&code=224\"");
        web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","admin")).header("Origin",shop.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(invalid)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("NEEDS_MAPPING"));
        var row=jdbc.queryForMap("SELECT request_json,result_json FROM price_reference_checks");assertFalse(row.toString().contains("private-password"));assertFalse(row.toString().contains("private-user"));
    }
}
