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
    String reference(String url,long price){return "{\"url\":\""+url+"\",\"price\":"+price+",\"checkedAt\":\""+java.time.Instant.now().minusSeconds(60)+"\",\"confirmed\":true}";}
    @Test void multipleReferenceApiAuditsRowsAndNeverChangesProductPrice() throws Exception {
        String a=reference("https://smartstore.naver.com/cardbean/products/13827937760",3000),b=reference("https://smartstore.naver.com/ckmr/products/13826678249",2000);
        String multi=body.substring(0,body.length()-1)+",\"naverManualPrice\":0,\"naverReferences\":["+a+","+b+"]}";
        web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","admin")).header("Origin",shop.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(multi)).andExpect(status().isOk()).andExpect(jsonPath("$.recommendedPrice").value(2000)).andExpect(jsonPath("$.selectedUrl").value("https://smartstore.naver.com/ckmr/products/13826678249")).andExpect(jsonPath("$.quotes.length()").value(4));
        assertEquals(12345L,jdbc.queryForObject("SELECT price FROM cards WHERE id='manual'",Long.class));
        String audit=jdbc.queryForObject("SELECT request_json FROM price_reference_checks",String.class);assertTrue(audit.contains("naverReferenceCount\":2"));assertTrue(audit.contains("3000"));assertFalse(audit.contains("cardbean"));
    }
    @Test void nestedReferenceValidationRejectsOversizedOrInvalidRequests() throws Exception {
        String valid=reference("https://smartstore.naver.com/shop/products/1",1000);
        for(String refs:new String[]{"["+String.join(",",java.util.Collections.nCopies(11,valid))+"]","[null]","["+reference("https://smartstore.naver.com/shop/products/1",0)+"]","["+valid.replace("\"price\":1000","\"price\":500.5")+"]"}){
            String request=body.substring(0,body.length()-1)+",\"naverReferences\":"+refs+"}";
            web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","admin")).header("Origin",shop.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(request)).andExpect(status().isUnprocessableEntity());
        }
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM price_reference_checks",Integer.class));
        assertEquals(12345L,jdbc.queryForObject("SELECT price FROM cards WHERE id='manual'",Long.class));
    }
    @Test void invalidReferenceRowBlocksSelectionWithoutPersistingCredentials() throws Exception {
        String a=reference("https://smartstore.naver.com/cardbean/products/13827937760",3000),bad=reference("https://secret-user:secret-password@smartstore.naver.com/ckmr/products/13826678249",1000);
        String request=body.substring(0,body.length()-1)+",\"naverReferences\":["+a+","+bad+"]}";
        web.perform(post("/shop-api/admin/pricing/quote").cookie(new Cookie("swp_session","admin")).header("Origin",shop.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json").content(request)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("NEEDS_MAPPING")).andExpect(jsonPath("$.recommendedPrice").isEmpty()).andExpect(jsonPath("$.selectedUrl").isEmpty()).andExpect(jsonPath("$.quotes[3].title").value("상품"));
        String audit=jdbc.queryForMap("SELECT request_json,result_json FROM price_reference_checks").toString();assertFalse(audit.contains("secret-user"));assertFalse(audit.contains("secret-password"));
    }
}
