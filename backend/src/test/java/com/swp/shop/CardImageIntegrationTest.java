package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import java.sql.DriverManager;
import java.util.*;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.util.ReflectionTestUtils;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:card-images-tests;DB_CLOSE_DELAY=-1","spring.datasource.username=sa","spring.datasource.password=","SHOP_IMPORT_ENABLED=false","SMARTSTORE_CLIENT_ID=","SMARTSTORE_CLIENT_SECRET=","SMARTSTORE_SYNC_ENABLED=false","SMARTSTORE_AUTO_SYNC_ENABLED=false"})
@AutoConfigureMockMvc
class CardImageIntegrationTest {
    @Autowired ShopService s;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc web;
    @Autowired ObjectMapper json;
    @Autowired CardImageService images;
    @MockitoBean CardImageHttpClient http;
    @BeforeEach void reset() throws Exception {
        for(String table:List.of("smartstore_order_effects","smartstore_mappings","inventory_operations","inventory_devices","inventory_pairings","price_reference_checks","stock_movements","order_items","shop_orders","carts","binders","sessions","oauth_states","cards","shop_users"))jdbc.update("DELETE FROM "+table);
        jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES('admin','관리자','ADMIN'),('customer','회원','CUSTOMER')");for(String user:List.of("admin","customer"))jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)",s.hash(user),user,"csrf-"+user,s.now()+1000);
        ((Map<?,?>)ReflectionTestUtils.getField(images,"cache")).clear();ReflectionTestUtils.setField(images,"gallery",null);
    }
    String body(Object object) throws Exception{return json.writeValueAsString(object);}
    Map<String,Object> searchBody(String game,String query,String language){return Map.of("game",game,"query",query,"language",language);}
    org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder adminPost(String path){return post(path).cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","csrf-admin").contentType("application/json");}
    @Test void officialSearchRequiresAdminSessionOriginAndCsrfBeforeSourceAccess() throws Exception {
        String input=body(searchBody("원피스 카드게임","OP08-001","한국어"));
        web.perform(post("/shop-api/admin/images/search").contentType("application/json").content(input)).andExpect(status().isForbidden());
        web.perform(post("/shop-api/admin/images/search").cookie(new Cookie("swp_session","customer")).header("Origin",s.origin).header("X-CSRF-Token","csrf-customer").contentType("application/json").content(input)).andExpect(status().isForbidden());
        web.perform(post("/shop-api/admin/images/search").cookie(new Cookie("swp_session","admin")).header("Origin","https://untrusted.example").header("X-CSRF-Token","csrf-admin").contentType("application/json").content(input)).andExpect(status().isForbidden());
        web.perform(post("/shop-api/admin/images/search").cookie(new Cookie("swp_session","admin")).header("Origin",s.origin).header("X-CSRF-Token","invalid").contentType("application/json").content(input)).andExpect(status().isForbidden());verifyNoInteractions(http);
    }
    @Test void validationRejectsBlankOversizedAndInvalidPageWithoutSourceRequests() throws Exception {
        for(var input:List.of(Map.of("game","원피스 카드게임","query"," ","language","한국어"),Map.of("game","원피스 카드게임","query","x".repeat(121),"language","한국어"),Map.of("game","원피스 카드게임","query","조로","language",""),Map.of("game","원피스 카드게임","query","조로","language","한국어","page",-1),Map.of("game","원피스 카드게임","query","조로","language","한국어","page",21),Map.of("game","원피스 카드게임","query","조로","language","한국어","page",1.5)))web.perform(adminPost("/shop-api/admin/images/search").content(body(input))).andExpect(status().isUnprocessableEntity());verifyNoInteractions(http);
    }
    @Test void languageAndUnsupportedGameAreExplicitAndDoNotFetchFallbackImages() throws Exception {
        web.perform(adminPost("/shop-api/admin/images/search").content(body(searchBody("플래시 앤 블러드","Command and Conquer","한국어")))).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UNSUPPORTED_LANGUAGE")).andExpect(jsonPath("$.items").isEmpty());
        web.perform(adminPost("/shop-api/admin/images/search").content(body(searchBody("다른 게임","상품","한국어")))).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UNSUPPORTED_GAME"));verifyNoInteractions(http);
    }
    @Test void imageSearchIsReadOnlyAndSelectedCandidatePersistsOnlyThroughProductSave() throws Exception {
        when(http.get(any())).thenReturn(CardImageSourceTest.fixture("riftbound.html"));
        String response=web.perform(adminPost("/shop-api/admin/images/search").content(body(searchBody("리프트바운드","가렌","한국어")))).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("OK")).andExpect(jsonPath("$.items[0].name").value("가렌, 강건")).andExpect(jsonPath("$.page").value(0)).andReturn().getResponse().getContentAsString();
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM cards",Integer.class));assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
        var selected=json.readTree(response).path("items").get(0);String image=selected.path("imageUrl").asText();var product=Map.of("id","IMG-SELECTED","name",selected.path("name").asText(),"en","","set",selected.path("setName").asText(),"game","리프트바운드","condition","NM","language","한국어","price",0,"image",image,"active",false);
        web.perform(adminPost("/shop-api/admin/products").content(body(Map.of("product",product,"stock",0)))).andExpect(status().isOk()).andExpect(jsonPath("$.image").value(image));
        assertEquals(image,jdbc.queryForObject("SELECT image FROM cards WHERE id='IMG-SELECTED'",String.class));assertEquals(0,jdbc.queryForObject("SELECT stock FROM cards WHERE id='IMG-SELECTED'",Integer.class));assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements",Integer.class));
    }
    @Test void extendedImageUrlCanBeSavedWithoutTruncationAndLimitIsStillEnforced() throws Exception {
        String image="https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/"+"a".repeat(240)+"-1488x2079.png?accountingTag=RB";
        assertTrue(image.length()>200);var product=new LinkedHashMap<String,Object>(Map.of("id","IMG-LONG","name","이미지 길이 검증","en","","set","세트","game","리프트바운드","condition","NM","language","한국어","price",0,"image",image,"active",false));
        web.perform(adminPost("/shop-api/admin/products").content(body(Map.of("product",product,"stock",0)))).andExpect(status().isOk());assertEquals(image,jdbc.queryForObject("SELECT image FROM cards WHERE id='IMG-LONG'",String.class));
        product.put("id","IMG-TOO-LONG");product.put("image","https://example.invalid/"+"a".repeat(1001));web.perform(adminPost("/shop-api/admin/products").content(body(Map.of("product",product,"stock",0)))).andExpect(status().isUnprocessableEntity());
    }
    @Test void nonDestructiveImageExpansionWorksInH2AndPostgresCompatibilityGrammar() throws Exception {
        String schema;try(var stream=new ClassPathResource("schema.sql").getInputStream()){schema=new String(stream.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);}
        String statement=schema.lines().filter(line->line.startsWith("ALTER TABLE cards ALTER COLUMN image TYPE")).findFirst().orElseThrow();
        for(String mode:List.of("",";MODE=PostgreSQL"))try(var connection=DriverManager.getConnection("jdbc:h2:mem:image-widen-"+UUID.randomUUID()+mode,"sa","");var sql=connection.createStatement()){
            sql.execute("CREATE TABLE cards(id VARCHAR(40) PRIMARY KEY,image VARCHAR(200) NOT NULL)");sql.execute("INSERT INTO cards VALUES('preserved','original.png')");sql.execute(statement);sql.execute("INSERT INTO cards VALUES('long','"+"x".repeat(800)+"')");
            try(var rows=sql.executeQuery("SELECT image FROM cards WHERE id='preserved'")){assertTrue(rows.next());assertEquals("original.png",rows.getString(1));}
            assertThrows(java.sql.SQLException.class,()->sql.execute("INSERT INTO cards VALUES('null',NULL)"));
        }
    }
}
