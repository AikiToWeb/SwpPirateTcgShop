package com.swp.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.Cookie;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.doReturn;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:product-visibility;DB_CLOSE_DELAY=-1",
    "spring.datasource.username=sa", "spring.datasource.password=", "SHOP_IMPORT_ENABLED=false",
    "SMARTSTORE_CLIENT_ID=", "SMARTSTORE_CLIENT_SECRET=", "SMARTSTORE_SYNC_ENABLED=false",
    "SMARTSTORE_AUTO_SYNC_ENABLED=false"
})
@AutoConfigureMockMvc
class ProductVisibilityIntegrationTest {
    private static final String VISIBILITY = "/shop-api/admin/products/visibility";
    private static final String ORIGIN = "http://127.0.0.1:5175";
    private static final String SEOUL_MINUTE = "2030-08-03T13:00";
    private static final long RELEASE = Instant.parse("2030-08-03T04:00:00Z").getEpochSecond();
    @Autowired MockMvc web;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @MockitoSpyBean ShopService shop;

    @BeforeEach
    void setup() {
        doReturn(RELEASE - 1).when(shop).now();
        for (String table : List.of("stock_movements", "order_items", "shop_orders", "carts", "binders", "sessions", "cards", "shop_users")) {
            jdbc.update("DELETE FROM " + table);
        }
        for (String user : List.of("admin", "buyer")) {
            jdbc.update("INSERT INTO shop_users(id,nickname,role) VALUES(?,?,?)", user, user, user.equals("admin") ? "ADMIN" : "CUSTOMER");
            jdbc.update("INSERT INTO sessions VALUES(?,?,?,?)", shop.hash(user), user, "csrf-" + user, RELEASE + 3600);
        }
        seedCard("CARD-A", true, false);
        seedCard("CARD-B", false, false);
        seedCard("SAMPLE", false, true);
    }

    private void seedCard(String id, boolean active, boolean sample) {
        jdbc.update("INSERT INTO cards(id,name,en,set_name,price,stock,image,game,active,is_sample) VALUES(?,?, '', '세트', 500, 3, '', '원피스 카드게임', ?, ?)",
            id, id, active, sample);
    }

    private MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder request, String user) {
        return request.cookie(new Cookie("swp_session", user)).header("Origin", ORIGIN)
            .header("X-CSRF-Token", "csrf-" + user).contentType("application/json");
    }

    private MockHttpServletRequestBuilder change(String mode, String... ids) throws Exception {
        return as(post(VISIBILITY), "admin").content(json.writeValueAsString(Map.of("mode", mode, "ids", List.of(ids))));
    }

    private MockHttpServletRequestBuilder schedule(String date, String... ids) throws Exception {
        return as(post(VISIBILITY), "admin").content(json.writeValueAsString(Map.of("mode", "SCHEDULE", "ids", List.of(ids), "publishAt", date)));
    }

    @Test
    void authorizationAndInvalidSelectionsLeaveAllProductsUntouched() throws Exception {
        String common = "{\"ids\":[\"CARD-B\"],\"mode\":\"PUBLISH\"}";
        web.perform(post(VISIBILITY).header("Origin", ORIGIN).contentType("application/json").content(common))
            .andExpect(status().isUnauthorized());
        web.perform(as(post(VISIBILITY), "buyer").content(common)).andExpect(status().isForbidden());
        web.perform(post(VISIBILITY).cookie(new Cookie("swp_session", "admin")).header("Origin", "https://invalid.example")
            .header("X-CSRF-Token", "csrf-admin").contentType("application/json").content(common))
            .andExpect(status().isForbidden());
        web.perform(post(VISIBILITY).cookie(new Cookie("swp_session", "admin")).header("Origin", ORIGIN)
            .header("X-CSRF-Token", "bad").contentType("application/json").content(common))
            .andExpect(status().isForbidden());

        web.perform(change("PUBLISH", "CARD-B", "MISSING")).andExpect(status().isNotFound());
        web.perform(change("PUBLISH", "CARD-B", "SAMPLE")).andExpect(status().isUnprocessableEntity());
        web.perform(change("PUBLISH", "CARD-B", "CARD-B")).andExpect(status().isUnprocessableEntity());
        web.perform(change("PUBLISH")).andExpect(status().isUnprocessableEntity());
        web.perform(change("SCHEDULE", "CARD-A")).andExpect(status().isUnprocessableEntity());
        web.perform(schedule("2030-08-03T12:59", "CARD-A")).andExpect(status().isUnprocessableEntity());
        web.perform(schedule("2030-02-30T13:00", "CARD-A")).andExpect(status().isUnprocessableEntity());
        web.perform(schedule("2030-08-03T13:00Z", "CARD-A")).andExpect(status().isUnprocessableEntity());
        assertEquals(List.of(true, false, false), jdbc.queryForList("SELECT active FROM cards ORDER BY id", Boolean.class));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE publish_at IS NOT NULL", Integer.class));
    }

    @Test
    void batchVisibilityChangesClearSchedulesWithoutTouchingInventoryOrPrice() throws Exception {
        var before = jdbc.queryForList("SELECT id,price,stock,inventory_version,inventory_updated FROM cards ORDER BY id");
        web.perform(schedule(SEOUL_MINUTE, "CARD-B", "CARD-A")).andExpect(status().isOk()).andExpect(jsonPath("$.updated").value(2));
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$.length()").value(0));
        web.perform(change("PUBLISH", "CARD-A", "CARD-B")).andExpect(status().isOk()).andExpect(jsonPath("$.updated").value(2));
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$.length()").value(2));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE publish_at IS NOT NULL", Integer.class));
        web.perform(schedule(SEOUL_MINUTE, "CARD-A", "CARD-B")).andExpect(status().isOk());
        web.perform(change("HIDE", "CARD-B", "CARD-A")).andExpect(status().isOk()).andExpect(jsonPath("$.updated").value(2));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM cards WHERE publish_at IS NOT NULL OR active=TRUE", Integer.class));
        assertEquals(before, jdbc.queryForList("SELECT id,price,stock,inventory_version,inventory_updated FROM cards ORDER BY id"));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM stock_movements", Integer.class));
    }

    @Test
    void scheduleGatesCatalogueBinderCartAndOrdersUntilExactSeoulRelease() throws Exception {
        String basket = "{\"items\":[{\"id\":\"CARD-A\",\"quantity\":1}]}";
        String checkout = "{\"items\":[{\"id\":\"CARD-A\",\"quantity\":1}],\"request_key\":\"visibility-test-order\"}";
        web.perform(as(put("/shop-api/binder/CARD-A"), "buyer").content("{\"saved\":true}")).andExpect(status().isOk());
        web.perform(as(put("/shop-api/cart"), "buyer").content(basket)).andExpect(status().isOk());
        web.perform(schedule(SEOUL_MINUTE, "CARD-A")).andExpect(status().isOk());
        assertEquals(RELEASE, jdbc.queryForObject("SELECT publish_at FROM cards WHERE id='CARD-A'", Long.class));
        web.perform(as(get("/shop-api/admin/products"), "admin")).andExpect(jsonPath("$[0].active").value(true))
            .andExpect(jsonPath("$[0].publishAt").value(SEOUL_MINUTE));
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$.length()").value(0));
        web.perform(as(get("/shop-api/binder"), "buyer")).andExpect(jsonPath("$.length()").value(0));
        web.perform(as(get("/shop-api/cart"), "buyer")).andExpect(jsonPath("$.length()").value(0));
        web.perform(as(put("/shop-api/binder/CARD-A"), "buyer").content("{\"saved\":true}")).andExpect(status().isNotFound());
        web.perform(as(put("/shop-api/cart"), "buyer").content(basket.replace("\"quantity\":1", "\"quantity\":2")))
            .andExpect(status().isConflict());
        web.perform(as(post("/shop-api/orders"), "buyer").content(checkout)).andExpect(status().isConflict());
        assertEquals(3, jdbc.queryForObject("SELECT stock FROM cards WHERE id='CARD-A'", Integer.class));

        doReturn(RELEASE).when(shop).now();
        web.perform(as(get("/shop-api/admin/products"), "admin")).andExpect(jsonPath("$[0].publishAt").value(org.hamcrest.Matchers.nullValue()));
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$[0].id").value("CARD-A"));
        web.perform(as(get("/shop-api/binder"), "buyer")).andExpect(jsonPath("$[0]").value("CARD-A"));
        web.perform(as(get("/shop-api/cart"), "buyer")).andExpect(jsonPath("$[0].id").value("CARD-A"));
        var order = web.perform(as(post("/shop-api/orders"), "buyer").content(checkout)).andExpect(status().isCreated()).andReturn();
        String id = json.readTree(order.getResponse().getContentAsString()).get("id").asText();

        web.perform(change("HIDE", "CARD-A")).andExpect(status().isOk());
        web.perform(as(get("/shop-api/orders"), "buyer")).andExpect(jsonPath("$[0].id").value(id));
        web.perform(as(post("/shop-api/orders"), "buyer").content(checkout)).andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").value(id));
        web.perform(as(post("/shop-api/orders/" + id + "/cancel"), "buyer")).andExpect(status().isOk());
        assertEquals(3, jdbc.queryForObject("SELECT stock FROM cards WHERE id='CARD-A'", Integer.class));
    }

    private ObjectNode productEdit() {
        return json.createObjectNode().put("id", "CARD-A").put("name", "새 이름").put("set", "세트")
            .put("game", "원피스 카드게임").put("condition", "NM").put("language", "한국어").put("price", 550);
    }

    @Test
    void editingAProductPreservesScheduleWhileUncheckingClearsIt() throws Exception {
        web.perform(schedule(SEOUL_MINUTE, "CARD-A")).andExpect(status().isOk());
        var product = productEdit().put("active", true);
        web.perform(as(put("/shop-api/admin/products/CARD-A"), "admin").content(product.toString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.publishAt").value(SEOUL_MINUTE));
        web.perform(as(put("/shop-api/admin/products/CARD-A"), "admin").content(product.put("active", false).toString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.active").value(false));
        assertNull(jdbc.queryForObject("SELECT publish_at FROM cards WHERE id='CARD-A'", Long.class));
    }

    @Test
    void metadataOnlyEditPreservesTheLatestVisibility() throws Exception {
        web.perform(schedule(SEOUL_MINUTE, "CARD-A")).andExpect(status().isOk());
        var editor = productEdit();
        web.perform(as(put("/shop-api/admin/products/CARD-A"), "admin").content(editor.toString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.publishAt").value(SEOUL_MINUTE));

        web.perform(change("HIDE", "CARD-A")).andExpect(status().isOk());
        web.perform(as(put("/shop-api/admin/products/CARD-A"), "admin").content(editor.put("price", 600).toString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.active").value(false)).andExpect(jsonPath("$.price").value(600));
        web.perform(as(put("/shop-api/admin/products/CARD-A"), "admin").content(editor.putNull("active").toString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.active").value(false));
        web.perform(get("/shop-api/cards")).andExpect(jsonPath("$.length()").value(0));
        assertNull(jdbc.queryForObject("SELECT publish_at FROM cards WHERE id='CARD-A'", Long.class));
    }
}
